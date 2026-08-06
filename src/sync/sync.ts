import { unwrapObject, wrapObject } from "../storage/envelope.ts";
import type { ObjectMeta, PutCondition, ResultStatus, StorageClient } from "../storage/storage.ts";
import {
  byPath,
  decodeSnapshot,
  encodeSnapshot,
  type FileState,
  type Reader,
  type Snapshot,
  takeSnapshot,
} from "../vault/vault.ts";
import { executeSyncPlan, type LocalWriter, type SyncFailure } from "./execute.ts";
import {
  BLOB_PREFIX,
  decodeSentinel,
  encodeSentinel,
  MANIFEST_KEY,
  manifestAfterSync,
  planSync,
  resolveVaultIdentity,
  SENTINEL_KEY,
  type Sentinel,
  type SyncAction,
} from "./plan.ts";

// SyncOutcome is the result of a single sync pass. On success it carries the new snapshot to
// persist as the next sync's starting point and how many actions were applied; on failure it
// carries a short user facing message and any per file failures for logging. A failure outcome
// still carries a snapshot when the pass made progress worth persisting (#87): completed actions
// are recorded so they are never re-planned, while each failed action's path stays at the
// ancestor's view and is re-planned next pass. snapshot is null when nothing advanced (the
// manifest never uploaded, or never got that far).
export type SyncOutcome =
  | { ok: true; snapshot: Snapshot; changeCount: number }
  | {
      ok: false;
      fault: SyncFault;
      message: string;
      failures: SyncFailure[];
      snapshot: Snapshot | null;
    };

// SyncFault says how a failed pass should be treated by whatever decides when to try another one.
// A message alone cannot answer that, and reading one to guess is how "(404)" ended up being
// sniffed out of error text (#90), so the answer is carried rather than inferred.
//
// "transient" is anything a later attempt could plausibly get past on its own: a dropped
// connection, a provider having a bad minute, a file that was briefly busy. "raced" is losing the
// manifest compare-and-swap to another device, which is not this device failing at all; nothing is
// lost by it, both sides' work survives, and the next pass reconciles them, so it must never count
// towards giving up. "permanent" is everything retrying cannot fix, where trying again every few
// minutes for a week is noise rather than resilience: credentials that are wrong, a bucket
// belonging to a different vault, a manifest written in a format this build cannot read.
export type SyncFault = "transient" | "raced" | "permanent";

// adoptLiveStats returns manifest with each entry swapped for the live vault's entry at the same
// path wherever the content hashes match, so state.json carries local size and mtime and the next
// snapshot can stat-skip the rehash. An entry whose live content differs (a mid sync edit) and a
// live file the manifest doesn't know (a mid sync creation) both keep the manifest's view, so the
// next sync's diff picks them up as local changes. Exported for its tests; syncOnce is the only
// production caller.
export function adoptLiveStats(manifest: Snapshot, live: Snapshot): Snapshot {
  const liveByPath = byPath(live.files);
  const files: FileState[] = [];
  for (const entry of manifest.files) {
    const liveEntry = liveByPath.get(entry.path);
    if (liveEntry !== undefined && liveEntry.hash === entry.hash) {
      files.push(liveEntry);
      continue;
    }
    files.push(entry);
  }

  return { files };
}

// faultFor maps how a storage operation failed onto how the pass carrying it should be treated.
// The two vocabularies stay separate because they answer different questions: ResultStatus says
// what the provider did, SyncFault says whether trying again is worth anything.
//
// A lost precondition is the whole point of the compare-and-swap working, so it is raced rather
// than failed. Auth and client are the provider telling us we are wrong rather than unlucky, and
// no number of retries argues with that. Everything else, including 5xx and 429, is worth another
// go. "ok" and "not_found" never reach here as failures (a 404 on the manifest is a first sync,
// not an error) and fall through to transient, which is the harmless answer if one ever does.
export function faultFor(status: ResultStatus): SyncFault {
  if (status === "conflict") {
    return "raced";
  }
  if (status === "auth" || status === "client") {
    return "permanent";
  }

  return "transient";
}

// readRemoteManifest fetches and parses the remote manifest. A confirmed 404 means no manifest
// has ever been written, the safe assumption for a first sync against an empty bucket, so that's
// treated as an empty snapshot flagged firstSync. Any other failure (network, auth, a real 5xx)
// is reported as an error rather than ever guessed at as "remote is empty" — getting that guess
// wrong would look exactly like every previously known remote file had just been deleted. A
// manifest carrying a format version this build does not know (#91) also refuses the pass:
// syncing against a bucket written in a newer format could mangle it, and the fix is updating
// the plugin, not starting over.
//
// firstSync distinguishes "no manifest has ever been written" from "a manifest exists and is
// genuinely empty": syncOnce must ignore the local ancestor in the former (nothing has ever been
// synced, so state.json cannot be a valid common ancestor) but trust it in the latter (an empty
// remote that a prior sync really produced, where a local file absent from it was deleted).
//
// etag rides along with an existing manifest so syncOnce can make its manifest upload conditional
// on the remote still being exactly this version, the guard against two devices syncing at
// overlapping times (#83).
export async function readRemoteManifest(
  storage: StorageClient,
): Promise<
  | { ok: true; snapshot: Snapshot; firstSync: true }
  | { ok: true; snapshot: Snapshot; firstSync: false; etag: string }
  | { ok: false; fault: SyncFault; message: string }
> {
  const fetched = await storage.getObject(MANIFEST_KEY);

  // Every refusal below this point is permanent: the bytes in the bucket are not something this
  // build can read, and reading them again in two minutes will not change that. What they need is
  // a newer geode, or a human, never a retry.
  if (fetched.ok && fetched.body !== null) {
    // The envelope is read before the JSON inside it, and its two unsupported reasons report the
    // same thing an unknown manifest version does: this bucket was written by a build that knows
    // something this one doesn't, so update rather than start over. That is the whole reason the
    // envelope carries a version and a suite at all (#184): at 0.3.0 the payload here is
    // ciphertext, and a build with no idea how to decrypt it must say so instead of handing bytes
    // to a JSON parser and reporting the vault as corrupt.
    const opened = unwrapObject(fetched.body);
    if (!opened.ok) {
      if (opened.reason === "corrupt") {
        return { ok: false, fault: "permanent", message: "remote manifest is corrupt" };
      }
      return {
        ok: false,
        fault: "permanent",
        message: "remote manifest is a format this version of geode can't read",
      };
    }
    const decoded = decodeSnapshot(new TextDecoder().decode(opened.payload));
    if (!decoded.ok) {
      if (decoded.reason === "unsupportedVersion") {
        return {
          ok: false,
          fault: "permanent",
          message: "remote manifest is a format this version of geode can't read",
        };
      }
      if (decoded.reason === "unsafePath") {
        return {
          ok: false,
          fault: "permanent",
          message: "remote manifest contains a path unsafe to write",
        };
      }
      if (decoded.reason === "caseCollision") {
        return {
          ok: false,
          fault: "permanent",
          message: "remote manifest contains two paths that differ only by case",
        };
      }
      if (decoded.reason === "duplicatePath") {
        return {
          ok: false,
          fault: "permanent",
          message: "remote manifest names the same path twice",
        };
      }
      return { ok: false, fault: "permanent", message: "remote manifest is corrupt" };
    }
    // Every S3 compatible server returns an ETag on a successful read; without one (a stripping
    // proxy, a broken provider) the manifest upload can't be made conditional, and uploading it
    // unconditionally is exactly the concurrent clobber #83 fixed, so refuse rather than sync
    // unsafely.
    if (fetched.etag === null) {
      return { ok: false, fault: "permanent", message: "remote manifest has no etag" };
    }
    return { ok: true, snapshot: decoded.snapshot, firstSync: false, etag: fetched.etag };
  }

  if (fetched.status === "not_found") {
    return { ok: true, snapshot: { files: [] }, firstSync: true };
  }
  return { ok: false, fault: faultFor(fetched.status), message: fetched.message };
}

// readSentinel fetches and parses the remote sentinel (#183). A confirmed 404 is reported as
// `sentinel: null`, the same "definitely absent, not merely unreadable" distinction
// readRemoteManifest already draws for the manifest, since resolveVaultIdentity needs to tell
// "this bucket has never had one" from "something is wrong reading it" apart.
export async function readSentinel(
  storage: StorageClient,
): Promise<
  { ok: true; sentinel: Sentinel | null } | { ok: false; fault: SyncFault; message: string }
> {
  const fetched = await storage.getObject(SENTINEL_KEY);

  if (fetched.ok && fetched.body !== null) {
    const opened = unwrapObject(fetched.body);
    if (!opened.ok) {
      if (opened.reason === "corrupt") {
        return { ok: false, fault: "permanent", message: "remote sentinel is corrupt" };
      }
      return {
        ok: false,
        fault: "permanent",
        message: "remote sentinel is a format this version of geode can't read",
      };
    }
    const decoded = decodeSentinel(new TextDecoder().decode(opened.payload));
    if (!decoded.ok) {
      if (decoded.reason === "unsupportedVersion") {
        return {
          ok: false,
          fault: "permanent",
          message: "remote sentinel is a format this version of geode can't read",
        };
      }
      return { ok: false, fault: "permanent", message: "remote sentinel is corrupt" };
    }
    return { ok: true, sentinel: decoded.sentinel };
  }

  if (fetched.status === "not_found") {
    return { ok: true, sentinel: null };
  }
  return { ok: false, fault: faultFor(fetched.status), message: fetched.message };
}

// revertFailedPaths returns snapshot with every failed action's path restored to the ancestor's
// view of it, so state.json never advances past an action that didn't complete: those paths diff
// against the same ancestor next pass and are re-planned, while every completed path keeps its
// new entry. Reverting is what makes recording progress around a failed pull safe — advancing
// that path to the manifest's entry would make the unchanged local content read as a fresh local
// edit, and the next pass would push it over the newer remote version. Exported for its tests;
// syncOnce is the only production caller.
export function revertFailedPaths(
  snapshot: Snapshot,
  ancestor: Snapshot,
  failed: SyncAction[],
): Snapshot {
  const files = byPath(snapshot.files);
  const ancestorByPath = byPath(ancestor.files);
  for (const action of failed) {
    const entry = ancestorByPath.get(action.path);
    if (entry === undefined) {
      files.delete(action.path);
      continue;
    }
    files.set(action.path, entry);
  }

  return { files: [...files.values()] };
}

// syncOnce runs one full sync pass over the injected local vault (reader/localWriter) and remote
// bucket (storage): it snapshots the local vault against previous (the last synced snapshot),
// reads the remote manifest, plans and executes the reconciliation, then uploads a manifest
// reflecting what the bucket now actually holds, unless it planned nothing and the manifest
// already there already describes exactly that (#102). previous is passed in and the new
// snapshot returned rather than read or written internally, so the caller owns persistence (the
// plugin through state.json, tests through their own store) and this stays pure over its inputs.
// now is injected so a conflict copy's name is deterministic under test. newVaultId mints the
// identifier resolveVaultIdentity attaches to a bucket the first time this pass sees it, injected
// for the same reason: real syncs use crypto.randomUUID(), tests want a fixed value. deviceId names
// this machine in any conflict copy the pass writes (#103).
export async function syncOnce(
  previous: Snapshot,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
  newVaultId: () => string = () => crypto.randomUUID(),
  deviceId = "",
): Promise<SyncOutcome> {
  const [remote, sentinelResult] = await Promise.all([
    readRemoteManifest(storage),
    readSentinel(storage),
  ]);
  if (!remote.ok) {
    return {
      ok: false,
      fault: remote.fault,
      message: remote.message,
      failures: [],
      snapshot: null,
    };
  }
  if (!sentinelResult.ok) {
    return {
      ok: false,
      fault: sentinelResult.fault,
      message: sentinelResult.message,
      failures: [],
      snapshot: null,
    };
  }
  const identity = resolveVaultIdentity(
    remote.firstSync,
    sentinelResult.sentinel,
    previous.vaultId,
    newVaultId,
  );
  if (!identity.ok) {
    return {
      ok: false,
      fault: "permanent",
      message: identity.message,
      failures: [],
      snapshot: null,
    };
  }

  // No remote manifest means no prior sync ever completed against this bucket, so previous (the
  // local state.json) cannot be a valid common ancestor: an upgrader's stale state, written by an
  // older build on every file event rather than only on completed syncs, would diff against the
  // empty remote as "every file deleted remotely" and pullDelete the whole vault. Dropping the
  // ancestor on a first sync reduces it to a clean push of whatever is local, with nothing to lose.
  let ancestor = previous;
  if (remote.firstSync) {
    ancestor = { files: [] };
  }

  const local = await takeSnapshot(reader, ancestor);

  // A missing manifest usually means a fresh bucket, but not always: a lifecycle rule, manual
  // cleanup, or partial restore can remove the manifest while blob objects survive (#109). Unlike
  // the plaintext path keyed layout this replaced, that survival is not automatically a hazard: a
  // blob's key is an address derived from its own content, so a survivor at an address the local
  // vault still resolves to needs no recovery at all, the ordinary push below finds it already
  // there (one HEAD, no re-upload) and the manifest this pass writes describes it correctly. What
  // remains dangerous is a survivor whose hash matches nothing local: unexplained content this
  // device cannot account for, most plausibly a different vault's data that once shared this
  // bucket, or the very race #109 first named.
  //
  // This is reported rather than refused outright. An earlier version blocked the whole pass on
  // any unexplained survivor, but that has no path back to a clean state when the explanation is
  // mundane rather than sinister: an interrupted first sync leaves a blob behind, the local file
  // it belonged to is deleted before the retry, and now nothing local will ever explain it again.
  // Since remote.firstSync only flips to false once a manifest actually lands, a hard refusal here
  // never writes one, so every retry hits the identical refusal forever, a permanent deadlock over
  // an entirely ordinary local edit, worse than the silent stranding #109 fixed. Proceeding lets a
  // real first sync complete and end firstSync state, at the cost that content #109 would have
  // caught explicitly now stays unreferenced instead: still sitting in the bucket, never destroyed,
  // just unreachable through any manifest until someone notices this failure and investigates.
  const remoteView = remote.snapshot;
  const strandedFailures: SyncFailure[] = [];
  if (remote.firstSync) {
    const listed = await storage.listObjects(BLOB_PREFIX);
    if (!listed.ok) {
      return {
        ok: false,
        fault: faultFor(listed.status),
        message: listed.message,
        failures: [],
        snapshot: null,
      };
    }
    for (const key of unexplainedBlobs(listed.objects, local)) {
      strandedFailures.push({ path: key, message: "in the bucket but not in the local vault" });
    }
  }

  // A pull family action re-checks this etag immediately before it writes fetched content locally
  // (execute.ts's manifestDrifted), so a manifest another device replaces mid pass is caught before
  // stale content lands on disk rather than only afterward, when this pass's own manifest upload
  // fails. null on a first sync: there is no manifest yet for a pull to have gone stale against.
  let manifestEtag: string | null = null;
  if (!remote.firstSync) {
    manifestEtag = remote.etag;
  }
  const actions = planSync(ancestor, local, remoteView);
  const executed = await executeSyncPlan(
    actions,
    local,
    reader,
    localWriter,
    storage,
    now,
    remoteView,
    manifestEtag,
    deviceId,
  );

  // The manifest is derived from what the plan just did to the bucket, never from a fresh disk
  // snapshot: a file edited while the plan ran would land in a re-snapshot claiming content the
  // bucket never received, the edit would then never upload (state.json already agrees with the
  // manifest), and another device could later push the stale bucket copy back over it (#84). The
  // re-snapshot here only refreshes stats, so a mid sync edit keeps its bucket entry and reads as
  // a local change on the next pass. completed is only consulted for pushDelete, so a failed
  // delete's path keeps the entry the bucket really holds; every pushed entry is recorded at the
  // hash executed.pushedFiles carries, hashed from the bytes executeSyncPlan actually wrote to the
  // bucket rather than this local snapshot or the owning action's own success, so neither an edit
  // landing between the snapshot and a push's own read nor a conflict's copy succeeding while its
  // restore fails ever leaves the manifest silent about content the bucket really holds. The
  // manifest is uploaded even when some actions failed, so one bad file never leaves the rest of
  // the pass's pushes invisible to every other device (#87).
  const manifest = manifestAfterSync(remoteView, executed.completed, executed.pushedFiles);
  const final = adoptLiveStats(manifest, await takeSnapshot(reader, local));

  // A pass that planned nothing did nothing, so the manifest it would write names exactly the
  // paths, hashes, and blob addresses the one already in the bucket names. Only the per entry size
  // and mtime differ, and no reader of a remote manifest consults either: diffSnapshots compares
  // hashes, and the stat-skip that does read them reads state.json, never the bucket.
  //
  // Writing it anyway is not merely a wasted request (#102). Every manifest upload is a
  // compare-and-swap, so a device with nothing to say is a device that can lose a race it had no
  // reason to enter and report "another device synced at the same time" over a vault nobody
  // touched. Under manual sync that costs one baffling click; under automatic sync (#93) it
  // becomes a recurring error on a vault at rest, which is how a user learns to stop reading the
  // status bar.
  //
  // A first sync uploads even having planned nothing: the manifest existing is what tells every
  // later pass this bucket has been synced before (see resolveVaultIdentity), so an empty vault
  // against an empty bucket must still write one or stay in first sync state forever. The sentinel
  // write below is on its own condition for the same reason, and so still self heals a bucket that
  // lost one, whether or not this pass had anything else to do.
  //
  // state.json is unaffected either way: the snapshot returned below still carries the fresh local
  // stats adoptLiveStats just folded in, so skipping the remote write never costs the next pass
  // its stat-skip.
  if (actions.length > 0 || remote.firstSync) {
    // The upload is conditional on the remote manifest still being exactly what this pass read at
    // the start (or still absent, on a first sync). An unconditional put would last-writer-win
    // against a device syncing at overlapping times, and the loser's pushes would then read as
    // remote deletions on the winner's next sync: files silently deleted (#83). Losing the race
    // fails this pass loudly instead; state.json doesn't advance, and the next sync re-reads the
    // fresh manifest and reconciles both devices' work with nothing lost.
    let condition: PutCondition = { kind: "ifAbsent" };
    if (!remote.firstSync) {
      condition = { kind: "ifMatch", etag: remote.etag };
    }
    const manifestBody = wrapObject(new TextEncoder().encode(encodeSnapshot(final)));
    const uploaded = await storage.putObject(MANIFEST_KEY, manifestBody, condition);
    if (!uploaded.ok) {
      if (uploaded.status === "conflict") {
        return {
          ok: false,
          fault: "raced",
          message: "another device synced at the same time; sync again",
          failures: executed.failures,
          snapshot: null,
        };
      }
      return {
        ok: false,
        fault: faultFor(uploaded.status),
        message: uploaded.message,
        failures: executed.failures,
        snapshot: null,
      };
    }
  }

  // The manifest existing now is what every future pass uses to tell this bucket apart from one
  // nobody has synced (see resolveVaultIdentity), so write the sentinel the moment that becomes
  // true: on a genuine first sync, and on the self heal for one that has a manifest but lost its
  // sentinel along the way. ifAbsent guards two devices racing to bootstrap the same bucket; the
  // loser's pass fails here rather than overwriting a vaultId another device already committed to,
  // and its retry adopts whichever one actually won.
  if (sentinelResult.sentinel === null) {
    const sentinelBody = wrapObject(
      new TextEncoder().encode(encodeSentinel({ vaultId: identity.vaultId, createdAt: now })),
    );
    const sentinelUploaded = await storage.putObject(SENTINEL_KEY, sentinelBody, {
      kind: "ifAbsent",
    });
    if (!sentinelUploaded.ok) {
      return {
        ok: false,
        fault: faultFor(sentinelUploaded.status),
        message: "could not write the vault sentinel; sync again",
        failures: executed.failures,
        snapshot: null,
      };
    }
  }

  // The count comes from failed (one entry per planned path), not failures: a conflict can report
  // two operation failures (copy push and pull) for the same file, and the message counts files.
  // strandedFailures adds to it without adding to failed: there is no action, planned or
  // otherwise, for a path a stranded blob doesn't have, so there is nothing for revertFailedPaths
  // to revert; it is folded in here purely so the pass reports itself failed and names what it
  // could not explain, rather than returning ok on a first sync that left content unreferenced.
  //
  // Transient, because a per file failure is overwhelmingly an I/O error or a mid sync drift, both
  // of which the next pass resolves on its own, and because the rest of the pass succeeded: the
  // manifest went up, so a file that keeps failing costs a retry rather than the whole vault. A
  // stranded blob is the one member of this set retrying cannot fix, but it only ever arises on a
  // first sync, which is never automatic, so nothing is backing off over it either way.
  if (executed.failed.length > 0 || strandedFailures.length > 0) {
    return {
      ok: false,
      fault: "transient",
      message: `${executed.failed.length + strandedFailures.length} file(s) failed to sync`,
      failures: [...executed.failures, ...strandedFailures],
      snapshot: revertFailedPaths(final, ancestor, executed.failed),
    };
  }

  // vaultId is attached only now, after manifestBody was already encoded from final: it belongs on
  // the snapshot this pass hands back for local persistence, never inside the remote manifest.
  return {
    ok: true,
    snapshot: { ...final, vaultId: identity.vaultId },
    changeCount: actions.length,
  };
}

// unexplainedBlobs returns the blob keys a first sync cannot account for: survivors sitting at an
// address no local file resolves to, so nothing this pass is about to do would ever reference
// them. Every other survivor, at an address a local file already carries, needs no special
// handling: the ordinary push below finds it already there and folds it into the manifest for
// free. The comparison is against addresses rather than content hashes because an address is what
// a key is, and the two only coincide while the vault is unencrypted (#184). Exported for its
// tests; syncOnce is the only production caller.
export function unexplainedBlobs(objects: ObjectMeta[], local: Snapshot): string[] {
  const localAddresses = new Set<string>();
  for (const entry of local.files) {
    localAddresses.add(entry.blob);
  }

  const unexplained: string[] = [];
  for (const object of objects) {
    const address = object.key.slice(BLOB_PREFIX.length);
    if (!localAddresses.has(address)) {
      unexplained.push(object.key);
    }
  }

  return unexplained;
}

import type { ObjectMeta, PutCondition, StorageClient } from "../storage/storage.ts";
import {
  byPath,
  decodeSnapshot,
  encodeSnapshot,
  type FileState,
  hashBytes,
  type Reader,
  type Snapshot,
  takeSnapshot,
} from "../vault/vault.ts";
import { executeSyncPlan, type LocalWriter, type SyncFailure } from "./execute.ts";
import {
  MANIFEST_KEY,
  manifestAfterSync,
  planSync,
  RESERVED_PREFIX,
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
      message: string;
      failures: SyncFailure[];
      snapshot: Snapshot | null;
    };

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

// orphanedKeys returns the bucket keys a first sync would strand: objects with no local file at
// their key, which a manifest built purely from local files would never mention, so no device
// would ever pull, list, or delete them again (#109). Keys under the reserved prefix are geode's
// own bookkeeping (the manifest, trashed deletions), never vault files, and are not counted; if
// the manifest appears in the listing (another device's first sync landing mid pass) the
// conditional manifest upload catches it loudly. Exported for its tests; syncOnce is the only
// production caller.
export function orphanedKeys(objects: ObjectMeta[], local: Snapshot): string[] {
  const localByPath = byPath(local.files);
  const orphans: string[] = [];
  for (const object of objects) {
    if (object.key.startsWith(RESERVED_PREFIX)) {
      continue;
    }
    if (!localByPath.has(object.key)) {
      orphans.push(object.key);
    }
  }

  return orphans;
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
  | { ok: false; message: string }
> {
  const fetched = await storage.getObject(MANIFEST_KEY);

  if (fetched.ok && fetched.body !== null) {
    const decoded = decodeSnapshot(new TextDecoder().decode(fetched.body));
    if (!decoded.ok) {
      if (decoded.reason === "unsupportedVersion") {
        return { ok: false, message: "remote manifest needs a newer version of geode" };
      }
      return { ok: false, message: "remote manifest is corrupt" };
    }
    // Every S3 compatible server returns an ETag on a successful read; without one (a stripping
    // proxy, a broken provider) the manifest upload can't be made conditional, and uploading it
    // unconditionally is exactly the concurrent clobber #83 fixed, so refuse rather than sync
    // unsafely.
    if (fetched.etag === null) {
      return { ok: false, message: "remote manifest has no etag" };
    }
    return { ok: true, snapshot: decoded.snapshot, firstSync: false, etag: fetched.etag };
  }

  if (fetched.status === "not_found") {
    return { ok: true, snapshot: { files: [] }, firstSync: true };
  }
  return { ok: false, message: fetched.message };
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
// reflecting what the bucket now actually holds. previous is passed in and the new
// snapshot returned rather than read or written internally, so the caller owns persistence (the
// plugin through state.json, tests through their own store) and this stays pure over its inputs.
// now is injected so a conflict copy's name is deterministic under test.
export async function syncOnce(
  previous: Snapshot,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
): Promise<SyncOutcome> {
  const remote = await readRemoteManifest(storage);
  if (!remote.ok) {
    return { ok: false, message: remote.message, failures: [], snapshot: null };
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
  // cleanup, or partial restore can remove the manifest while file objects survive (#109). The
  // pass below would build a manifest purely from local files, leaving every surviving object
  // invisible: never pulled, never listed, orphaned forever. Refuse loudly instead when the
  // bucket holds objects no local file accounts for.
  //
  // Objects that do match a local path are safe to proceed over, but only once the plan knows
  // what they hold. The empty snapshot a missing manifest implies claims the bucket has nothing
  // at that key, so the path plans as an ifAbsent push the surviving object can only reject; the
  // 412 reads as concurrency and aborts the pass telling the user to sync again, and since
  // nothing about either side changes, every retry reproduces it exactly: a permanent wedge whose
  // error message names the one action that cannot work. Reading those objects instead makes the
  // plan honest, and the ordinary machinery does the rest: identical bytes need no action at all,
  // divergent bytes are a conflict, and neither side's version is lost.
  let remoteView = remote.snapshot;
  if (remote.firstSync) {
    const listed = await storage.listObjects();
    if (!listed.ok) {
      return { ok: false, message: listed.message, failures: [], snapshot: null };
    }
    const orphans = orphanedKeys(listed.objects, local);
    if (orphans.length > 0) {
      const failures: SyncFailure[] = [];
      for (const key of orphans) {
        failures.push({ path: key, message: "in the bucket but not in the local vault" });
      }
      return {
        ok: false,
        message: "bucket has files but no manifest; sync would orphan them",
        failures,
        snapshot: null,
      };
    }
    const survivors = await bucketView(listed.objects, local, storage);
    if (!survivors.ok) {
      return {
        ok: false,
        message: survivors.failure.message,
        failures: [survivors.failure],
        snapshot: null,
      };
    }
    remoteView = survivors.snapshot;
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
  );

  // A failed file precondition means the plan's remote snapshot is no longer current. Do not
  // upload any manifest from that stale view, even if its own CAS has not lost yet: another pass
  // may have uploaded the file object but still be about to upload its manifest.
  if (executed.concurrent) {
    return {
      ok: false,
      message: "another device synced at the same time; sync again",
      failures: executed.failures,
      snapshot: null,
    };
  }

  // The manifest is derived from what the plan just did to the bucket, never from a fresh disk
  // snapshot: a file edited while the plan ran would land in a re-snapshot claiming content the
  // bucket never received, the edit would then never upload (state.json already agrees with the
  // manifest), and another device could later push the stale bucket copy back over it (#84). The
  // re-snapshot here only refreshes stats, so a mid sync edit keeps its bucket entry and reads as
  // a local change on the next pass. Only completed actions feed in, so a failed action's path
  // keeps the entry the bucket really holds; the manifest is uploaded even when some actions
  // failed, so one bad file never leaves the rest of the pass's pushes invisible to every other
  // device (#87).
  const manifest = manifestAfterSync(local, remoteView, executed.completed, now);
  const final = adoptLiveStats(manifest, await takeSnapshot(reader, local));
  const manifestBody = new TextEncoder().encode(encodeSnapshot(final));

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
  const uploaded = await storage.putObject(MANIFEST_KEY, manifestBody, condition);
  if (!uploaded.ok) {
    if (uploaded.status === "conflict") {
      return {
        ok: false,
        message: "another device synced at the same time; sync again",
        failures: executed.failures,
        snapshot: null,
      };
    }
    return {
      ok: false,
      message: uploaded.message,
      failures: executed.failures,
      snapshot: null,
    };
  }

  // The count comes from failed (one entry per planned path), not failures: a conflict can report
  // two operation failures (copy push and pull) for the same file, and the message counts files.
  if (executed.failed.length > 0) {
    return {
      ok: false,
      message: `${executed.failed.length} file(s) failed to sync`,
      failures: executed.failures,
      snapshot: revertFailedPaths(final, ancestor, executed.failed),
    };
  }

  return { ok: true, snapshot: final, changeCount: actions.length };
}

// bucketView returns the remote snapshot a first sync should plan against: what the bucket really
// holds, read from the objects that outlived the manifest, rather than the empty snapshot a missing
// manifest implies. Only keys with a local file at the same path are read; anything else is either
// geode's own bookkeeping or an orphan the caller has already refused over. The objects are fetched
// and hashed because a plan needs content identity, not just a key: an ETag is a provider specific
// opaque string and a listed size cannot tell two same length edits apart. That costs one GET per
// surviving object, on a path only ever taken when a bucket has lost its manifest, and no more than
// the failed conditional PUT plus its verifying GET that the same objects cost before. mtime is 0
// because a remote object has no local mtime to speak of: any entry that survives into the manifest
// therefore misses takeSnapshot's stat check next pass and is rehashed, the safe direction to err
// in, and adoptLiveStats replaces it with the live entry wherever the content already agrees.
async function bucketView(
  objects: ObjectMeta[],
  local: Snapshot,
  storage: StorageClient,
): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; failure: SyncFailure }> {
  const localByPath = byPath(local.files);
  const files: FileState[] = [];

  for (const object of objects) {
    if (object.key.startsWith(RESERVED_PREFIX) || !localByPath.has(object.key)) {
      continue;
    }
    const fetched = await storage.getObject(object.key, object.size);
    if (!fetched.ok || fetched.body === null) {
      // Listed a moment ago and gone now means another device deleted it in between, which is
      // exactly the absence the missing manifest already implied; anything else is a real failure
      // and must not be read as "the bucket holds nothing here", the guess that orphans files.
      if (fetched.status === "not_found") {
        continue;
      }
      return { ok: false, failure: { path: object.key, message: fetched.message } };
    }
    files.push({
      path: object.key,
      size: fetched.body.length,
      mtime: 0,
      hash: await hashBytes(fetched.body),
    });
  }

  return { ok: true, snapshot: { files } };
}

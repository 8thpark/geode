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
import { executeSyncPlan, type LocalWriter, type Progress, type SyncFailure } from "./execute.ts";
import { type MassChange, massChangeApproved, massChangeFor, massChangeHalts } from "./guard.ts";
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

// SyncFault says how a failed pass should be treated by whatever decides when to try again, since
// a message alone can't answer that; see docs/technical_sync.md for what each value means.
export type SyncFault = "transient" | "raced" | "permanent";

// SyncOutcome is the result of a single sync pass: on success the new snapshot to persist, how many
// actions ran, and how many of them moved a local file aside, on failure a message and any per file
// failures, with snapshot carrying progress worth keeping rather than always null.
export type SyncOutcome =
  | { ok: true; snapshot: Snapshot; changeCount: number; conflictCount: number }
  // A blocked pass executed nothing, so it has no progress to persist and nothing to retry: it is
  // waiting on an answer only a person can give. restated marks one asked a second time.
  | {
      ok: false;
      fault: "blocked";
      change: MassChange;
      restated: boolean;
      message: string;
      failures: SyncFailure[];
      snapshot: null;
    }
  | {
      ok: false;
      fault: SyncFault;
      message: string;
      failures: SyncFailure[];
      snapshot: Snapshot | null;
    };

// adoptLiveStats swaps in the live vault's entry for any manifest entry whose hash still matches,
// so state.json carries local size and mtime and the next snapshot can stat skip the rehash.
// Exported for its tests; syncOnce is the only production caller.
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

// faultFor maps how a storage operation failed onto whether the pass carrying it is worth retrying:
// ResultStatus says what the provider did, SyncFault says what to do about it.
export function faultFor(status: ResultStatus): SyncFault {
  if (status === "conflict") {
    return "raced";
  }
  if (status === "auth" || status === "client") {
    return "permanent";
  }

  return "transient";
}

// readRemoteManifest fetches and parses the remote manifest, treating a confirmed 404 as an empty
// snapshot flagged firstSync rather than ever guessing "remote is empty" from any other failure.
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
    // The envelope is read before the JSON inside it: both unsupported reasons mean this bucket
    // was written by a build that knows a format this one doesn't, so the fix is a newer geode,
    // not starting over.
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
    // Every S3 compatible server returns an ETag on a successful read; without one the manifest
    // upload can't be made conditional, so refuse rather than sync unsafely.
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

// readSentinel fetches and parses the remote sentinel, reporting a confirmed 404 as
// `sentinel: null` the same way readRemoteManifest treats an absent manifest, so
// resolveVaultIdentity can tell absence from a read failure.
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
// view, so state.json never advances past an action that didn't complete.
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

// syncOnce runs one full sync pass over the injected local vault and remote bucket, returning the
// new snapshot for the caller to persist rather than reading or writing it internally; now,
// newVaultId, and deviceId are injected so a pass stays deterministic under test.
export async function syncOnce(
  previous: Snapshot,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
  newVaultId: () => string = () => crypto.randomUUID(),
  deviceId = "",
  confirmed: MassChange | null = null,
  onProgress: Progress = () => undefined,
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

  // No remote manifest means no prior sync completed against this bucket, so previous cannot be a
  // valid common ancestor; dropping it here reduces a first sync to a clean push of whatever is
  // local.
  let ancestor = previous;
  if (remote.firstSync) {
    ancestor = { files: [] };
  }

  const local = await takeSnapshot(reader, ancestor);

  // A missing manifest can still leave blob objects behind; a survivor whose hash matches nothing
  // local is reported rather than refused, since refusing here can never self heal.
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

  // A pull action re-checks this etag just before it writes fetched content locally
  // (execute.ts's manifestDrifted), catching a manifest replaced mid pass before stale content
  // lands; null on a first sync, since there is no manifest yet to have gone stale against.
  let manifestEtag: string | null = null;
  if (!remote.firstSync) {
    manifestEtag = remote.etag;
  }
  const actions = planSync(ancestor, local, remoteView);

  // The guard sits between planning and doing, the last point at which refusing costs nothing:
  // one truncated listing or one bad manifest should never quietly gut a vault.
  const change = massChangeFor(actions, local, ancestor.files.length);
  const approved = massChangeApproved(confirmed, change);
  if (massChangeHalts(change) && !approved) {
    // An answer covers the plan it was given, never the next one: a confirmation that no longer
    // describes what this pass would do is asked again rather than spent on it.
    const restated = confirmed !== null;
    let message = `this sync would delete or replace ${change.paths.length} files; confirm it first`;
    if (restated) {
      message = "this sync is no longer the one you confirmed; confirm it again";
    }

    return {
      ok: false,
      fault: "blocked",
      change,
      restated,
      message,
      failures: [],
      snapshot: null,
    };
  }

  // Reported before the first action rather than after it: the plan's size is the answer to "is
  // this hung", and the first action of a big pull can outlast the patience it is spending.
  onProgress(0, actions.length);
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
    onProgress,
  );

  // The manifest is derived from what the plan just did to the bucket, never a fresh disk snapshot,
  // and every pushed entry is recorded at the hash of the bytes executeSyncPlan actually wrote
  // rather than a pre-push hash or the owning action's own success.
  const manifest = manifestAfterSync(remoteView, executed.completed, executed.pushedFiles);
  const final = adoptLiveStats(manifest, await takeSnapshot(reader, local));

  // A pass that planned nothing skips the manifest upload only if the bucket already describes
  // exactly that; a first sync still uploads, since the manifest existing is what tells every later
  // pass this bucket has synced before.
  if (actions.length > 0 || remote.firstSync) {
    // The upload is conditional on the remote manifest still matching what this pass read at the
    // start, so an unconditional put can never silently drop another device's concurrent edits.
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

  // The sentinel is written the moment a manifest first proves this bucket has synced, including
  // the self heal for one that lost its sentinel; ifAbsent lets two racing bootstraps' loser adopt
  // whichever vaultId actually won rather than overwrite it.
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

  // failed, not failures, sets the count: a conflict can report two failures for one file, and
  // strandedFailures folds in as failed content with no action of its own. Transient, since the
  // manifest already went up and a stranded blob only ever arises on a first sync.
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
    conflictCount: conflictsIn(executed.completed),
  };
}

// unexplainedBlobs returns the blob keys a first sync cannot account for: survivors at an address
// no local file resolves to. The comparison is against addresses rather than content hashes,
// since an address is what a storage key actually is.
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

// conflictsIn counts the actions that renamed a local file aside, which is the one thing a
// successful pass does that nobody would find on their own. A conflict whose local side was deleted
// has no local content to preserve, so it restores the remote file and leaves no copy to report.
function conflictsIn(completed: SyncAction[]): number {
  let count = 0;
  for (const action of completed) {
    if (action.kind === "conflict" && action.deletedSide !== "local") {
      count += 1;
    }
  }

  return count;
}

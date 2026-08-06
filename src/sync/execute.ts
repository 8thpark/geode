import { unwrapObject, wrapObject } from "../storage/envelope.ts";
import type { StorageClient } from "../storage/storage.ts";
import {
  byPath,
  type FileStat,
  type FileState,
  hashBytes,
  type Reader,
  type Snapshot,
} from "../vault/vault.ts";
import { blobKeyFor, conflictCopyPath, MANIFEST_KEY, type SyncAction } from "./plan.ts";

// DRIFT_MESSAGE is the failure reported when a local file has changed since the plan's snapshot;
// exported because a refused "create" commit in vault/obsidian.ts reports the same failure from
// the writer's own vacancy check.
export const DRIFT_MESSAGE = "changed locally mid sync; sync again to reconcile";

const BLOB_CORRUPT_MESSAGE = "stored blob is not in geode's object format";
const BLOB_UNREADABLE_MESSAGE = "stored blob is a format this version of geode can't read";
const HASH_MISMATCH_MESSAGE = "fetched bytes do not match manifest hash; sync again to reconcile";
const MANIFEST_DRIFT_MESSAGE = "changed remotely mid sync; sync again to reconcile";
const MANIFEST_MISSING_HASH_MESSAGE = "manifest missing expected hash for this path";

// ExecuteResult reports what executeSyncPlan carried out: completed and failed actions, per file
// failures, and pushedFiles, the FileState of every blob a bucket write actually landed, whether
// or not the action it belonged to ultimately failed.
export type ExecuteResult = {
  completed: SyncAction[];
  failed: SyncAction[];
  failures: SyncFailure[];
  pushedFiles: FileState[];
};

// LocalWriter applies changes decided by a sync to the local vault; the real implementation writes
// through the vault adapter (see vault/obsidian.ts), tests use an in-memory fake.
export type LocalWriter = {
  stageFile: (path: string, data: Uint8Array, mode: WriteMode) => Promise<StagedWrite>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (path: string, newPath: string) => Promise<void>;
};

// StagedWrite is pulled content already written to a staging file beside its destination, waiting
// to either claim that path on commit or be thrown away by discard.
export type StagedWrite = {
  commit: () => Promise<void>;
  discard: () => Promise<void>;
};

// SyncFailure is one action that could not be carried out.
export type SyncFailure = {
  path: string;
  message: string;
};

// WriteMode says what a staged write may do to its destination when it commits: "replace" installs
// over whatever is there, "create" refuses if anything already exists at the path.
export type WriteMode = "replace" | "create";

type ActionResult = {
  failures: SyncFailure[];
  pushed: FileState[];
};

// LocalCheck is the outcome of checkLocalDrift: the failure to report, or the stat the path
// carried at the moment its content was verified, for confirmLocalUnchanged to compare against
// once the remaining checks have run.
type LocalCheck = { ok: true; seen: FileStat } | { ok: false; failure: SyncFailure };

// executeSyncPlan carries out every action against the local vault and the remote bucket, and
// reports what completed and what failed rather than stopping at the first failure; now is passed
// in so a conflict's copy name stays deterministic under test.
export async function executeSyncPlan(
  actions: SyncAction[],
  local: Snapshot,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
  remote: Snapshot = { files: [] },
  manifestEtag: string | null = null,
  deviceId = "",
): Promise<ExecuteResult> {
  const completed: SyncAction[] = [];
  const failed: SyncAction[] = [];
  const failures: SyncFailure[] = [];
  const pushedFiles: FileState[] = [];
  const localByPath = byPath(local.files);
  const remoteByPath = byPath(remote.files);

  for (const action of actions) {
    const actionResult = await executeAction(
      action,
      localByPath,
      remoteByPath,
      reader,
      localWriter,
      storage,
      now,
      manifestEtag,
      deviceId,
    );
    for (const file of actionResult.pushed) {
      pushedFiles.push(file);
    }
    if (actionResult.failures.length === 0) {
      completed.push(action);
      continue;
    }
    failed.push(action);
    for (const failure of actionResult.failures) {
      failures.push(failure);
    }
  }

  return { completed, failed, failures, pushedFiles };
}

// applyLocalWrite converts a thrown I/O error from one localWriter mutation into a SyncFailure, so
// it lands in the same failures array every storage operation already uses.
async function applyLocalWrite(path: string, op: () => Promise<void>): Promise<SyncFailure | null> {
  try {
    await op();
    return null;
  } catch (err) {
    return { path, message: localFailureMessage(err) };
  }
}

// checkLocalDrift returns the failure to report before a destructive local write at path, or the
// stat it saw so confirmLocalUnchanged can compare against it later; only a confirmed absent path,
// or content still matching expected's hash, is safe to write over.
async function checkLocalDrift(
  reader: Reader,
  path: string,
  expected: FileState | undefined,
): Promise<LocalCheck> {
  const before = await reader.stat(path);
  if (!before.present) {
    return { ok: true, seen: before };
  }
  let bytes: Uint8Array;
  try {
    bytes = await reader.readFile(path);
  } catch (err) {
    return { ok: false, failure: { path, message: localFailureMessage(err) } };
  }
  if (expected === undefined) {
    return { ok: false, failure: { path, message: DRIFT_MESSAGE } };
  }
  if ((await hashBytes(bytes)) !== expected.hash) {
    return { ok: false, failure: { path, message: DRIFT_MESSAGE } };
  }

  // Read back after the content, not before it, so the stat handed on describes the file as of the
  // instant these exact bytes were verified rather than as of whenever the read began.
  return { ok: true, seen: await reader.stat(path) };
}

// commitPulledContent lands fetched remote bytes on a local path: the payload is staged first, then
// the drift, manifest, and confirmation checks run cheapest last, so none of them is left standing
// behind another's slow work.
async function commitPulledContent(
  path: string,
  body: Uint8Array,
  mode: WriteMode,
  expected: FileState | undefined,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  manifestEtag: string | null,
): Promise<SyncFailure | null> {
  const staged = await stageForWrite(localWriter, path, body, mode);
  if (!staged.ok) {
    return staged.failure;
  }
  const checked = await checkLocalDrift(reader, path, expected);
  if (!checked.ok) {
    await discardStaged(staged.write);
    return checked.failure;
  }
  if (await manifestDrifted(storage, manifestEtag)) {
    await discardStaged(staged.write);
    return { path, message: MANIFEST_DRIFT_MESSAGE };
  }
  const moved = await confirmLocalUnchanged(reader, path, checked.seen);
  if (moved !== null) {
    await discardStaged(staged.write);
    return moved;
  }
  const failure = await applyLocalWrite(path, () => staged.write.commit());
  if (failure !== null) {
    await discardStaged(staged.write);
    return failure;
  }

  return null;
}

// confirmLocalUnchanged is the last check before a path is written over or deleted, an index only
// stat comparison against the stat checkLocalDrift recorded when it verified the content; it never
// rereads, since the hash already proved those bytes.
async function confirmLocalUnchanged(
  reader: Reader,
  path: string,
  seen: FileStat,
): Promise<SyncFailure | null> {
  const current = await reader.stat(path);
  if (
    current.present !== seen.present ||
    current.size !== seen.size ||
    current.mtime !== seen.mtime
  ) {
    return { path, message: DRIFT_MESSAGE };
  }

  return null;
}

// discardStaged throws away content staged for a write the checks went on to refuse; a failure
// here is swallowed since the caller already returns the reason the write itself was refused, and
// a leftover staging file is reclaimed by the next write to the same deterministic path.
async function discardStaged(staged: StagedWrite): Promise<void> {
  try {
    await staged.discard();
  } catch {
    // Deliberately ignored, see above.
  }
}

// ensureBlobStored makes sure a blob holding bytes exists in the bucket at address's key,
// uploading only when it doesn't; a losing ifAbsent PUT still means another device wrote the same
// content concurrently, so it counts as success rather than a conflict.
async function ensureBlobStored(
  storage: StorageClient,
  address: string,
  bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const key = blobKeyFor(address);
  const head = await storage.headObject(key);
  if (head.ok) {
    return { ok: true };
  }
  if (head.status !== "not_found") {
    return { ok: false, message: head.message };
  }
  const put = await storage.putObject(key, wrapObject(bytes), { kind: "ifAbsent" });
  if (put.ok || put.status === "conflict") {
    return { ok: true };
  }

  return { ok: false, message: put.message };
}

// executeAction carries out a single action and reports its failures, which can be more than one:
// a conflict's restore and its copy push succeed or fail independently, and both belong to the
// same action.
async function executeAction(
  action: SyncAction,
  localByPath: Map<string, FileState>,
  remoteByPath: Map<string, FileState>,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
  manifestEtag: string | null,
  deviceId: string,
): Promise<ActionResult> {
  if (action.kind === "push") {
    let bytes: Uint8Array;
    try {
      bytes = await reader.readFile(action.path);
    } catch (err) {
      return failedAction(action.path, localFailureMessage(err));
    }
    const pushed = await pushedFile(action.path, bytes, now);
    const stored = await ensureBlobStored(storage, pushed.blob, bytes);
    if (!stored.ok) {
      return failedAction(action.path, stored.message);
    }

    return successfulAction([pushed]);
  }

  if (action.kind === "pushDelete") {
    // A deletion is purely a manifest change, so it never touches the bucket and can never fail.
    return successfulAction();
  }

  if (action.kind === "pull") {
    const fetched = await pullBlob(storage, action.path, remoteByPath.get(action.path));
    if (!fetched.ok) {
      return { failures: [fetched.failure], pushed: [] };
    }
    const failure = await commitPulledContent(
      action.path,
      fetched.body,
      "replace",
      localByPath.get(action.path),
      reader,
      localWriter,
      storage,
      manifestEtag,
    );
    if (failure !== null) {
      return { failures: [failure], pushed: [] };
    }

    return successfulAction();
  }

  if (action.kind === "pullDelete") {
    // A pullDelete has no bucket object of its own to check against, so it runs the same
    // cheapest last checks commitPulledContent uses for a write, in the same order and for the
    // same reason.
    const checked = await checkLocalDrift(reader, action.path, localByPath.get(action.path));
    if (!checked.ok) {
      return { failures: [checked.failure], pushed: [] };
    }
    if (await manifestDrifted(storage, manifestEtag)) {
      return { failures: [{ path: action.path, message: MANIFEST_DRIFT_MESSAGE }], pushed: [] };
    }
    const moved = await confirmLocalUnchanged(reader, action.path, checked.seen);
    if (moved !== null) {
      return { failures: [moved], pushed: [] };
    }
    const failure = await applyLocalWrite(action.path, () => localWriter.deleteFile(action.path));
    if (failure !== null) {
      return { failures: [failure], pushed: [] };
    }

    return successfulAction();
  }

  // deletedSide "local": there is no local edit to preserve, so the remote version simply wins and
  // is restored onto the path with mode "create", refusing if something was recreated there since
  // the snapshot.
  if (action.deletedSide === "local") {
    const fetched = await pullBlob(storage, action.path, remoteByPath.get(action.path));
    if (!fetched.ok) {
      return { failures: [fetched.failure], pushed: [] };
    }
    const failure = await commitPulledContent(
      action.path,
      fetched.body,
      "create",
      localByPath.get(action.path),
      reader,
      localWriter,
      storage,
      manifestEtag,
    );
    if (failure !== null) {
      return { failures: [failure], pushed: [] };
    }

    return successfulAction();
  }

  // deletedSide "remote" or "none": preserve the local edit under a new name and push that copy
  // too, so the diverged edit reaches every device and the manifest never claims a copy that
  // doesn't exist in the bucket.
  const copyPath = conflictCopyPath(action.path, now, deviceId);
  let localBytes: Uint8Array;
  try {
    localBytes = await reader.readFile(action.path);
  } catch (err) {
    return failedAction(action.path, localFailureMessage(err));
  }

  // deletedSide "remote" has nothing remote to restore, so the rename is the whole local change and
  // leaving the path empty afterward is success, not a failure to report.
  if (action.deletedSide === "remote") {
    const renameFailure = await applyLocalWrite(action.path, () =>
      localWriter.renameFile(action.path, copyPath),
    );
    if (renameFailure !== null) {
      return { failures: [renameFailure], pushed: [] };
    }

    return pushConflictCopy(storage, copyPath, localBytes, now, []);
  }

  // deletedSide "none": both sides changed, so the local edit moves aside and the remote version
  // takes the path, with everything slow and fallible run first so a failure here leaves the vault
  // exactly as it was.
  const fetched = await pullBlob(storage, action.path, remoteByPath.get(action.path));
  if (!fetched.ok) {
    return { failures: [fetched.failure], pushed: [] };
  }
  const staged = await stageForWrite(localWriter, action.path, fetched.body, "create");
  if (!staged.ok) {
    return { failures: [staged.failure], pushed: [] };
  }
  if (await manifestDrifted(storage, manifestEtag)) {
    await discardStaged(staged.write);
    return { failures: [{ path: action.path, message: MANIFEST_DRIFT_MESSAGE }], pushed: [] };
  }
  const renameFailure = await applyLocalWrite(action.path, () =>
    localWriter.renameFile(action.path, copyPath),
  );
  if (renameFailure !== null) {
    await discardStaged(staged.write);
    return { failures: [renameFailure], pushed: [] };
  }
  // Past the rename the local edit is safely under copyPath, so its blob is pushed whatever the
  // restore then does: a commit refused by a note created in the gap must not also cost the user
  // the edit this conflict set out to preserve.
  const failures: SyncFailure[] = [];
  const commitFailure = await applyLocalWrite(action.path, () => staged.write.commit());
  if (commitFailure !== null) {
    await discardStaged(staged.write);
    failures.push(commitFailure);
  }

  return pushConflictCopy(storage, copyPath, localBytes, now, failures);
}

// failedAction returns one failed action result carrying a single failure.
function failedAction(path: string, message: string): ActionResult {
  return { failures: [{ path, message }], pushed: [] };
}

// localFailureMessage turns whatever a local vault operation threw into a SyncFailure message, so
// a thrown I/O error becomes a per file failure like any storage error rather than an exception
// that abandons the rest of the pass.
function localFailureMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return "local file operation failed";
}

// manifestDrifted reports whether the remote manifest has changed since the pass began, a HEAD
// checked immediately before a pull family write commits, since a blob fetched by its own address
// can never itself notice a newer manifest having moved the path elsewhere.
async function manifestDrifted(storage: StorageClient, etag: string | null): Promise<boolean> {
  if (etag === null) {
    return false;
  }
  const head = await storage.headObject(MANIFEST_KEY);

  return !head.ok || head.etag !== etag;
}

// pullBlob reads the blob a path's expected FileState addresses, unwraps its envelope, and
// verifies the payload against the entry's expected hash, reporting an unreadable envelope as
// needing a newer build rather than damage.
async function pullBlob(
  storage: StorageClient,
  path: string,
  expected: FileState | undefined,
): Promise<{ ok: true; body: Uint8Array } | { ok: false; failure: SyncFailure }> {
  if (expected === undefined) {
    return { ok: false, failure: { path, message: MANIFEST_MISSING_HASH_MESSAGE } };
  }
  const fetched = await storage.getObject(blobKeyFor(expected.blob), expected.size);
  if (!fetched.ok || fetched.body === null) {
    return { ok: false, failure: { path, message: fetched.message } };
  }
  const opened = unwrapObject(fetched.body);
  if (!opened.ok) {
    if (opened.reason === "corrupt") {
      return { ok: false, failure: { path, message: BLOB_CORRUPT_MESSAGE } };
    }
    return { ok: false, failure: { path, message: BLOB_UNREADABLE_MESSAGE } };
  }
  const integrity = await verifyFetch(path, opened.payload, expected);
  if (integrity !== null) {
    return { ok: false, failure: integrity };
  }

  return { ok: true, body: opened.payload };
}

// pushConflictCopy stores the bytes a conflict moved aside and reports the FileState the manifest
// needs to name that copy, appended to whatever failures the caller already collected, since a
// conflict's restore and its copy push can fail independently.
async function pushConflictCopy(
  storage: StorageClient,
  copyPath: string,
  bytes: Uint8Array,
  now: number,
  failures: SyncFailure[],
): Promise<ActionResult> {
  const copyFile = await pushedFile(copyPath, bytes, now);
  const stored = await ensureBlobStored(storage, copyFile.blob, bytes);
  if (!stored.ok) {
    return { failures: [...failures, { path: copyPath, message: stored.message }], pushed: [] };
  }

  return { failures, pushed: [copyFile] };
}

// pushedFile returns the FileState for bytes just written to a blob in the bucket, hashed fresh
// from those exact bytes rather than reused from any earlier snapshot; see FileState in
// vault/vault.ts for why hash and blob are recorded as separate fields.
async function pushedFile(path: string, bytes: Uint8Array, mtime: number): Promise<FileState> {
  const hash = await hashBytes(bytes);

  return { path, size: bytes.length, mtime, hash, blob: hash };
}

// stageForWrite writes fetched bytes to their staging file, converting a thrown I/O error into the
// same SyncFailure shape every other local operation reports; a failure here touches nothing at the
// destination, so there is nothing to unwind.
async function stageForWrite(
  localWriter: LocalWriter,
  path: string,
  body: Uint8Array,
  mode: WriteMode,
): Promise<{ ok: true; write: StagedWrite } | { ok: false; failure: SyncFailure }> {
  try {
    return { ok: true, write: await localWriter.stageFile(path, body, mode) };
  } catch (err) {
    return { ok: false, failure: { path, message: localFailureMessage(err) } };
  }
}

// successfulAction returns the zero failure result for a completed action, pushed carrying the
// FileState of any bytes it wrote to the bucket, empty for an action that pushed nothing.
function successfulAction(pushed: FileState[] = []): ActionResult {
  return { failures: [], pushed };
}

// verifyFetch hashes fetched bytes and compares against the expected hash, closing the gap between
// "storage answered ok" and "storage answered with the right bytes"; writing a mismatch to disk
// would silently propagate damage to every other device on the next sync.
async function verifyFetch(
  path: string,
  body: Uint8Array,
  expected: FileState,
): Promise<SyncFailure | null> {
  if ((await hashBytes(body)) === expected.hash) {
    return null;
  }

  return { path, message: HASH_MISMATCH_MESSAGE };
}

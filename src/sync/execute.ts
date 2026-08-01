import type { StorageClient } from "../storage/storage.ts";
import { byPath, type FileState, hashBytes, type Reader, type Snapshot } from "../vault/vault.ts";
import { blobKeyFor, conflictCopyPath, MANIFEST_KEY, type SyncAction } from "./plan.ts";

// DRIFT_MESSAGE is the failure reported when a local file changed after the snapshot an action
// was planned from; the next sync re-snapshots and replans the path as a conflict.
const DRIFT_MESSAGE = "changed locally mid sync; sync again to reconcile";

const HASH_MISMATCH_MESSAGE = "fetched bytes do not match manifest hash; sync again to reconcile";
const MANIFEST_DRIFT_MESSAGE = "changed remotely mid sync; sync again to reconcile";
const MANIFEST_MISSING_HASH_MESSAGE = "manifest missing expected hash for this path";

// ExecuteResult reports what executeSyncPlan carried out: completed holds every action fully
// applied, failed the actions that weren't, failures the per file detail of why, and pushedFiles
// the FileState of every path a blob now exists under, hashed from those exact bytes. pushedFiles
// is not limited to completed actions: a conflict's copy push can succeed even when the rest of
// that same action later fails, and the copy still needs to reach the manifest. There is no
// concurrency flag: a remote side write is either additive (a blob keyed by its own hash, which a
// losing race still leaves holding the right bytes) or, for pushDelete, touches no bucket object at
// all, so neither can ever discover on its own that the plan's remote view went stale mid pass. The
// pull family (pull, pullDelete, and a conflict's restore) is different: a pull's own fetch reads a
// specific blob by the hash the plan already decided on, which by construction always "succeeds"
// with exactly that content, and pullDelete has no bucket object of its own to check at all, so
// neither can notice on its own that a newer manifest has since pointed the path elsewhere or
// repopulated it; that is what manifestDrifted checks for, immediately before each such local
// delete and, for a write, immediately before the staged commit that actually changes the path
// (see commitPulledContent). The one CAS the plan ultimately depends on either way is the
// manifest's own conditional PUT (sync.ts), the backstop that still catches anything a mid pass
// check's own race window lets through.
export type ExecuteResult = {
  completed: SyncAction[];
  failed: SyncAction[];
  failures: SyncFailure[];
  pushedFiles: FileState[];
};

// LocalWriter applies changes decided by a sync to the local vault. The real implementation
// writes through the vault adapter (see vault/obsidian.ts); tests use an in-memory fake. A pulled
// write is split across stageFile and StagedWrite.commit rather than exposed as one call, so the
// payload reaches disk before the drift checks run and only the commit is left after them.
export type LocalWriter = {
  stageFile: (path: string, data: Uint8Array) => Promise<StagedWrite>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (path: string, newPath: string) => Promise<void>;
};

// StagedWrite is pulled content already written to a staging file beside its destination, waiting
// to either claim that path or be thrown away. Splitting a pull's local write at this seam is what
// makes checkLocalDrift's guarantee real rather than nominal. Writing the payload is the slow part,
// and it used to sit between the drift check and the destination actually changing, so the window
// the check was meant to close still spanned however long the write took: on a large attachment,
// long enough for an edit to land in it and be silently overwritten (#86). Staging first leaves
// only commit's rename in that window.
export type StagedWrite = {
  commit: () => Promise<void>;
  discard: () => Promise<void>;
};

// SyncFailure is one action that could not be carried out.
export type SyncFailure = {
  path: string;
  message: string;
};

type ActionResult = {
  failures: SyncFailure[];
  pushed: FileState[];
};

// executeSyncPlan carries out every action against reader/localWriter (the local vault) and
// storage (the remote bucket), and reports what completed and what couldn't be, so one failed
// file never discards the progress of the rest of the pass (#87). local is the snapshot the plan
// was made from, so each destructive local write can first check the file hasn't changed since
// (#86). now is passed in rather than read internally so a conflict's copy name is deterministic
// under test. remote is the manifest the plan was made from, giving each action the hash its
// path is expected to hold; its empty default suits callers with no remote view. manifestEtag is
// the etag of that same manifest read, checked again immediately before a pull family write so a
// manifest that moved on mid pass is caught before stale content lands on disk (see
// manifestDrifted); null skips the check for callers with no manifest read to compare against.
export async function executeSyncPlan(
  actions: SyncAction[],
  local: Snapshot,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
  remote: Snapshot = { files: [] },
  manifestEtag: string | null = null,
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
    );
    // A conflict's copy push can succeed even when the rest of the action later fails (the pull,
    // its integrity check, or the local write), so pushed is gathered regardless of outcome: it
    // names only bytes actually written to the bucket, never contingent on the action as a whole.
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

// applyLocalWrite runs one localWriter mutation, converting a thrown I/O error into a SyncFailure
// so it lands in the same failures array every storage operation already uses. Returns null when
// the write succeeded.
async function applyLocalWrite(path: string, op: () => Promise<void>): Promise<SyncFailure | null> {
  try {
    await op();
    return null;
  } catch (err) {
    return { path, message: localFailureMessage(err) };
  }
}

// checkLocalDrift returns the failure to report before a destructive local write at path, or null
// when the write is safe. Drift means the file now holds content the local snapshot never saw: an
// edit or creation made in the window between the snapshot and this action running (#86).
// Overwriting or deleting such a file would silently discard that edit, so the caller fails the
// action instead; the next sync re-snapshots, sees both sides changed, and replans the path as a
// conflict, which is where the conflict copy machinery lives. Only a confirmed absent path, or
// content that still hashes to the snapshot's entry, is safe to write over: a file that exists
// but cannot be read is refused with the read's own error, never treated as absent, since
// deleting content that was never verified is the exact hole this check closes. Checking right
// before the destructive write shrinks the unguardable race to the moment between this check and
// the write itself, rather than the whole plan execution.
async function checkLocalDrift(
  reader: Reader,
  path: string,
  expected: FileState | undefined,
): Promise<SyncFailure | null> {
  const exists = await reader.fileExists(path);
  if (!exists) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await reader.readFile(path);
  } catch (err) {
    return { path, message: localFailureMessage(err) };
  }
  if (expected === undefined) {
    return { path, message: DRIFT_MESSAGE };
  }
  if ((await hashBytes(bytes)) !== expected.hash) {
    return { path, message: DRIFT_MESSAGE };
  }

  return null;
}

// commitPulledContent lands fetched remote bytes on a local path, in the only order that leaves
// both drift checks meaningful. The payload is staged first, so by the time either check runs the
// destination is still untouched and all that remains is commit's rename; staging afterwards, as
// this used to, meant the whole payload write sat between the last check and the path changing,
// which on a large attachment is ample room for the edit the check exists to protect.
//
// The two checks are then ordered by what losing each race costs. A manifest that moved on is
// caught again regardless by syncOnce's conditional manifest PUT, so slipping past this check
// costs a spurious conflict copy on the next pass and nothing else. A local edit landing after
// checkLocalDrift has no such backstop: the action reports success, its path advances in
// state.json at the pulled hash, and nothing afterwards can tell the edit ever existed. The
// unrecoverable one therefore goes last, closest to the commit.
//
// checkLocal is injected rather than derived here because a conflict's restore lands on a path its
// own rename just vacated and so has nothing to verify against (see vacatedByRename).
async function commitPulledContent(
  path: string,
  body: Uint8Array,
  checkLocal: () => Promise<SyncFailure | null>,
  localWriter: LocalWriter,
  storage: StorageClient,
  manifestEtag: string | null,
): Promise<SyncFailure | null> {
  const staged = await stageForWrite(localWriter, path, body);
  if (!staged.ok) {
    return staged.failure;
  }
  if (await manifestDrifted(storage, manifestEtag)) {
    await discardStaged(staged.write);
    return { path, message: MANIFEST_DRIFT_MESSAGE };
  }
  const drift = await checkLocal();
  if (drift !== null) {
    await discardStaged(staged.write);
    return drift;
  }
  const failure = await applyLocalWrite(path, () => staged.write.commit());
  if (failure !== null) {
    await discardStaged(staged.write);
    return failure;
  }

  return null;
}

// discardStaged throws away content staged for a write the checks went on to refuse. A discard
// that itself fails is swallowed rather than reported: the caller is already returning the reason
// the write was refused, which is the failure worth surfacing, and a staging path is deterministic,
// so a leftover is reclaimed by the next write to the same path rather than accumulating (see
// hiddenSiblingPath in vault/obsidian.ts).
async function discardStaged(staged: StagedWrite): Promise<void> {
  try {
    await staged.discard();
  } catch {
    // Deliberately ignored, see above.
  }
}

// ensureBlobStored makes sure a blob holding bytes exists in the bucket at hash's key, uploading
// only when it doesn't. The key is derived from the content itself, so an object already there is
// guaranteed byte identical to what the caller would otherwise upload: a rename or a duplicate
// attachment costs one HEAD and nothing more, never a re-upload. A losing ifAbsent PUT still means
// another device wrote this exact content concurrently, so it counts as success rather than the
// concurrency failure an ordinary conditional write would report; the key can only ever hold the
// bytes its own hash names.
async function ensureBlobStored(
  storage: StorageClient,
  hash: string,
  bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const key = blobKeyFor(hash);
  const head = await storage.headObject(key);
  if (head.ok) {
    return { ok: true };
  }
  if (head.status !== "not_found") {
    return { ok: false, message: head.message };
  }
  const put = await storage.putObject(key, bytes, { kind: "ifAbsent" });
  if (put.ok || put.status === "conflict") {
    return { ok: true };
  }

  return { ok: false, message: put.message };
}

// executeAction carries out a single action and reports its failures. An action can report more
// than one failure: a conflict whose copy push fails still pulls the remote version, so the
// diverged local edit lands on disk even when the bucket refuses the copy.
async function executeAction(
  action: SyncAction,
  localByPath: Map<string, FileState>,
  remoteByPath: Map<string, FileState>,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
  manifestEtag: string | null,
): Promise<ActionResult> {
  if (action.kind === "push") {
    let bytes: Uint8Array;
    try {
      bytes = await reader.readFile(action.path);
    } catch (err) {
      return failedAction(action.path, localFailureMessage(err));
    }
    // Hashed fresh from the bytes just read, not reused from a pre-push snapshot, so a file edited
    // in the window between the snapshot and this read is never recorded in the manifest as
    // content the bucket doesn't actually hold.
    const pushed = await pushedFile(action.path, bytes, now);
    const stored = await ensureBlobStored(storage, pushed.hash, bytes);
    if (!stored.ok) {
      return failedAction(action.path, stored.message);
    }

    return successfulAction([pushed]);
  }

  if (action.kind === "pushDelete") {
    // A deletion is purely a manifest change: the path is dropped from what manifestAfterSync
    // builds (see plan.ts), and the blob it pointed at is left exactly where it is, never
    // destroyed, so it stays reachable for as long as any retained manifest still names its hash.
    // Nothing here touches the bucket, so nothing here can fail, and the drift another device
    // might race in underneath (#133) is no longer a hazard: there is no live object at a shared
    // key for that race to clobber. What used to be a trash copy for a recovery window (#53) is
    // now the default: deletion was never destructive to begin with.
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
      () => checkLocalDrift(reader, action.path, localByPath.get(action.path)),
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
    // A deletion is only safe once the manifest is confirmed still current: unlike pull's fetch,
    // which reads a specific blob and so cannot itself observe staleness, a delete has nothing of
    // its own to check against and would otherwise remove a path a newer manifest has since
    // repopulated, based purely on the stale plan.
    if (await manifestDrifted(storage, manifestEtag)) {
      return { failures: [{ path: action.path, message: MANIFEST_DRIFT_MESSAGE }], pushed: [] };
    }
    const drift = await checkLocalDrift(reader, action.path, localByPath.get(action.path));
    if (drift !== null) {
      return { failures: [drift], pushed: [] };
    }
    const failure = await applyLocalWrite(action.path, () => localWriter.deleteFile(action.path));
    if (failure !== null) {
      return { failures: [failure], pushed: [] };
    }

    return successfulAction();
  }

  // conflict, deletedSide "local": the user deleted their copy, so there is no local edit to
  // preserve; the remote edit simply wins and is restored onto the local path. The snapshot has
  // no entry here, so any file found now was recreated after it and must not be overwritten.
  if (action.deletedSide === "local") {
    const fetched = await pullBlob(storage, action.path, remoteByPath.get(action.path));
    if (!fetched.ok) {
      return { failures: [fetched.failure], pushed: [] };
    }
    const failure = await commitPulledContent(
      action.path,
      fetched.body,
      () => checkLocalDrift(reader, action.path, localByPath.get(action.path)),
      localWriter,
      storage,
      manifestEtag,
    );
    if (failure !== null) {
      return { failures: [failure], pushed: [] };
    }

    return successfulAction();
  }

  // conflict, deletedSide "remote" or "none": preserve the local edit under a new name and
  // push that copy to storage too, so the diverged edit lands on every device and the manifest
  // we later upload isn't claiming a remote object that doesn't exist. Neither side's edit is
  // ever silently discarded.
  const copyPath = conflictCopyPath(action.path, now);
  let localBytes: Uint8Array;
  try {
    localBytes = await reader.readFile(action.path);
  } catch (err) {
    return failedAction(action.path, localFailureMessage(err));
  }
  // A failed rename means the local edit is still sitting at action.path untouched. Bail before
  // the pull below would overwrite it, so a diverged edit is never silently discarded by an I/O
  // error the way it would be if we pushed on to restore the remote version.
  const renameFailure = await applyLocalWrite(action.path, () =>
    localWriter.renameFile(action.path, copyPath),
  );
  if (renameFailure !== null) {
    return { failures: [renameFailure], pushed: [] };
  }
  const failures: SyncFailure[] = [];
  const pushedFiles: FileState[] = [];
  const copyFile = await pushedFile(copyPath, localBytes, now);
  const stored = await ensureBlobStored(storage, copyFile.hash, localBytes);
  if (!stored.ok) {
    failures.push({ path: copyPath, message: stored.message });
  } else {
    pushedFiles.push(copyFile);
  }

  // deletedSide "remote": there is nothing at this path remotely to pull, the rename above
  // already vacated it locally, and that is the correct final state, not a failure to report.
  if (action.deletedSide === "remote") {
    return { failures, pushed: pushedFiles };
  }

  const fetched = await pullBlob(storage, action.path, remoteByPath.get(action.path));
  if (!fetched.ok) {
    failures.push(fetched.failure);
    return { failures, pushed: pushedFiles };
  }
  const writeFailure = await commitPulledContent(
    action.path,
    fetched.body,
    vacatedByRename,
    localWriter,
    storage,
    manifestEtag,
  );
  if (writeFailure !== null) {
    failures.push(writeFailure);
  }

  return { failures, pushed: pushedFiles };
}

// failedAction returns one failed action result carrying a single failure.
function failedAction(path: string, message: string): ActionResult {
  return { failures: [{ path, message }], pushed: [] };
}

// localFailureMessage turns whatever a local vault operation threw into a SyncFailure message.
// readFile throws when a file vanishes between the snapshot and now (a user deleting it mid sync),
// and staging, committing, deleting or renaming can throw on a disk full or permission error;
// routing all of them through failures keeps executeSyncPlan's "errors are values" contract, so one
// bad local operation is a per file failure like any storage error, not an exception that abandons
// the rest of the pass.
function localFailureMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return "local file operation failed";
}

// manifestDrifted reports whether the remote manifest has changed since the pass began, checked
// immediately before a pull family write commits fetched content to disk. A blob fetched by its
// own hash always reads back exactly that content, so unlike a plaintext path keyed read this can
// never itself notice a newer manifest having since pointed the path at a different hash; the
// manifest's own etag is the only signal left that the plan's remote view is stale. A HEAD, not a
// full re-fetch, keeps this cheap enough to run before every such write, the same "check right
// before the destructive write" shape checkLocalDrift already uses for the local side. A caller
// with no manifest read to compare against (etag null) skips the check rather than treating a
// missing baseline as drift.
async function manifestDrifted(storage: StorageClient, etag: string | null): Promise<boolean> {
  if (etag === null) {
    return false;
  }
  const head = await storage.headObject(MANIFEST_KEY);

  return !head.ok || head.etag !== etag;
}

// pullBlob reads the blob a path's expected FileState names and verifies it against that expected
// hash before handing it back, so a caller's local write never receives storage's response
// unchecked. expected comes from the remote manifest the plan was made from; missing it means the
// plan itself is inconsistent (every pull carries a manifest entry through syncOnce) and there is
// no key to even attempt a read against.
async function pullBlob(
  storage: StorageClient,
  path: string,
  expected: FileState | undefined,
): Promise<{ ok: true; body: Uint8Array } | { ok: false; failure: SyncFailure }> {
  if (expected === undefined) {
    return { ok: false, failure: { path, message: MANIFEST_MISSING_HASH_MESSAGE } };
  }
  const fetched = await storage.getObject(blobKeyFor(expected.hash), expected.size);
  if (!fetched.ok || fetched.body === null) {
    return { ok: false, failure: { path, message: fetched.message } };
  }
  const integrity = await verifyFetch(path, fetched.body, expected);
  if (integrity !== null) {
    return { ok: false, failure: integrity };
  }

  return { ok: true, body: fetched.body };
}

// pushedFile returns the FileState for bytes just written to a blob in the bucket, hashed fresh
// from those exact bytes.
async function pushedFile(path: string, bytes: Uint8Array, mtime: number): Promise<FileState> {
  return { path, size: bytes.length, mtime, hash: await hashBytes(bytes) };
}

// stageForWrite writes fetched bytes to their staging file, converting a thrown I/O error into the
// same SyncFailure shape every other local operation reports. A failure here has touched nothing at
// the destination, so there is no staged write to hand back and nothing to unwind.
async function stageForWrite(
  localWriter: LocalWriter,
  path: string,
  body: Uint8Array,
): Promise<{ ok: true; write: StagedWrite } | { ok: false; failure: SyncFailure }> {
  try {
    return { ok: true, write: await localWriter.stageFile(path, body) };
  } catch (err) {
    return { ok: false, failure: { path, message: localFailureMessage(err) } };
  }
}

// successfulAction returns the zero failure result for a completed action, pushed carrying the
// FileState of any bytes it wrote to the bucket, empty for an action that pushed nothing.
function successfulAction(pushed: FileState[] = []): ActionResult {
  return { failures: [], pushed };
}

// vacatedByRename is the local check for a conflict's restore, which lands on a path the same
// action renamed away moments earlier. There is no snapshot entry left to verify content against
// and nothing at the path to overwrite, so there is nothing to check. Named rather than inlined as
// a null so the absence of a drift check on this one path reads as a decision rather than an
// oversight.
async function vacatedByRename(): Promise<SyncFailure | null> {
  return null;
}

// verifyFetch hashes fetched bytes and compares against the expected hash, closing the gap
// between "storage answered ok" and "storage answered with the right bytes". A mismatch means the
// response was truncated, corrupted, or (with a hash derived key) essentially impossible short of
// storage corruption; writing it to disk would silently propagate damage to every other device on
// the next sync.
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

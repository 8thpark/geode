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

// DRIFT_MESSAGE is the failure reported when a local file changed after the snapshot an action
// was planned from; the next sync re-snapshots and replans the path as a conflict. Exported
// because a "create" mode commit reports the same thing from inside the writer, where a file that
// appeared at the destination is visible to the adapter alone (see installStaged in
// vault/obsidian.ts), and both are the same event to a user: something changed underneath us.
export const DRIFT_MESSAGE = "changed locally mid sync; sync again to reconcile";

const BLOB_CORRUPT_MESSAGE = "stored blob is not in geode's object format";
const BLOB_UNREADABLE_MESSAGE = "stored blob is a format this version of geode can't read";
const HASH_MISMATCH_MESSAGE = "fetched bytes do not match manifest hash; sync again to reconcile";
const MANIFEST_DRIFT_MESSAGE = "changed remotely mid sync; sync again to reconcile";
const MANIFEST_MISSING_HASH_MESSAGE = "manifest missing expected hash for this path";

// ExecuteResult reports what executeSyncPlan carried out: completed holds every action fully
// applied, failed the actions that weren't, failures the per file detail of why, and pushedFiles
// the FileState of every path a blob now exists under, hashed from those exact bytes. pushedFiles
// is not limited to completed actions: a conflict's copy push can succeed even when the rest of
// that same action later fails, and the copy still needs to reach the manifest. There is no
// concurrency flag: a remote side write is either additive (a blob keyed by its own address,
// which a
// losing race still leaves holding the right bytes) or, for pushDelete, touches no bucket object
// at all, so neither can ever discover on its own that the plan's remote view went stale mid pass.
// The pull family (pull, pullDelete, and a conflict's restore) is different: a pull's own fetch
// reads a specific blob by the address the plan already decided on, which by construction always
// "succeeds"
// with exactly that content, and pullDelete has no bucket object of its own to check at all, so
// neither can notice on its own that a newer manifest has since pointed the path elsewhere or
// repopulated it; that is what manifestDrifted checks for, with nothing left between it and the
// local change but an index lookup (see commitPulledContent for the ordering and why every check
// is arranged cheapest-last). The one CAS the plan ultimately depends on either way is the
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
// payload reaches disk before the drift checks run and only the commit is left after them. The
// write's WriteMode is declared at staging rather than passed to commit, so what the write is
// allowed to do to its destination is stated once, where the write itself is described.
export type LocalWriter = {
  stageFile: (path: string, data: Uint8Array, mode: WriteMode) => Promise<StagedWrite>;
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

// WriteMode says what a staged write may do to its destination when it commits. "replace" installs
// over whatever is there, which is what an ordinary pull wants: the path's old content is exactly
// what the plan decided to move on from. "create" refuses to commit if anything is at the path, for
// a write whose premise is that the path is empty; a conflict's restore lands on a path the same
// action renamed away moments earlier, so a file sitting there now was created in the window since,
// holds content no conflict copy preserved and no snapshot describes, and must not be replaced.
//
// The vacancy is checked by the writer rather than by a caller's drift check because only the
// writer can see the destination as it actually is: a filesystem stat through the adapter, which
// sees a file the instant it appears, where a Reader check goes through Obsidian's file index,
// which lags the very rename this action just made and would refuse sound restores as often as it
// caught real ones. Checking inside the writer also puts the check as close to the rename as the
// adapter allows, a syscall rather than the fetch-and-stage a caller's own checks sit behind.
export type WriteMode = "replace" | "create";

type ActionResult = {
  failures: SyncFailure[];
  pushed: FileState[];
};

// LocalCheck is the outcome of checkLocalDrift: the failure to report, or the stat the path
// carried at the moment its content was verified, for confirmLocalUnchanged to compare against
// once the remaining checks have run.
type LocalCheck = { ok: true; seen: FileStat } | { ok: false; failure: SyncFailure };

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
// deleting content that was never verified is the exact hole this check closes.
//
// A passing check hands back what it saw rather than a bare null, because reading and hashing a
// whole file is far too slow to be the last thing before the write; confirmLocalUnchanged compares
// against this observation once the cheaper checks have run, so the content guarantee reaches all
// the way to the mutation instead of ending wherever this check happened to sit.
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

// commitPulledContent lands fetched remote bytes on a local path, in the only order that leaves
// every check meaningful. The payload is staged first, so by the time any check runs the
// destination is still untouched and all that remains is commit's rename; staging afterwards, as
// this used to, meant the whole payload write sat between the last check and the path changing,
// which on a large attachment is ample room for the edit the checks exist to protect.
//
// The three checks then run cheapest-last, which is the only arrangement that leaves none of them
// standing behind another's slow work. checkLocalDrift is the expensive one: it reads and hashes
// the whole destination, so anything ordered after it inherits that read as its own race window,
// which is exactly what left a manifest replaced mid read able to authorize this write. It
// therefore goes first. manifestDrifted's network round trip follows. Last, with nothing but the
// commit behind it, confirmLocalUnchanged re-checks the destination against the index alone, so
// the local guarantee spans the manifest HEAD as well rather than ending before it. Every check is
// a check-then-act, and the residue of each is now a single index lookup rather than a whole file
// read or a network call.
//
// mode carries the rest of the local guarantee for a write onto a path that is supposed to be
// empty: the commit itself refuses an occupied destination (see WriteMode), which is as close to
// the rename as a check can be placed.
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

// confirmLocalUnchanged is the last look at a path before it is written over or deleted, run after
// the manifest check so nothing but the mutation itself follows it. It compares the path's stat
// against the one checkLocalDrift recorded when it verified the content, and never rereads: the
// hash has already proved those bytes were the snapshot's, and the whole point of this one is to
// be cheap enough to sit last, so the manifest check is not left standing behind a whole file read.
//
// Size alone would not do. A typo fixed in place rewrites a note without changing its length, so
// an mtime comparison is what actually makes this a guard rather than a formality; size is kept
// beside it because a rewrite inside the same clock tick moves one when it cannot move the other.
// This is the same stat pair takeSnapshot gates its rehash on, used here in the conservative
// direction: it can only ever refuse a write, so an mtime that moved without the content moving
// costs one replanned pass, never a wrong answer.
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

// ensureBlobStored makes sure a blob holding bytes exists in the bucket at address's key,
// uploading only when it doesn't. The address is derived from the content itself, so an object
// already there is guaranteed byte identical to what the caller would otherwise upload: a rename or
// a duplicate attachment costs one HEAD and nothing more, never a re-upload. A losing ifAbsent PUT
// still means another device wrote this exact content concurrently, so it counts as success rather
// than the concurrency failure an ordinary conditional write would report; the key can only ever
// hold the bytes its own address names.
//
// The bytes go into the bucket wrapped in an envelope (#184), the same one every geode object
// carries, so the object says what it is before anything tries to read it. The address is derived
// from the payload, never from the wrapped body: what identifies content must not move when the
// framing around it does.
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

// executeAction carries out a single action and reports its failures. An action can report more
// than one failure: once a conflict has moved the local edit aside, its restore and its copy push
// succeed or fail independently, and both outcomes belong to the same action.
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
    // Hashed fresh from the bytes just read, not reused from a pre-push snapshot, so a file edited
    // in the window between the snapshot and this read is never recorded in the manifest as
    // content the bucket doesn't actually hold.
    const pushed = await pushedFile(action.path, bytes, now);
    const stored = await ensureBlobStored(storage, pushed.blob, bytes);
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
    // A deletion is only safe once the manifest is confirmed still current: unlike pull's fetch,
    // which reads a specific blob and so cannot itself observe staleness, a delete has nothing of
    // its own to check against and would otherwise remove a path a newer manifest has since
    // repopulated, based purely on the stale plan. Acting on a manifest that moved on is worse
    // here than for a write, too: the local file goes to trash, this pass's own manifest upload
    // then loses its conditional PUT, and the next pass reads the deletion as the user's own and
    // pushes it, dropping from every device a path another device had just repopulated.
    //
    // The checks are therefore ordered exactly as commitPulledContent orders them, and for the
    // same reason: the expensive content hash first, the manifest HEAD next, and an index-only
    // confirmation last so neither guarantee ends a whole file read or a network round trip
    // before the delete it is guarding.
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

  // conflict, deletedSide "local": the user deleted their copy, so there is no local edit to
  // preserve; the remote edit simply wins and is restored onto the local path. The snapshot has
  // no entry here, so any file found now was recreated after it and must not be overwritten: the
  // drift check catches one the snapshot's Reader can see, and the "create" commit catches one
  // created too recently for that Reader to have indexed yet.
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

  // conflict, deletedSide "remote" or "none": preserve the local edit under a new name and
  // push that copy to storage too, so the diverged edit lands on every device and the manifest
  // we later upload isn't claiming a remote object that doesn't exist. Neither side's edit is
  // ever silently discarded.
  const copyPath = conflictCopyPath(action.path, now, deviceId);
  let localBytes: Uint8Array;
  try {
    localBytes = await reader.readFile(action.path);
  } catch (err) {
    return failedAction(action.path, localFailureMessage(err));
  }

  // deletedSide "remote": there is nothing at this path remotely to restore, so the rename is the
  // whole local change and the path being left empty afterwards is the correct final state, not a
  // failure to report. A failed rename means the local edit is still sitting at action.path
  // untouched, so there is nothing to preserve a copy of and nothing to push.
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
  // takes the path. Everything slow and fallible happens before that path is vacated: the remote
  // version is fetched, verified and staged, and the manifest is confirmed current, all while the
  // local edit still sits untouched under its own name. Only then do the two renames run back to
  // back, which is what makes the "create" commit's guarantee worth having: the window in which
  // the path stands empty, and a note the user or another plugin creates there could be replaced
  // by the restore, is two adjacent local operations rather than a download, a staged write and a
  // network round trip.
  //
  // Failing before the rename also leaves the vault exactly as it was, so an unreachable blob or a
  // manifest that moved on replans the whole conflict next pass rather than leaving it half
  // applied: a copy on disk and an empty path where the user's note used to be, reported as a
  // failure but never recovered from until some later pass happens to pull the path again.
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
// own address always reads back exactly that content, so unlike a plaintext path keyed read this
// can never itself notice a newer manifest having since pointed the path at a different blob; the
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

// pullBlob reads the blob a path's expected FileState addresses, unwraps its envelope, and
// verifies the payload against that entry's expected hash before handing it back, so a caller's
// local write never receives storage's response unchecked. expected comes from the remote manifest
// the plan was made from; missing it means the plan itself is inconsistent (every pull carries a
// manifest entry through syncOnce) and there is no key to even attempt a read against.
//
// The two checks are not redundant. The envelope says whether this build can read the object at
// all, which is what a bucket written by a newer geode answers with; the hash says whether the
// payload inside is the content the manifest promised. An object whose envelope this build cannot
// open is reported as needing a different build rather than as damage, the same posture the
// manifest's own version marker takes, so an upgrade is the obvious fix rather than a restore.
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
// needs to name that copy, appended to whatever failures the caller already collected: a conflict
// can fail its restore and its copy push independently, and both belong in the same result. A
// refused push is reported against the copy's own path, since that is the object the bucket
// refused, and no FileState is returned for it, so the manifest never claims a copy the bucket
// does not hold.
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
// from those exact bytes. Unencrypted, a blob is addressed by its own digest, so the two fields
// hold the same string; see FileState in vault/vault.ts for why they are still recorded separately.
async function pushedFile(path: string, bytes: Uint8Array, mtime: number): Promise<FileState> {
  const hash = await hashBytes(bytes);

  return { path, size: bytes.length, mtime, hash, blob: hash };
}

// stageForWrite writes fetched bytes to their staging file, converting a thrown I/O error into the
// same SyncFailure shape every other local operation reports. A failure here has touched nothing at
// the destination, so there is no staged write to hand back and nothing to unwind.
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

// verifyFetch hashes fetched bytes and compares against the expected hash, closing the gap
// between "storage answered ok" and "storage answered with the right bytes". A mismatch means the
// response was truncated, corrupted, or (with a content derived key) essentially impossible
// short of storage corruption; writing it to disk would silently propagate damage to every other
// device on the next sync.
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

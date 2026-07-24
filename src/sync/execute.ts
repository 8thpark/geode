import type { PutCondition, StorageClient } from "../storage/storage.ts";
import { byPath, type FileState, hashBytes, type Reader, type Snapshot } from "../vault/vault.ts";
import { conflictCopyPath, type SyncAction } from "./plan.ts";

// DRIFT_MESSAGE is the failure reported when a local file changed after the snapshot an action
// was planned from; the next sync re-snapshots and replans the path as a conflict.
const DRIFT_MESSAGE = "changed locally mid sync; sync again to reconcile";

const REMOTE_DRIFT_MESSAGE = "changed remotely mid sync; sync again to reconcile";
const HASH_MISMATCH_MESSAGE = "fetched bytes do not match manifest hash; sync again to reconcile";
const MANIFEST_MISSING_HASH_MESSAGE = "manifest missing expected hash for this path";
const REMOTE_ETAG_MESSAGE = "remote object has no etag";

// ExecuteResult reports what executeSyncPlan carried out: completed holds every action fully
// applied, failed the actions that weren't, failures the per file detail of why, and concurrent
// whether a file precondition proved the remote snapshot stale. failed is carried separately
// from failures because a conflict's failure can name its copy path rather than the action's own
// path.
export type ExecuteResult = {
  completed: SyncAction[];
  concurrent: boolean;
  failed: SyncAction[];
  failures: SyncFailure[];
};

// LocalWriter applies changes decided by a sync to the local vault. The real implementation
// writes through the vault adapter (see vault/obsidian.ts); tests use an in-memory fake.
export type LocalWriter = {
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (path: string, newPath: string) => Promise<void>;
};

// SyncFailure is one action that could not be carried out.
export type SyncFailure = {
  path: string;
  message: string;
};

type ActionResult = {
  concurrent: boolean;
  failures: SyncFailure[];
};

type PutConditionResult =
  | { ok: true; kind: "done" }
  | { ok: true; kind: "put"; condition: PutCondition }
  | { ok: false; concurrent: boolean; failure: SyncFailure };

// executeSyncPlan carries out every action against reader/localWriter (the local vault) and
// storage (the remote bucket), and reports what completed and what couldn't be, so one failed
// file never discards the progress of the rest of the pass (#87). local is the snapshot the plan
// was made from, so each destructive local write can first check the file hasn't changed since
// (#86). now is passed in rather than read internally so a conflict's copy name is deterministic
// under test. remote is the manifest the plan was made from, used to make file PUTs conditional;
// its empty default makes callers that lack a remote view create-only rather than overwrite.
export async function executeSyncPlan(
  actions: SyncAction[],
  local: Snapshot,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
  remote: Snapshot = { files: [] },
): Promise<ExecuteResult> {
  const completed: SyncAction[] = [];
  let concurrent = false;
  const failed: SyncAction[] = [];
  const failures: SyncFailure[] = [];
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
    );
    if (actionResult.failures.length === 0) {
      completed.push(action);
      continue;
    }
    failed.push(action);
    if (actionResult.concurrent) {
      concurrent = true;
    }
    for (const failure of actionResult.failures) {
      failures.push(failure);
    }
    if (actionResult.concurrent) {
      break;
    }
  }

  return { completed, concurrent, failed, failures };
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

// executeAction carries out a single action and reports its failures and whether remote
// concurrency invalidated the plan. An action can report more than one failure: a conflict whose
// copy push fails still pulls the remote version, so the diverged local edit lands on disk even
// when the bucket refuses the copy.
async function executeAction(
  action: SyncAction,
  localByPath: Map<string, FileState>,
  remoteByPath: Map<string, FileState>,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
): Promise<ActionResult> {
  if (action.kind === "push") {
    let bytes: Uint8Array;
    try {
      bytes = await reader.readFile(action.path);
    } catch (err) {
      return failedAction(action.path, localFailureMessage(err), false);
    }
    const checked = await putCondition(action.path, bytes, remoteByPath.get(action.path), storage);
    if (!checked.ok) {
      return { concurrent: checked.concurrent, failures: [checked.failure] };
    }
    if (checked.kind === "done") {
      return successfulAction();
    }
    const result = await storage.putObject(action.path, bytes, checked.condition);
    if (!result.ok) {
      if (result.status !== "conflict") {
        return failedAction(action.path, result.message, false);
      }
      const matches = await remoteMatches(action.path, bytes, storage);
      if (matches) {
        return successfulAction();
      }
      return failedAction(action.path, result.message, true);
    }

    return successfulAction();
  }

  if (action.kind === "pushDelete") {
    const result = await storage.deleteObject(action.path);
    if (!result.ok) {
      return failedAction(action.path, result.message, false);
    }

    return successfulAction();
  }

  if (action.kind === "pull") {
    const drift = await checkLocalDrift(reader, action.path, localByPath.get(action.path));
    if (drift !== null) {
      return { concurrent: false, failures: [drift] };
    }
    const result = await storage.getObject(action.path);
    if (!result.ok || result.body === null) {
      return failedAction(action.path, result.message, false);
    }
    const body = result.body;
    const integrity = await verifyFetch(action.path, body, remoteByPath.get(action.path));
    if (integrity !== null) {
      return { concurrent: false, failures: [integrity] };
    }
    const failure = await applyLocalWrite(action.path, () =>
      localWriter.writeFile(action.path, body),
    );
    if (failure !== null) {
      return { concurrent: false, failures: [failure] };
    }

    return successfulAction();
  }

  if (action.kind === "pullDelete") {
    const drift = await checkLocalDrift(reader, action.path, localByPath.get(action.path));
    if (drift !== null) {
      return { concurrent: false, failures: [drift] };
    }
    const failure = await applyLocalWrite(action.path, () => localWriter.deleteFile(action.path));
    if (failure !== null) {
      return { concurrent: false, failures: [failure] };
    }

    return successfulAction();
  }

  // conflict, deletedSide "local": the user deleted their copy, so there is no local edit to
  // preserve; the remote edit simply wins and is restored onto the local path. The snapshot has
  // no entry here, so any file found now was recreated after it and must not be overwritten.
  if (action.deletedSide === "local") {
    const drift = await checkLocalDrift(reader, action.path, localByPath.get(action.path));
    if (drift !== null) {
      return { concurrent: false, failures: [drift] };
    }
    const result = await storage.getObject(action.path);
    if (!result.ok || result.body === null) {
      return failedAction(action.path, result.message, false);
    }
    const body = result.body;
    const integrity = await verifyFetch(action.path, body, remoteByPath.get(action.path));
    if (integrity !== null) {
      return { concurrent: false, failures: [integrity] };
    }
    const failure = await applyLocalWrite(action.path, () =>
      localWriter.writeFile(action.path, body),
    );
    if (failure !== null) {
      return { concurrent: false, failures: [failure] };
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
    return failedAction(action.path, localFailureMessage(err), false);
  }
  // A failed rename means the local edit is still sitting at action.path untouched. Bail before
  // the pull below would overwrite it, so a diverged edit is never silently discarded by an I/O
  // error the way it would be if we pushed on to restore the remote version.
  const renameFailure = await applyLocalWrite(action.path, () =>
    localWriter.renameFile(action.path, copyPath),
  );
  if (renameFailure !== null) {
    return { concurrent: false, failures: [renameFailure] };
  }
  const failures: SyncFailure[] = [];
  let concurrent = false;
  const pushed = await storage.putObject(copyPath, localBytes, { kind: "ifAbsent" });
  if (!pushed.ok) {
    failures.push({ path: copyPath, message: pushed.message });
    concurrent = pushed.status === "conflict";
  }

  // deletedSide "remote": there is nothing at this path remotely to pull, the rename above
  // already vacated it locally, and that is the correct final state, not a failure to report.
  if (action.deletedSide === "remote") {
    return { concurrent, failures };
  }

  const result = await storage.getObject(action.path);
  if (!result.ok || result.body === null) {
    failures.push({ path: action.path, message: result.message });
    return { concurrent, failures };
  }
  const body = result.body;
  const integrity = await verifyFetch(action.path, body, remoteByPath.get(action.path));
  if (integrity !== null) {
    failures.push(integrity);
    return { concurrent, failures };
  }
  const writeFailure = await applyLocalWrite(action.path, () =>
    localWriter.writeFile(action.path, body),
  );
  if (writeFailure !== null) {
    failures.push(writeFailure);
  }

  return { concurrent, failures };
}

// failedAction returns one failed action result with its concurrency classification.
function failedAction(path: string, message: string, concurrent: boolean): ActionResult {
  return { concurrent, failures: [{ path, message }] };
}

// putCondition returns the precondition that keeps a file PUT tied to the remote snapshot this
// pass planned from. Existing objects are also hashed before their ETag is trusted, because an
// ETag fetched after another pass's PUT describes that newer object rather than the snapshot.
async function putCondition(
  path: string,
  bytes: Uint8Array,
  expected: FileState | undefined,
  storage: StorageClient,
): Promise<PutConditionResult> {
  if (expected === undefined) {
    return { ok: true, kind: "put", condition: { kind: "ifAbsent" } };
  }
  const fetched = await storage.getObject(path);
  if (!fetched.ok || fetched.body === null) {
    if (fetched.status === "not_found") {
      return { ok: true, kind: "put", condition: { kind: "ifAbsent" } };
    }
    return {
      ok: false,
      concurrent: false,
      failure: { path, message: fetched.message },
    };
  }
  const remoteHash = await hashBytes(fetched.body);
  if (remoteHash !== expected.hash) {
    if (remoteHash === (await hashBytes(bytes))) {
      return { ok: true, kind: "done" };
    }
    return {
      ok: false,
      concurrent: true,
      failure: { path, message: REMOTE_DRIFT_MESSAGE },
    };
  }
  if (fetched.etag === null) {
    return {
      ok: false,
      concurrent: false,
      failure: { path, message: REMOTE_ETAG_MESSAGE },
    };
  }

  return { ok: true, kind: "put", condition: { kind: "ifMatch", etag: fetched.etag } };
}

// remoteMatches reports whether path already holds bytes, making a failed create idempotent. A
// previous pass can leave an unmanifested object after losing the manifest CAS; accepting those
// same bytes lets the retry fold it into the manifest without an unsafe overwrite.
async function remoteMatches(
  path: string,
  bytes: Uint8Array,
  storage: StorageClient,
): Promise<boolean> {
  const fetched = await storage.getObject(path);
  if (!fetched.ok || fetched.body === null) {
    return false;
  }

  return (await hashBytes(fetched.body)) === (await hashBytes(bytes));
}

// successfulAction returns the zero failure result for a completed action.
function successfulAction(): ActionResult {
  return { concurrent: false, failures: [] };
}

// localFailureMessage turns whatever a local vault operation threw into a SyncFailure message.
// readFile throws when a file vanishes between the snapshot and now (a user deleting it mid sync),
// and writeFile/deleteFile/renameFile can throw on a disk full or permission error; routing all of
// them through failures keeps executeSyncPlan's "errors are values" contract, so one bad local
// operation is a per file failure like any storage error, not an exception that abandons the rest
// of the pass.
function localFailureMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return "local file operation failed";
}

// verifyFetch hashes fetched bytes and compares against the expected hash from the remote
// snapshot. A mismatch means the storage response was truncated, corrupted, or tampered with;
// writing it to disk would silently propagate damage to every other device on the next sync. A
// missing expected hash is a programming error — the manifest should always carry an entry for a
// path the plan decided to pull — surfaced rather than silently bypassed.
async function verifyFetch(
  path: string,
  body: Uint8Array,
  expected: FileState | undefined,
): Promise<SyncFailure | null> {
  if (expected === undefined) {
    return { path, message: MANIFEST_MISSING_HASH_MESSAGE };
  }
  if ((await hashBytes(body)) === expected.hash) {
    return null;
  }
  return { path, message: HASH_MISMATCH_MESSAGE };
}

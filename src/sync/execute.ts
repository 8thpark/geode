import type { StorageClient } from "../storage/storage.ts";
import { byPath, type FileState, hashBytes, type Reader, type Snapshot } from "../vault/vault.ts";
import { conflictCopyPath, type SyncAction } from "./plan.ts";

// DRIFT_MESSAGE is the failure reported when a local file changed after the snapshot an action
// was planned from; the next sync re-snapshots and replans the path as a conflict.
const DRIFT_MESSAGE = "changed locally mid sync; sync again to reconcile";

// ExecuteResult reports what executeSyncPlan carried out: completed holds every action fully
// applied, failed the actions that weren't, and failures the per file detail of why. failed is
// carried separately from failures because a conflict's failure can name its copy path rather
// than the action's own path.
export type ExecuteResult = {
  completed: SyncAction[];
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

// executeSyncPlan carries out every action against reader/localWriter (the local vault) and
// storage (the remote bucket), and reports what completed and what couldn't be, so one failed
// file never discards the progress of the rest of the pass (#87). local is the snapshot the plan
// was made from, so each destructive local write can first check the file hasn't changed since
// (#86). now is passed in rather than read internally so a conflict's copy name is deterministic
// under test.
export async function executeSyncPlan(
  actions: SyncAction[],
  local: Snapshot,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
): Promise<ExecuteResult> {
  const completed: SyncAction[] = [];
  const failed: SyncAction[] = [];
  const failures: SyncFailure[] = [];
  const localByPath = byPath(local.files);

  for (const action of actions) {
    const actionFailures = await executeAction(
      action,
      localByPath,
      reader,
      localWriter,
      storage,
      now,
    );
    if (actionFailures.length === 0) {
      completed.push(action);
      continue;
    }
    failed.push(action);
    for (const failure of actionFailures) {
      failures.push(failure);
    }
  }

  return { completed, failed, failures };
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

// executeAction carries out a single action and returns every failure it hit, an empty array
// meaning the action fully completed. An action can report more than one failure: a conflict
// whose copy push fails still pulls the remote version, so the diverged local edit lands on disk
// even when the bucket refuses the copy.
async function executeAction(
  action: SyncAction,
  localByPath: Map<string, FileState>,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
): Promise<SyncFailure[]> {
  if (action.kind === "push") {
    let bytes: Uint8Array;
    try {
      bytes = await reader.readFile(action.path);
    } catch (err) {
      return [{ path: action.path, message: localFailureMessage(err) }];
    }
    const result = await storage.putObject(action.path, bytes);
    if (!result.ok) {
      return [{ path: action.path, message: result.message }];
    }

    return [];
  }

  if (action.kind === "pushDelete") {
    const result = await storage.deleteObject(action.path);
    if (!result.ok) {
      return [{ path: action.path, message: result.message }];
    }

    return [];
  }

  if (action.kind === "pull") {
    const drift = await checkLocalDrift(reader, action.path, localByPath.get(action.path));
    if (drift !== null) {
      return [drift];
    }
    const result = await storage.getObject(action.path);
    if (!result.ok || result.body === null) {
      return [{ path: action.path, message: result.message }];
    }
    const body = result.body;
    const failure = await applyLocalWrite(action.path, () =>
      localWriter.writeFile(action.path, body),
    );
    if (failure !== null) {
      return [failure];
    }

    return [];
  }

  if (action.kind === "pullDelete") {
    const drift = await checkLocalDrift(reader, action.path, localByPath.get(action.path));
    if (drift !== null) {
      return [drift];
    }
    const failure = await applyLocalWrite(action.path, () => localWriter.deleteFile(action.path));
    if (failure !== null) {
      return [failure];
    }

    return [];
  }

  // conflict, deletedSide "local": the user deleted their copy, so there is no local edit to
  // preserve; the remote edit simply wins and is restored onto the local path. The snapshot has
  // no entry here, so any file found now was recreated after it and must not be overwritten.
  if (action.deletedSide === "local") {
    const drift = await checkLocalDrift(reader, action.path, localByPath.get(action.path));
    if (drift !== null) {
      return [drift];
    }
    const result = await storage.getObject(action.path);
    if (!result.ok || result.body === null) {
      return [{ path: action.path, message: result.message }];
    }
    const body = result.body;
    const failure = await applyLocalWrite(action.path, () =>
      localWriter.writeFile(action.path, body),
    );
    if (failure !== null) {
      return [failure];
    }

    return [];
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
    return [{ path: action.path, message: localFailureMessage(err) }];
  }
  // A failed rename means the local edit is still sitting at action.path untouched. Bail before
  // the pull below would overwrite it, so a diverged edit is never silently discarded by an I/O
  // error the way it would be if we pushed on to restore the remote version.
  const renameFailure = await applyLocalWrite(action.path, () =>
    localWriter.renameFile(action.path, copyPath),
  );
  if (renameFailure !== null) {
    return [renameFailure];
  }
  const failures: SyncFailure[] = [];
  const pushed = await storage.putObject(copyPath, localBytes);
  if (!pushed.ok) {
    failures.push({ path: copyPath, message: pushed.message });
  }

  // deletedSide "remote": there is nothing at this path remotely to pull, the rename above
  // already vacated it locally, and that is the correct final state, not a failure to report.
  if (action.deletedSide === "remote") {
    return failures;
  }

  const result = await storage.getObject(action.path);
  if (!result.ok || result.body === null) {
    failures.push({ path: action.path, message: result.message });
    return failures;
  }
  const body = result.body;
  const writeFailure = await applyLocalWrite(action.path, () =>
    localWriter.writeFile(action.path, body),
  );
  if (writeFailure !== null) {
    failures.push(writeFailure);
  }

  return failures;
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

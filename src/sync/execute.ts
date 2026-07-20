import type { StorageClient } from "../storage/storage.ts";
import type { Reader } from "../vault/vault.ts";
import { conflictCopyPath, type SyncAction } from "./plan.ts";

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

// executeSyncPlan carries out every action against reader/localWriter (the local vault) and
// storage (the remote bucket), and reports whatever couldn't be completed. now is passed in
// rather than read internally so a conflict's copy name is deterministic under test.
export async function executeSyncPlan(
  actions: SyncAction[],
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
): Promise<SyncFailure[]> {
  const failures: SyncFailure[] = [];

  for (const action of actions) {
    if (action.kind === "push") {
      let bytes: Uint8Array;
      try {
        bytes = await reader.readFile(action.path);
      } catch (err) {
        failures.push({ path: action.path, message: localFailureMessage(err) });
        continue;
      }
      const result = await storage.putObject(action.path, bytes);
      if (!result.ok) {
        failures.push({ path: action.path, message: result.message });
      }
      continue;
    }

    if (action.kind === "pushDelete") {
      const result = await storage.deleteObject(action.path);
      if (!result.ok) {
        failures.push({ path: action.path, message: result.message });
      }
      continue;
    }

    if (action.kind === "pull") {
      const result = await storage.getObject(action.path);
      if (!result.ok || result.body === null) {
        failures.push({ path: action.path, message: result.message });
        continue;
      }
      const body = result.body;
      const failure = await applyLocalWrite(action.path, () =>
        localWriter.writeFile(action.path, body),
      );
      if (failure !== null) {
        failures.push(failure);
      }
      continue;
    }

    if (action.kind === "pullDelete") {
      const failure = await applyLocalWrite(action.path, () => localWriter.deleteFile(action.path));
      if (failure !== null) {
        failures.push(failure);
      }
      continue;
    }

    // conflict, deletedSide "local": the user deleted their copy, so there is no local edit to
    // preserve; the remote edit simply wins and is restored onto the local path.
    if (action.deletedSide === "local") {
      const result = await storage.getObject(action.path);
      if (!result.ok || result.body === null) {
        failures.push({ path: action.path, message: result.message });
        continue;
      }
      const body = result.body;
      const failure = await applyLocalWrite(action.path, () =>
        localWriter.writeFile(action.path, body),
      );
      if (failure !== null) {
        failures.push(failure);
      }
      continue;
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
      failures.push({ path: action.path, message: localFailureMessage(err) });
      continue;
    }
    // A failed rename means the local edit is still sitting at action.path untouched. Bail before
    // the pull below would overwrite it, so a diverged edit is never silently discarded by an I/O
    // error the way it would be if we pushed on to restore the remote version.
    const renameFailure = await applyLocalWrite(action.path, () =>
      localWriter.renameFile(action.path, copyPath),
    );
    if (renameFailure !== null) {
      failures.push(renameFailure);
      continue;
    }
    const pushed = await storage.putObject(copyPath, localBytes);
    if (!pushed.ok) {
      failures.push({ path: copyPath, message: pushed.message });
    }

    // deletedSide "remote": there is nothing at this path remotely to pull, the rename above
    // already vacated it locally, and that is the correct final state, not a failure to report.
    if (action.deletedSide === "remote") {
      continue;
    }

    const result = await storage.getObject(action.path);
    if (!result.ok || result.body === null) {
      failures.push({ path: action.path, message: result.message });
      continue;
    }
    const body = result.body;
    const writeFailure = await applyLocalWrite(action.path, () =>
      localWriter.writeFile(action.path, body),
    );
    if (writeFailure !== null) {
      failures.push(writeFailure);
    }
  }

  return failures;
}

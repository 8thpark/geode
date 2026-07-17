import type { StorageClient } from "./storage.ts";
import {
  byPath,
  type Change,
  diffSnapshots,
  takeSnapshot,
  type VaultReader,
  type VaultSnapshot,
} from "./vault-state.ts";

// MANIFEST_KEY is the well known remote object holding the last synced snapshot, geode's source
// of truth for "what does the other side think exists". Reserved: never treated as a real vault
// path, on either side, even if a vault happens to contain a file at this exact path.
export const MANIFEST_KEY = ".geode/manifest.json";

// LocalWriter applies changes decided by a sync to the local vault. The real implementation
// writes through the vault adapter (see vault-adapter.ts); tests use an in-memory fake.
export type LocalWriter = {
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (path: string, newPath: string) => Promise<void>;
};

// SyncAction is one thing a sync needs to do to bring local and remote back in step. A conflict
// carries deletedSide so executeSyncPlan never has to guess, from a failed read, whether a deleted
// side is why there's nothing there: "local" means there's no local content to preserve, "remote"
// means there's nothing remote to pull, "none" means both sides have real, differing content.
export type SyncAction =
  | { kind: "push"; path: string }
  | { kind: "pushDelete"; path: string }
  | { kind: "pull"; path: string }
  | { kind: "pullDelete"; path: string }
  | { kind: "conflict"; path: string; deletedSide: "local" | "remote" | "none" };

// SyncFailure is one action that could not be carried out.
export type SyncFailure = {
  path: string;
  message: string;
};

// SyncOutcome is the result of a single sync pass. On success it carries the new snapshot to
// persist as the next sync's starting point and how many actions were applied; on failure it
// carries a short user facing message and any per file failures for logging.
export type SyncOutcome =
  | { ok: true; snapshot: VaultSnapshot; changeCount: number }
  | { ok: false; message: string; failures: SyncFailure[] };

// conflictCopyPath returns the name a locally diverged file is renamed to before the remote
// version claims the original path, so neither edit is ever silently discarded. The extension,
// if any, is preserved so the renamed copy still opens in whatever app handles that file type.
export function conflictCopyPath(path: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1 || lastDot < lastSlash) {
    return `${path} (conflicted copy ${stamp})`;
  }
  return `${path.slice(0, lastDot)} (conflicted copy ${stamp})${path.slice(lastDot)}`;
}

// changesByPath builds a lookup from path to change, for matching a local change against a
// remote change at that same path.
function changesByPath(changes: Change[]): Map<string, Change> {
  const result = new Map<string, Change>();
  for (const change of changes) {
    result.set(change.path, change);
  }
  return result;
}

// isReservedPath reports whether path is geode's own bookkeeping, never a real vault file to
// sync, even if something in the vault happens to collide with it.
function isReservedPath(path: string): boolean {
  return path === MANIFEST_KEY;
}

// planSync compares what changed locally since the last successful sync against what changed
// remotely since that same sync, and decides what to push, what to pull, and what's a genuine
// conflict: a path that changed on both sides to different content. previous is the snapshot
// from the end of the last successful sync, the common ancestor both comparisons are made
// against.
export function planSync(
  previous: VaultSnapshot,
  local: VaultSnapshot,
  remote: VaultSnapshot,
): SyncAction[] {
  const localChanges = diffSnapshots(previous, local);
  const remoteChanges = diffSnapshots(previous, remote);
  const remoteByPath = changesByPath(remoteChanges);
  const localByPath = byPath(local.files);
  const remoteFileByPath = byPath(remote.files);

  const actions: SyncAction[] = [];
  const handledPaths = new Set<string>();

  for (const change of localChanges) {
    if (isReservedPath(change.path)) {
      continue;
    }
    handledPaths.add(change.path);
    const remoteChange = remoteByPath.get(change.path);

    if (remoteChange === undefined) {
      if (change.kind === "deleted") {
        actions.push({ kind: "pushDelete", path: change.path });
      } else {
        actions.push({ kind: "push", path: change.path });
      }
      continue;
    }

    // Changed on both sides since the last sync. A delete on either side, or content that
    // ended up different, is a genuine conflict; landing on identical content (both edited
    // to the same bytes, or both deleted it) needs no reconciliation.
    if (change.kind === "deleted" && remoteChange.kind === "deleted") {
      continue;
    }
    if (change.kind === "deleted") {
      actions.push({ kind: "conflict", path: change.path, deletedSide: "local" });
      continue;
    }
    if (remoteChange.kind === "deleted") {
      actions.push({ kind: "conflict", path: change.path, deletedSide: "remote" });
      continue;
    }
    const localFile = localByPath.get(change.path);
    const remoteFile = remoteFileByPath.get(change.path);
    if (localFile !== undefined && remoteFile !== undefined && localFile.hash === remoteFile.hash) {
      continue;
    }
    actions.push({ kind: "conflict", path: change.path, deletedSide: "none" });
  }

  for (const change of remoteChanges) {
    if (isReservedPath(change.path) || handledPaths.has(change.path)) {
      continue;
    }
    if (change.kind === "deleted") {
      actions.push({ kind: "pullDelete", path: change.path });
    } else {
      actions.push({ kind: "pull", path: change.path });
    }
  }

  return actions;
}

// executeSyncPlan carries out every action against reader/localWriter (the local vault) and
// storage (the remote bucket), and reports whatever couldn't be completed. now is passed in
// rather than read internally so a conflict's copy name is deterministic under test.
export async function executeSyncPlan(
  actions: SyncAction[],
  reader: VaultReader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
): Promise<SyncFailure[]> {
  const failures: SyncFailure[] = [];

  for (const action of actions) {
    if (action.kind === "push") {
      const bytes = await reader.readFile(action.path);
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
      await localWriter.writeFile(action.path, result.body);
      continue;
    }

    if (action.kind === "pullDelete") {
      await localWriter.deleteFile(action.path);
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
      await localWriter.writeFile(action.path, result.body);
      continue;
    }

    // conflict, deletedSide "remote" or "none": preserve the local edit under a new name and
    // push that copy to storage too, so the diverged edit lands on every device and the manifest
    // we later upload isn't claiming a remote object that doesn't exist. Neither side's edit is
    // ever silently discarded.
    const copyPath = conflictCopyPath(action.path, now);
    const localBytes = await reader.readFile(action.path);
    await localWriter.renameFile(action.path, copyPath);
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
    await localWriter.writeFile(action.path, result.body);
  }

  return failures;
}

// readRemoteManifest fetches and parses the remote manifest. A confirmed 404 means no manifest
// has ever been written, the safe assumption for a first sync against an empty bucket, so that's
// treated as an empty snapshot. Any other failure (network, auth, a real 5xx) is reported as an
// error rather than ever guessed at as "remote is empty" — getting that guess wrong would look
// exactly like every previously known remote file had just been deleted.
export async function readRemoteManifest(
  storage: StorageClient,
): Promise<{ ok: true; snapshot: VaultSnapshot } | { ok: false; message: string }> {
  const fetched = await storage.getObject(MANIFEST_KEY);

  if (fetched.ok && fetched.body !== null) {
    try {
      const snapshot = JSON.parse(new TextDecoder().decode(fetched.body)) as VaultSnapshot;
      return { ok: true, snapshot };
    } catch {
      return { ok: false, message: "remote manifest is corrupt" };
    }
  }

  // TODO(#41): GetResult conflates 404 with every other failure; swap this for a real status
  // once that's fixed, rather than sniffing the message text for a status code.
  if (fetched.message.includes("(404)")) {
    return { ok: true, snapshot: { files: [] } };
  }
  return { ok: false, message: fetched.message };
}

// syncOnce runs one full sync pass over the injected local vault (reader/localWriter) and remote
// bucket (storage): it snapshots the local vault against previous (the last synced snapshot),
// reads the remote manifest, plans and executes the reconciliation, then re-snapshots and uploads
// the manifest so it always matches what is really on disk. previous is passed in and the new
// snapshot returned rather than read or written internally, so the caller owns persistence (the
// plugin through state.json, tests through their own store) and this stays pure over its inputs.
// now is injected so a conflict copy's name is deterministic under test.
export async function syncOnce(
  previous: VaultSnapshot,
  reader: VaultReader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
): Promise<SyncOutcome> {
  const local = await takeSnapshot(reader, previous);

  const remote = await readRemoteManifest(storage);
  if (!remote.ok) {
    return { ok: false, message: remote.message, failures: [] };
  }

  const actions = planSync(previous, local, remote.snapshot);
  const failures = await executeSyncPlan(actions, reader, localWriter, storage, now);
  if (failures.length > 0) {
    return { ok: false, message: `${failures.length} file(s) failed to sync`, failures };
  }

  // Re-snapshot rather than hand merging local with the plan's outcome: this is the only way to
  // be sure the manifest we upload matches what's really on disk after every pull, delete, and
  // conflict rename just applied.
  const final = await takeSnapshot(reader, local);
  const manifestBody = new TextEncoder().encode(JSON.stringify(final));
  const uploaded = await storage.putObject(MANIFEST_KEY, manifestBody);
  if (!uploaded.ok) {
    return { ok: false, message: uploaded.message, failures: [] };
  }

  return { ok: true, snapshot: final, changeCount: actions.length };
}

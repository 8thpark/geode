import {
  byPath,
  type Change,
  diffSnapshots,
  type FileState,
  type Snapshot,
} from "../vault/vault.ts";

// MANIFEST_KEY is the well known remote object holding the last synced snapshot, geode's source
// of truth for "what does the other side think exists". Reserved: never treated as a real vault
// path, on either side, even if a vault happens to contain a file at this exact path.
export const MANIFEST_KEY = ".geode/manifest.json";

// RESERVED_PREFIX namespaces geode's own bookkeeping in the bucket: the manifest, and the trashed
// copies of deleted objects. Nothing under it is ever a real vault file to sync, list as an
// orphan, or diff, on either side, even if a vault happens to hold a file at a colliding path.
export const RESERVED_PREFIX = ".geode/";

// TRASH_PREFIX is where a pushed deletion parks the object before removing it from its live key,
// giving a mistaken delete a recovery window instead of destroying the bytes outright (#53). It
// sits under RESERVED_PREFIX, so trashed copies never re-enter a sync as vault files.
export const TRASH_PREFIX = ".geode/trash/";

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

// conflictCopyPath returns the name a locally diverged file is renamed to before the remote
// version claims the original path, so neither edit is ever silently discarded. The extension,
// if any, is preserved so the renamed copy still opens in whatever app handles that file type.
export function conflictCopyPath(path: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1 || lastDot <= lastSlash + 1) {
    return `${path} (conflicted copy ${stamp})`;
  }
  return `${path.slice(0, lastDot)} (conflicted copy ${stamp})${path.slice(lastDot)}`;
}

// manifestAfterSync returns the snapshot of what the bucket holds once the pass has run: remote
// as it was read, minus every path a completed pushDelete removed, plus an entry for every
// FileState pushed carries, keyed by the exact bytes executeSyncPlan actually wrote to the bucket
// rather than a pre-push snapshot or an action's own success. A conflict's copy push can succeed
// even when the conflict as a whole later fails to restore the remote version (the pull, its
// integrity check, or the local write can each fail on their own); the copy still landed in the
// bucket, and pushed carries its entry regardless, so leaving it out here would strand that
// object, invisible to every other device, until this same device happened to sync again,
// indefinitely if it never did. completed is only consulted for pushDelete, since a failed
// pushDelete means the live object may still be there and its entry must stand.
export function manifestAfterSync(
  remote: Snapshot,
  completed: SyncAction[],
  pushed: FileState[],
): Snapshot {
  const files = byPath(remote.files);

  for (const action of completed) {
    if (action.kind === "pushDelete") {
      files.delete(action.path);
    }
  }
  for (const entry of pushed) {
    files.set(entry.path, entry);
  }

  return { files: [...files.values()] };
}

// planSync compares what changed locally since the last successful sync against what changed
// remotely since that same sync, and decides what to push, what to pull, and what's a genuine
// conflict: a path that changed on both sides to different content. previous is the snapshot
// from the end of the last successful sync, the common ancestor both comparisons are made
// against.
export function planSync(previous: Snapshot, local: Snapshot, remote: Snapshot): SyncAction[] {
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

// trashKeyFor returns the reserved key a pushed deletion parks path at before removing the live
// object, timestamped so a later delete of a recreated path never overwrites an earlier trashed
// copy. The original path is preserved under the stamped folder, so a recovery can see where the
// object came from. now is passed in rather than read internally so the key is deterministic under
// test, matching conflictCopyPath.
export function trashKeyFor(path: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");

  return `${TRASH_PREFIX}${stamp}/${path}`;
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
  return path.startsWith(RESERVED_PREFIX);
}

import { byPath, type Change, diffSnapshots, type Snapshot } from "../vault/vault.ts";

// MANIFEST_KEY is the well known remote object holding the last synced snapshot, geode's source
// of truth for "what does the other side think exists". Reserved: never treated as a real vault
// path, on either side, even if a vault happens to contain a file at this exact path.
export const MANIFEST_KEY = ".geode/manifest.json";

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

// manifestAfterSync returns the snapshot of what the bucket holds once every action in the plan
// has succeeded: remote as it was read, minus pushed deletions, plus pushed files and conflict
// copies recorded at the local snapshot's entry. It is computed from the plan rather than
// re-snapshotted from disk so the manifest can never record content the bucket does not have
// (#84): a file that changed while the plan ran keeps its bucket entry, and the next sync sees
// the drift as a local change and pushes it. The one race left, a push whose bytes drifted past
// the local snapshot before they were read, only ever understates the bucket, and the next pass
// simply pushes again.
export function manifestAfterSync(
  local: Snapshot,
  remote: Snapshot,
  actions: SyncAction[],
  now: number,
): Snapshot {
  const files = byPath(remote.files);
  const localByPath = byPath(local.files);

  for (const action of actions) {
    // pull and pullDelete only change the local vault; the bucket is untouched.
    if (action.kind === "pull" || action.kind === "pullDelete") {
      continue;
    }
    if (action.kind === "pushDelete") {
      files.delete(action.path);
      continue;
    }
    if (action.kind === "push") {
      // A push is only ever planned for a file present in the local snapshot, so the guard is
      // narrowing, not a real branch; a miss would mean planSync broke that invariant.
      const pushed = localByPath.get(action.path);
      if (pushed !== undefined) {
        files.set(action.path, pushed);
      }
      continue;
    }
    // conflict: a local deletion pushes nothing, the remote entry stands as is. The other two
    // sides push the local edit under its conflict copy name; the original path is already
    // correct in remote (present for deletedSide "none", absent for "remote").
    if (action.deletedSide === "local") {
      continue;
    }
    const copied = localByPath.get(action.path);
    if (copied !== undefined) {
      const copyPath = conflictCopyPath(action.path, now);
      files.set(copyPath, { ...copied, path: copyPath });
    }
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

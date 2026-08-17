import {
  byPath,
  type Change,
  diffSnapshots,
  type FileState,
  SNAPSHOT_VERSION,
  type Snapshot,
} from "../vault/vault.ts";

// BLOB_PREFIX is where every file's content lives, keyed by an address derived from its own bytes
// rather than its vault path, so a rename or a duplicate attachment costs no extra storage.
export const BLOB_PREFIX = ".geode/blobs/";

// MANIFEST_KEY is the well known remote object holding the last synced snapshot.
export const MANIFEST_KEY = ".geode/manifest.json";

// RESERVED_PREFIX namespaces geode's own bookkeeping (the manifest and content addressed blobs),
// so nothing under it is ever synced, diffed, or reported as an orphaned vault file.
export const RESERVED_PREFIX = ".geode/";

// SENTINEL_KEY marks a bucket as having completed its first sync, independent of whether the
// manifest still exists.
export const SENTINEL_KEY = ".geode/sentinel.json";

// DecodedSentinel is the result of parsing a serialized sentinel: the sentinel itself, or why it
// cannot be used.
export type DecodedSentinel =
  | { ok: true; sentinel: Sentinel }
  | { ok: false; reason: "corrupt" | "unsupportedVersion" };

// Sentinel is the durable marker written once at SENTINEL_KEY. vaultId is minted the moment a
// bucket's first sync completes; createdAt is purely informational.
export type Sentinel = {
  vaultId: string;
  createdAt: number;
};

// SyncAction is one thing a sync needs to do to bring local and remote back into step; deletedSide
// lets executeSyncPlan tell a genuine absence from a failed read rather than guessing.
export type SyncAction =
  | { kind: "push"; path: string }
  | { kind: "pushDelete"; path: string }
  | { kind: "pull"; path: string }
  | { kind: "pullDelete"; path: string }
  | { kind: "conflict"; path: string; deletedSide: "local" | "remote" | "none" };

// VaultIdentityCheck is the result of resolveVaultIdentity: either the vaultId to trust and, if
// newly minted or newly adopted, persist locally, or why the pass must refuse rather than guess.
export type VaultIdentityCheck = { ok: true; vaultId: string } | { ok: false; message: string };

// blobKeyFor returns the reserved key content with the given address lives at, the same key
// regardless of which path, or how many paths, currently point at it.
export function blobKeyFor(address: string): string {
  return `${BLOB_PREFIX}${address}`;
}

// conflictCopyPath returns the name a locally diverged file is renamed to before the remote version
// claims the original path, preserving the extension so the copy still opens in the right app.
export function conflictCopyPath(path: string, now: number, deviceId = ""): string {
  const iso = new Date(now).toISOString();
  const date = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const millis = iso.slice(20, 23);
  let marker = `conflict_${date}-${time}-${millis}`;
  if (deviceId !== "") {
    marker = `conflict_${deviceId}_${date}-${time}-${millis}`;
  }
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1 || lastDot <= lastSlash + 1) {
    return `${path}_${marker}`;
  }

  return `${path.slice(0, lastDot)}_${marker}${path.slice(lastDot)}`;
}

// decodeSentinel parses a serialized sentinel and checks its format version, the same posture
// decodeSnapshot takes for the manifest: an unrecognized version means "needs a different build",
// never corrupt.
export function decodeSentinel(raw: string): DecodedSentinel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "corrupt" };
  }
  const obj = parsed as { version?: unknown; vaultId?: unknown; createdAt?: unknown };
  if (obj.version !== SNAPSHOT_VERSION) {
    return { ok: false, reason: "unsupportedVersion" };
  }
  if (typeof obj.vaultId !== "string" || obj.vaultId === "") {
    return { ok: false, reason: "corrupt" };
  }
  if (typeof obj.createdAt !== "number") {
    return { ok: false, reason: "corrupt" };
  }

  return { ok: true, sentinel: { vaultId: obj.vaultId, createdAt: obj.createdAt } };
}

// encodeSentinel serializes a sentinel for persistence, stamping the same format version marker
// every other geode bucket object carries.
export function encodeSentinel(sentinel: Sentinel): string {
  const result: { version: number; vaultId: string; createdAt: number } = {
    version: SNAPSHOT_VERSION,
    vaultId: sentinel.vaultId,
    createdAt: sentinel.createdAt,
  };

  return JSON.stringify(result);
}

// manifestAfterSync returns what the bucket holds once the pass has run, keyed by the bytes pushed
// actually wrote rather than a pre-push snapshot or an action's own success; completed is only
// consulted for pushDelete, since a push's entry must stand even when its own conflict later fails.
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

// planSync compares what changed locally and remotely since previous, the common ancestor, and
// decides what to push, pull, or flag as a genuine conflict; see docs/technical_sync.md.
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

// resolveVaultIdentity decides whether this pass may proceed and which vaultId to trust, by
// comparing what the bucket says (firstSync, sentinel) against what this device already believed
// (localVaultId).
export function resolveVaultIdentity(
  firstSync: boolean,
  sentinel: Sentinel | null,
  localVaultId: string | undefined,
  newVaultId: () => string,
): VaultIdentityCheck {
  if (sentinel !== null) {
    if (localVaultId !== undefined && localVaultId !== sentinel.vaultId) {
      return {
        ok: false,
        message: "this bucket belongs to a different vault than the one last synced here",
      };
    }
    return { ok: true, vaultId: sentinel.vaultId };
  }

  if (!firstSync) {
    if (localVaultId !== undefined) {
      return { ok: true, vaultId: localVaultId };
    }
    return { ok: true, vaultId: newVaultId() };
  }
  if (localVaultId !== undefined) {
    return {
      ok: false,
      message: "the bucket looks empty but this device has synced here before",
    };
  }

  return { ok: true, vaultId: newVaultId() };
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

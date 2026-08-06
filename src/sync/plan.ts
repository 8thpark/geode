import {
  byPath,
  type Change,
  diffSnapshots,
  type FileState,
  SNAPSHOT_VERSION,
  type Snapshot,
} from "../vault/vault.ts";

// BLOB_PREFIX is where every file's content lives, keyed by an address derived from the content
// itself rather than by its vault path: a rename touches no bytes (the manifest's path just points
// at the same key), a duplicate attachment stores once (two paths, one key), and a delete never
// destroys bytes (the manifest simply stops pointing at them; the blob is recoverable for as long
// as any retained manifest, past or present, still names its address). It sits under
// RESERVED_PREFIX, so blobs never re-enter a sync as vault files.
//
// The address is the content's own SHA-256 while the vault is unencrypted, and a keyed hash of the
// content once it isn't (#184), which is why the manifest records it per entry instead of every
// reader deriving it (see FileState in vault/vault.ts).
export const BLOB_PREFIX = ".geode/blobs/";

// MANIFEST_KEY is the well known remote object holding the last synced snapshot, geode's source
// of truth for both "what does the other side think exists" and, since a FileState already pairs
// a path with the address its content lives at, "which blob is which file". Reserved: never treated
// as a real vault path, on either side, even if a vault happens to contain a file at this exact
// path.
export const MANIFEST_KEY = ".geode/manifest.json";

// RESERVED_PREFIX namespaces geode's own bookkeeping in the bucket: the manifest and the content
// addressed blobs. Nothing under it is ever a real vault file to sync, list as an orphan, or
// diff, on either side, even if a vault happens to hold a file at a colliding path.
export const RESERVED_PREFIX = ".geode/";

// SENTINEL_KEY is a small marker written once, on the pass that completes a bucket's very first
// sync, and never rewritten after. Its only job is proving a bucket has been synced before,
// independent of whether MANIFEST_KEY currently exists, so a manifest missing for a bad reason (a
// lifecycle rule, a manual deletion, a typo in a configured prefix) can be told apart from a bucket
// nobody has ever pointed geode at (#183). See resolveVaultIdentity.
export const SENTINEL_KEY = ".geode/sentinel.json";

// DecodedSentinel is the result of parsing a serialized sentinel: the sentinel itself, or why it
// cannot be used.
export type DecodedSentinel =
  | { ok: true; sentinel: Sentinel }
  | { ok: false; reason: "corrupt" | "unsupportedVersion" };

// Sentinel is the durable marker written once at SENTINEL_KEY (#183). vaultId is a random
// identifier minted the moment a bucket's first sync completes; createdAt is purely informational.
export type Sentinel = {
  vaultId: string;
  createdAt: number;
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

// VaultIdentityCheck is the result of resolveVaultIdentity: either the vaultId to trust and, if
// newly minted or newly adopted, persist locally, or why the pass must refuse rather than guess.
export type VaultIdentityCheck = { ok: true; vaultId: string } | { ok: false; message: string };

// blobKeyFor returns the reserved key content with the given address lives at, the same key
// regardless of which path, or how many paths, currently point at it.
export function blobKeyFor(address: string): string {
  return `${BLOB_PREFIX}${address}`;
}

// conflictCopyPath returns the name a locally diverged file is renamed to before the remote
// version claims the original path, so neither edit is ever silently discarded. The extension,
// if any, is preserved so the renamed copy still opens in whatever app handles that file type.
//
// deviceId names the machine the preserved edit came from (#103). A timestamp alone answers "when"
// but not "whose", and on a three device vault "whose" is the question actually being asked. An
// empty deviceId is omitted rather than left as a gap, so a pass running before one has been minted
// still produces a clean name.
//
// The name carries no spaces, and every token it adds is lowercase. Underscore separates fields and
// hyphen lives inside them, so `mac-k3pl7qna` and `20260714-143722` are each exactly one field and
// the suffix stays unambiguous to parse from the right even when the note's own name contains
// underscores. That is what lets a future "unresolved conflicts" view recover the device and the
// time from a filename alone, with no index to keep in step. Lowercase throughout also means two
// devices can never produce paths differing only by case, which decodeSnapshot refuses outright
// (#94), and the absence of spaces keeps the name quotable in a shell and clean in a URL, which the
// CLI and API on the roadmap both eventually want.
//
// The timestamp keeps milliseconds. Two conflicts for one path can only come from two separate
// passes, since a plan carries at most one action per path, but nothing stops a failed pass being
// retried immediately, and automatic sync (#93) makes back to back passes ordinary rather than
// exceptional. At second precision those two would name the same copy, and the second rename would
// overwrite or strand the edit the first one preserved: silent loss, in the one function whose
// entire job is that no edit is ever silently discarded. Milliseconds put a bound on that which no
// realistic pair of network bound passes can cross.
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

// resolveVaultIdentity decides whether this pass may proceed and, if so, which vaultId to trust
// going forward, by comparing what the bucket says (firstSync, sentinel) against what this device
// already believed (localVaultId).
//
// Once a sentinel exists, whether the manifest itself happens to be present or not never changes
// the answer: what matters is only whether localVaultId, if this device has one, agrees with the
// sentinel's. A sentinel without a manifest is the #109 scenario (a manifest deleted, lifecycle
// rule or manual cleanup, while its blobs survive), which syncOnce's own unexplainedBlobs reporting
// already exists to handle; refusing purely because the manifest is briefly missing, even when the
// vaultId agrees or this device has no history to protect, would silently reinstate the exact
// permanent deadlock #109 fixed. A genuine mismatch is refused regardless: this device previously
// synced a different vault and is now pointed somewhere else, whether or not that other vault's
// manifest happens to currently exist.
//
// Only when the sentinel is absent too does firstSync start to matter, because there is then
// nothing to compare localVaultId against:
//
//   - Both missing, and this device has synced somewhere before: refused. Nothing here proves
//     the bucket was ever this device's vault rather than an empty or wrong one (a typo in a
//     configured prefix, wrong bucket, wrong credentials, or a full wipe).
//   - Both missing, and this device has no history: a genuine first sync, minting a fresh vaultId.
//   - The manifest exists but the sentinel does not: benign regardless of history, either an
//     upgrade from before sentinels existed or a crash between the manifest and sentinel writes of
//     an otherwise successful first sync. This self heals: adopt the local vaultId if there is one,
//     mint a fresh one if not, and let the caller write the missing sentinel now.
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

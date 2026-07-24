import { endpointFor, regionFor, type GeodeSettings } from "../settings/settings.ts";

// SNAPSHOT_VERSION is the format version stamped into every serialized snapshot, remote manifest
// and local state.json alike, so a future format change (encryption, chunked upload) has
// something to branch on when it meets an existing bucket (#91). A serialized snapshot with no
// version field predates the marker and is this same format, version 1.
export const SNAPSHOT_VERSION = 1;

// Change describes one path whose state differs between two snapshots.
export type Change = {
  path: string;
  kind: "added" | "modified" | "deleted";
};

// DecodedSnapshot is the result of parsing a serialized snapshot: the snapshot itself, or why it
// cannot be used — bytes that don't parse into the expected shape, or a format version this
// build does not know how to read.
export type DecodedSnapshot =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: "corrupt" | "unsupportedVersion" };

// FileInfo is one file as seen live in the vault, before hashing.
export type FileInfo = {
  path: string;
  size: number;
  mtime: number;
};

// FileState is what geode remembers about one vault file as of the last snapshot.
export type FileState = {
  path: string;
  size: number;
  mtime: number;
  hash: string;
};

// Reader lists files present in the vault right now, reads their bytes, and answers whether a
// path currently exists, so a failed read on a present file is never mistaken for absence. The
// real implementation wraps Obsidian's Vault API (see obsidian.ts); tests use an in-memory fake.
export type Reader = {
  fileExists: (path: string) => Promise<boolean>;
  listFiles: () => Promise<FileInfo[]>;
  readFile: (path: string) => Promise<Uint8Array>;
};

// Snapshot is every file geode saw the last time it took a snapshot.
export type Snapshot = {
  files: FileState[];
  settingsFingerprint?: string;
};

// Store reads and writes the persisted snapshot. The real implementation stores it inside
// the plugin's own data directory (see obsidian.ts); tests use an in-memory fake.
export type Store = {
  read: () => Promise<Snapshot>;
  write: (snapshot: Snapshot) => Promise<void>;
};

// byPath builds a lookup from path to file state, for matching a live file against what the
// previous snapshot last saw at that same path. Exported for sync.ts, which needs the same
// lookup to compare a local snapshot against a remote one.
export function byPath(files: FileState[]): Map<string, FileState> {
  const result = new Map<string, FileState>();
  for (const file of files) {
    result.set(file.path, file);
  }
  return result;
}

// decodeSnapshot parses a serialized snapshot (a remote manifest, a local state.json) and checks
// its format version. A missing version is accepted as version 1, the format every build before
// the marker existed wrote; any other unknown version is refused rather than guessed at, so this
// build never misreads a bucket written in a newer format as garbage or, worse, as valid. The
// version check runs before the shape check on purpose: a future format is free to change the
// shape itself, and its snapshots must still read as "needs a newer build", never as corrupt.
// The returned snapshot carries only the in-memory shape; the version is a wire concern that
// encodeSnapshot stamps back on at the next write.
export function decodeSnapshot(raw: string): DecodedSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "corrupt" };
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== undefined && version !== SNAPSHOT_VERSION) {
    return { ok: false, reason: "unsupportedVersion" };
  }
  if (!isSnapshot(parsed)) {
    return { ok: false, reason: "corrupt" };
  }
  const settingsFingerprint = (parsed as { settingsFingerprint?: unknown }).settingsFingerprint;
  const fingerprintStr = typeof settingsFingerprint === "string" ? settingsFingerprint : undefined;
  const snapshot: Snapshot = { files: parsed.files };
  if (fingerprintStr !== undefined) {
    snapshot.settingsFingerprint = fingerprintStr;
  }

  return { ok: true, snapshot };
}

// diffSnapshots compares two snapshots and reports every path whose content differs.
export function diffSnapshots(previous: Snapshot, current: Snapshot): Change[] {
  const previousByPath = byPath(previous.files);
  const currentByPath = byPath(current.files);
  const changes: Change[] = [];

  for (const file of current.files) {
    const known = previousByPath.get(file.path);
    if (known === undefined) {
      changes.push({ path: file.path, kind: "added" });
      continue;
    }
    if (known.hash !== file.hash) {
      changes.push({ path: file.path, kind: "modified" });
    }
  }

  for (const file of previous.files) {
    if (!currentByPath.has(file.path)) {
      changes.push({ path: file.path, kind: "deleted" });
    }
  }

  return changes;
}

// encodeSnapshot serializes a snapshot for persistence, stamping the format version so every
// manifest and state.json written from here on carries the marker decodeSnapshot branches on.
export function encodeSnapshot(snapshot: Snapshot): string {
  const result: { version: number; files: FileState[]; settingsFingerprint?: string } = {
    version: SNAPSHOT_VERSION,
    files: snapshot.files,
  };
  if (snapshot.settingsFingerprint !== undefined) {
    result.settingsFingerprint = snapshot.settingsFingerprint;
  }

  return JSON.stringify(result);
}

// fingerprintSettings returns a stable string representation of the connection settings,
// so we can detect when the sync target changes and invalidate old state.
export function fingerprintSettings(settings: GeodeSettings): string {
  return JSON.stringify({
    provider: settings.provider,
    accountId: settings.accountId,
    endpoint: endpointFor(settings),
    region: regionFor(settings),
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    secretId: settings.secretId,
  });
}

// hashBytes returns the lowercase hex SHA-256 digest of data.
export async function hashBytes(data: Uint8Array): Promise<string> {
  // Same TS/DOM lib generic mismatch as storage.ts's BodyInit cast: Uint8Array<ArrayBufferLike>
  // vs BufferSource's stricter ArrayBuffer expectation. Not a real runtime issue.
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

// isSnapshot reports whether a value parsed from untrusted JSON (a remote manifest, a local
// state.json) is shaped like a snapshot: a non-null object with a files array. Callers use this
// instead of a blind `as Snapshot` cast, so a body that parses but is the wrong shape becomes
// a handled corrupt/empty case rather than a TypeError when planSync later iterates files. The
// check stops at the array itself: a malformed entry degrades rather than crashes downstream.
export function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === "object" && value !== null && Array.isArray((value as Snapshot).files);
}

// takeSnapshot walks every file the reader currently sees and returns their content hashes. A
// file whose size and mtime both match the previous snapshot reuses that hash instead of
// rereading content — the same stat gated hashing rsync, git, and Syncthing all use, since mtime
// and size alone aren't reliable enough to trust as identity, but are cheap enough to skip a
// rehash when neither has moved. Concurrency is bounded by limit to avoid unbounded memory
// pressure on large vaults.
export async function takeSnapshot(
  reader: Reader,
  previous: Snapshot,
  concurrency = 8,
): Promise<Snapshot> {
  const previousByPath = byPath(previous.files);
  const liveFiles = await reader.listFiles();

  const files = await mapWithConcurrency(liveFiles, concurrency, async (file) => {
    const known = previousByPath.get(file.path);
    if (known !== undefined && known.size === file.size && known.mtime === file.mtime) {
      return known;
    }
    const bytes = await reader.readFile(file.path);
    return {
      path: file.path,
      size: file.size,
      mtime: file.mtime,
      hash: await hashBytes(bytes),
    };
  });

  return { files };
}

// mapWithConcurrency runs fn over each item with at most limit concurrent invocations, preserving
// input order in the returned results.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

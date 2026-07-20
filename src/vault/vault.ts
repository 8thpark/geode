// Change describes one path whose state differs between two snapshots.
export type Change = {
  path: string;
  kind: "added" | "modified" | "deleted";
};

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

// Reader lists files present in the vault right now and reads their bytes. The real
// implementation wraps Obsidian's Vault API (see obsidian.ts); tests use an in-memory fake.
export type Reader = {
  listFiles: () => Promise<FileInfo[]>;
  readFile: (path: string) => Promise<Uint8Array>;
};

// Snapshot is every file geode saw the last time it took a snapshot.
export type Snapshot = {
  files: FileState[];
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

// hashBytes returns the lowercase hex SHA-256 digest of data.
async function hashBytes(data: Uint8Array): Promise<string> {
  // Same TS/DOM lib generic mismatch as storage.ts's BodyInit cast: Uint8Array<ArrayBufferLike>
  // vs BufferSource's stricter ArrayBuffer expectation. Not a real runtime issue.
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
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

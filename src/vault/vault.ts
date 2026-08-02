import { endpointFor, type GeodeSettings, regionFor } from "../settings/settings.ts";

// SNAPSHOT_VERSION is the format version stamped into every serialized snapshot, remote manifest
// and local state.json alike, so a future format change (encryption, chunked upload) has
// something to branch on when it meets an existing bucket (#91). A serialized snapshot with no
// version field predates the marker and is version 1, plaintext path keyed storage. Version 2
// moved file content off the vault path and onto a content addressed key under the manifest's own
// bucket (`.geode/blobs/<hash>`, see sync/plan.ts); a version 1 manifest is refused rather than
// read, since its paths point at objects this build never looks for again, and reading it as
// version 2 would plan every push and pull against keys that were never written. There is no
// migration path at this version: a bucket written before this change needs a fresh bucket, not an
// upgrade.
export const SNAPSHOT_VERSION = 2;

// SNAPSHOT_BYTE_BUDGET caps how many bytes takeSnapshot buffers across its concurrent reads, low
// enough that a vault of large attachments cannot pile eight full files into memory at once and
// breach a mobile memory ceiling mid snapshot. A single file larger than this is still read (it
// has to be, there is no streaming read on the platform), just never alongside another.
const SNAPSHOT_BYTE_BUDGET = 64 * 1024 * 1024;

// WINDOWS_RESERVED_NAMES are device names Windows reserves regardless of extension (`con.txt` is
// still `con`), checked case-insensitively by isSafePath so a manifest entry can never collide
// with one on a machine that syncs there.
const WINDOWS_RESERVED_NAMES = new Set([
  "aux",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "con",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
  "nul",
  "prn",
]);

// Change describes one path whose state differs between two snapshots.
export type Change = {
  path: string;
  kind: "added" | "modified" | "deleted";
};

// DecodedSnapshot is the result of parsing a serialized snapshot: the snapshot itself, or why it
// cannot be used — bytes that don't parse into the expected shape, an entry whose path is unsafe
// to ever write to disk, or a format version this build does not know how to read.
export type DecodedSnapshot =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: "corrupt" | "unsafePath" | "unsupportedVersion" };

// FileInfo is one file as seen live in the vault, before hashing.
export type FileInfo = {
  path: string;
  size: number;
  mtime: number;
};

// FileStat is everything the vault index knows about one path without reading it: whether anything
// is there at all, and the size and mtime it carries if so. An absent path is present false with
// zero values rather than a null to unpack, so callers compare fields instead of branching on
// absence first.
export type FileStat = {
  present: boolean;
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

// Reader lists files present in the vault right now, reads their bytes, and reports what the index
// already knows about a single path without touching its content. stat answers all three of the
// questions sync asks between reads: whether the path is there at all (so a failed read on a
// present file is never mistaken for absence), how big it is right now (fresher than the listing,
// so a snapshot reserves memory against what it is about to read rather than a size that may have
// grown since), and when it last changed (so a pull can confirm nothing moved underneath it
// without rereading the file, see confirmLocalUnchanged in sync/execute.ts). A vanished path
// reports a zero stat, letting the read that follows raise the real disappearance error. The real
// implementation wraps Obsidian's Vault API (see obsidian.ts); tests use an in-memory fake.
export type Reader = {
  listFiles: () => Promise<FileInfo[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  stat: (path: string) => Promise<FileStat>;
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

// Hold is a live byteSemaphore reservation: resize reconciles it to the bytes actually read, since
// a file can grow between listing and read, and release returns them to the budget.
type Hold = {
  release: () => void;
  resize: (bytes: number) => void;
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
// its format version. An explicit version other than SNAPSHOT_VERSION is refused before the shape
// is even looked at: a future format is free to change the shape itself (files as an encrypted
// blob, say), and its snapshots must still read as "needs a different build", never as corrupt.
// A missing version field means version 1, the format every build before the marker existed
// wrote, and shares version 2's JSON shape exactly (`{files: [...]}`), so the two can only be
// told apart by the marker itself; that check runs after the shape check, so a merely malformed
// payload with no version field still reads as corrupt rather than as a well formed old manifest.
// The returned snapshot carries only the in-memory shape; the version is a wire concern that
// encodeSnapshot stamps back on at the next write.
//
// Every entry's path is checked with isSafePath before the snapshot is handed back: both callers
// are untrusted input (a remote manifest can be shaped by anyone who can write to the bucket, and
// state.json flows through this same decoder), and a single unsafe path fails the whole snapshot
// rather than being silently dropped, so nothing downstream ever has to re-check what decode
// already promised (#132).
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
  if (version === undefined) {
    return { ok: false, reason: "unsupportedVersion" };
  }
  for (const file of parsed.files) {
    // isSnapshot only confirms files is an array, not that every entry is shaped like a
    // FileState, so an attacker-controlled manifest can still put a non-object entry (reading
    // .path off null or undefined throws) or a non-string path here despite what the narrowed
    // type above claims.
    if (typeof file !== "object" || file === null || typeof file.path !== "string") {
      return { ok: false, reason: "corrupt" };
    }
    if (!isSafePath(file.path)) {
      return { ok: false, reason: "unsafePath" };
    }
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

// fingerprintSettings returns a stable string identifying the sync target, so we can detect when
// that target changes and invalidate old state (#89). It covers only where the vault lives, the
// fields normalized through endpointFor/regionFor to match what a connection actually uses.
// Credentials (accessKeyId, secretId) are deliberately excluded: they authorize access to a
// target, they do not identify one, so rotating a key must not invalidate state and force a full
// re-hash. A genuine target change always moves one of the fields below.
export function fingerprintSettings(settings: GeodeSettings): string {
  return JSON.stringify({
    provider: settings.provider,
    accountId: settings.accountId,
    endpoint: endpointFor(settings),
    region: regionFor(settings),
    bucket: settings.bucket,
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

// isSafePath reports whether path is safe to write to disk from untrusted input (a remote
// manifest, a local state.json): no traversal or empty segment, no absolute path, no backslash,
// nothing at or under the reserved .geode root (mirrors RESERVED_PREFIX in sync/plan.ts by value;
// vault.ts cannot import it without a layering cycle) or at or under .obsidian (a file written
// there is loadable plugin code), and no segment a filesystem geode runs on could resolve to
// something other than a plain file: a Windows reserved device name, or a segment ending in a dot
// or space, which Windows silently strips on write. The reserved root is matched on its first path
// segment alone, lowercased, rather than the whole path: both macOS (APFS) and Windows (NTFS)
// default to case insensitive filesystems, so ".OBSIDIAN" and ".obsidian" are the same directory on
// disk even though they compare unequal as strings, and a case sensitive check would let a
// differently cased manifest entry plan straight into either reserved root.
export function isSafePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  const root = path.split("/", 1)[0].toLowerCase();
  if (root === ".obsidian" || root === ".geode") {
    return false;
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return false;
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return false;
    }
    if (isWindowsReservedName(segment)) {
      return false;
    }
  }

  return true;
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
// rehash when neither has moved. Reads run at most concurrency at a time and reserve against a
// size read just before each read, so a vault of large attachments serialises rather than piling
// full files into memory at once; a stat gated skip reads nothing and reserves nothing.
//
// The byte bound is not absolute. size and readFile are separate operations, so a file that grows
// in the window between them still allocates its whole buffer past the reservation, and no whole
// file reader can prevent that without a streaming read the mobile platform does not offer. The
// concurrency cap is the hard backstop: at most that many buffers are ever resident at once.
export async function takeSnapshot(
  reader: Reader,
  previous: Snapshot,
  concurrency = 8,
  byteBudget = SNAPSHOT_BYTE_BUDGET,
): Promise<Snapshot> {
  const previousByPath = byPath(previous.files);
  const liveFiles = await reader.listFiles();
  const budget = byteSemaphore(byteBudget);

  const files = await mapWithConcurrency(liveFiles, concurrency, async (file) => {
    const known = previousByPath.get(file.path);
    if (known !== undefined && known.size === file.size && known.mtime === file.mtime) {
      return known;
    }

    // Reserve against the size read now, not the one listed at the start of the pass, so a file
    // that has since grown cannot slip past the budget on a stale, smaller number; resize then
    // corrects for any change in the narrow window between this probe and the read itself. A path
    // that has vanished reserves nothing and lets the read raise the real error.
    const live = await reader.stat(file.path);
    const hold = await budget.acquire(live.size);
    try {
      const bytes = await reader.readFile(file.path);
      hold.resize(bytes.length);

      return {
        path: file.path,
        size: file.size,
        mtime: file.mtime,
        hash: await hashBytes(bytes),
      };
    } finally {
      hold.release();
    }
  });

  return { files };
}

// byteSemaphore caps the bytes held by in-flight readers to budget. acquire reserves the caller's
// size and resolves once it fits, returning a hold whose resize reconciles that reservation to the
// bytes actually read and whose release hands the room back. Waiters are admitted strictly in
// arrival order — a later small read never jumps a queued large one — and a file larger than the
// whole budget is admitted only when nothing else is held, so it runs alone rather than blocking
// forever. The bound holds only as far as the reserved size is honest, which is why takeSnapshot
// reserves against a freshly read size rather than a stale listed one.
function byteSemaphore(budget: number): { acquire: (bytes: number) => Promise<Hold> } {
  let available = budget;
  const waiters: Array<{ need: number; wake: () => void }> = [];

  function admits(need: number): boolean {
    if (need <= available) {
      return true;
    }

    // Nothing else is resident, so an oversized read is let through alone rather than wedged.
    return available === budget;
  }

  function drain(): void {
    while (waiters.length > 0) {
      const next = waiters[0];
      if (!admits(next.need)) {
        return;
      }
      waiters.shift();
      available -= next.need;
      next.wake();
    }
  }

  function hold(reserved: number): Hold {
    let held = reserved;

    return {
      release: (): void => {
        available += held;
        held = 0;
        drain();
      },
      resize: (bytes: number): void => {
        const freed = held - bytes;
        available += freed;
        held = bytes;
        if (freed > 0) {
          drain();
        }
      },
    };
  }

  return {
    acquire: (bytes: number): Promise<Hold> => {
      if (waiters.length === 0 && admits(bytes)) {
        available -= bytes;

        return Promise.resolve(hold(bytes));
      }

      return new Promise<Hold>((resolve) => {
        waiters.push({ need: bytes, wake: () => resolve(hold(bytes)) });
      });
    },
  };
}

// isWindowsReservedName reports whether segment is a Windows reserved device name, matched
// case-insensitively and ignoring any extension, since Windows treats "con.txt" the same as "con".
function isWindowsReservedName(segment: string): boolean {
  const dot = segment.indexOf(".");
  const base = dot === -1 ? segment : segment.slice(0, dot);

  return WINDOWS_RESERVED_NAMES.has(base.toLowerCase());
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

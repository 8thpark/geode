import {
  accountIdFor,
  bucketFor,
  endpointFor,
  type GeodeSettings,
  normalizePrefix,
  regionFor,
} from "../settings/settings.ts";

// SNAPSHOT_VERSION is the current serialized snapshot format; see docs/technical_vault.md for what
// each version was and which are refused.
export const SNAPSHOT_VERSION = 3;

// SNAPSHOT_BYTE_BUDGET keeps a vault of large attachments from piling full reads into memory at
// once.
const SNAPSHOT_BYTE_BUDGET = 64 * 1024 * 1024;

// WINDOWS_RESERVED_NAMES are device names Windows treats as reserved regardless of extension
// (`con.txt` is still `con`).
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
// could not be used.
export type DecodedSnapshot =
  | { ok: true; snapshot: Snapshot }
  | {
      ok: false;
      reason: "caseCollision" | "corrupt" | "duplicatePath" | "unsafePath" | "unsupportedVersion";
    };

// FileInfo is one file as seen live in the vault, before hashing.
export type FileInfo = {
  path: string;
  size: number;
  mtime: number;
};

// FileStat is everything the vault index knows about a path without reading it, present false with
// zero values when the path is absent rather than null to unpack.
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
  blob: string;
};

// Reader lists files present in the vault, reads their bytes, and reports the index's view of a
// single path without touching its content.
export type Reader = {
  listFiles: () => Promise<FileInfo[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  stat: (path: string) => Promise<FileStat>;
};

// Snapshot is every file geode saw the last time it took a snapshot.
export type Snapshot = {
  files: FileState[];
  settingsFingerprint?: string;
  vaultId?: string;
};

// Store reads and writes the persisted snapshot, backed by the plugin's data directory in the real
// implementation and an in memory fake in tests.
export type Store = {
  read: () => Promise<Snapshot>;
  write: (snapshot: Snapshot) => Promise<void>;
};

// Hold is a live byteSemaphore reservation, resizable as a read's actual size becomes known and
// released back to the budget when done.
type Hold = {
  release: () => void;
  resize: (bytes: number) => void;
};

// byPath builds a lookup from path to file state, shared with sync.ts for comparing snapshots.
export function byPath(files: FileState[]): Map<string, FileState> {
  const result = new Map<string, FileState>();
  for (const file of files) {
    result.set(file.path, file);
  }

  return result;
}

// decodeSnapshot parses a serialized snapshot, checking its format version and every entry's path
// before handing it back.
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
  const files: FileState[] = [];
  const normalizedPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const file of parsed.files) {
    // isSnapshot only confirms files is an array; each entry still needs its own shape checked
    // before .path is read off it.
    if (typeof file !== "object" || file === null || typeof file.path !== "string") {
      return { ok: false, reason: "corrupt" };
    }

    if (!isSafeAddress(file.blob)) {
      return { ok: false, reason: "corrupt" };
    }

    // Normalizing here first is what makes the case check below mean what it claims.
    const path = normalizePath(file.path);
    if (!isSafePath(path)) {
      return { ok: false, reason: "unsafePath" };
    }
    if (normalizedPaths.has(path)) {
      return { ok: false, reason: "duplicatePath" };
    }
    const folded = path.toLowerCase();
    if (foldedPaths.has(folded)) {
      return { ok: false, reason: "caseCollision" };
    }
    normalizedPaths.add(path);
    foldedPaths.add(folded);
    files.push({ ...file, path });
  }
  const settingsFingerprint = (parsed as { settingsFingerprint?: unknown }).settingsFingerprint;
  const vaultId = (parsed as { vaultId?: unknown }).vaultId;
  const snapshot: Snapshot = { files };
  if (typeof settingsFingerprint === "string") {
    snapshot.settingsFingerprint = settingsFingerprint;
  }
  if (typeof vaultId === "string") {
    snapshot.vaultId = vaultId;
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
  const result: {
    version: number;
    files: FileState[];
    settingsFingerprint?: string;
    vaultId?: string;
  } = {
    version: SNAPSHOT_VERSION,
    files: snapshot.files,
  };
  if (snapshot.settingsFingerprint !== undefined) {
    result.settingsFingerprint = snapshot.settingsFingerprint;
  }
  if (snapshot.vaultId !== undefined) {
    result.vaultId = snapshot.vaultId;
  }

  return JSON.stringify(result);
}

// fingerprintSettings returns a stable identifier for the sync target, so a change to where the
// vault lives invalidates old state.
export function fingerprintSettings(settings: GeodeSettings): string {
  return JSON.stringify({
    provider: settings.provider,
    accountId: accountIdFor(settings),
    endpoint: endpointFor(settings),
    region: regionFor(settings),
    bucket: bucketFor(settings),
    prefix: normalizePrefix(settings.prefix),
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

// isSafePath reports whether path is safe to write to disk from untrusted input, refusing
// traversal, absolute paths, and the reserved .geode and .obsidian roots.
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

// isSnapshot reports whether a value parsed from untrusted JSON is shaped like a snapshot, so a
// malformed body fails as a handled case rather than crashing later.
export function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === "object" && value !== null && Array.isArray((value as Snapshot).files);
}

// normalizePath returns path with Unicode NFC normalization applied, so the same visible filename
// is always the same byte sequence regardless of which platform composed it.
export function normalizePath(path: string): string {
  return path.normalize("NFC");
}

// takeSnapshot walks every file the reader currently sees and returns their content hashes, reusing
// a previous hash when a file's size and mtime are unchanged.
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
    const normalizedPath = normalizePath(file.path);
    const known = previousByPath.get(normalizedPath);
    if (known !== undefined && known.size === file.size && known.mtime === file.mtime) {
      return known;
    }

    // Reserving against a size read now, not the one listed at the start of the pass, keeps a
    // grown file from slipping past the budget on a stale number.
    const live = await reader.stat(file.path);
    const hold = await budget.acquire(live.size);
    try {
      const bytes = await reader.readFile(file.path);
      hold.resize(bytes.length);
      // Unencrypted, a blob is addressed by its own digest.
      const hash = await hashBytes(bytes);

      return {
        path: normalizedPath,
        size: file.size,
        mtime: file.mtime,
        hash,
        blob: hash,
      };
    } finally {
      hold.release();
    }
  });

  return { files };
}

// byteSemaphore caps the bytes held by in flight readers to budget, admitting waiters strictly in
// arrival order.
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

// isSafeAddress reports whether value is safe to use as the last segment of a blob key, refusing a
// separator or relative segment that could steer a request outside the blob prefix.
function isSafeAddress(value: unknown): boolean {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  if (value.includes("/") || value.includes("\\")) {
    return false;
  }

  return value !== "." && value !== "..";
}

// isWindowsReservedName reports whether segment is a Windows reserved device name, matched case
// insensitively and ignoring any extension.
function isWindowsReservedName(segment: string): boolean {
  const dot = segment.indexOf(".");
  let base = segment;
  if (dot !== -1) {
    base = segment.slice(0, dot);
  }

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

import {
  endpointFor,
  type GeodeSettings,
  normalizePrefix,
  regionFor,
} from "../settings/settings.ts";

// SNAPSHOT_VERSION is the format version stamped into every serialized snapshot, remote manifest
// and local state.json alike, so a future format change (encryption, chunked upload) has
// something to branch on when it meets an existing bucket (#91). A serialized snapshot with no
// version field predates the marker and is version 1, plaintext path keyed storage. Version 2
// moved file content off the vault path and onto a content addressed key under the manifest's own
// bucket (`.geode/blobs/<hash>`, see sync/plan.ts); a version 1 manifest is refused rather than
// read, since its paths point at objects this build never looks for again, and reading it as
// version 2 would plan every push and pull against keys that were never written. Version 3 split
// where a file's content lives from what that content hashes to (FileState.blob against
// FileState.hash, #184), so a version 2 manifest names no address for any of its entries and is
// refused rather than have one guessed for it.
//
// None of these versions migrate: a bucket written before this change needs a fresh bucket, not an
// upgrade. That is only acceptable because every one of them was settled before 0.1.0, while the
// only vaults in a bucket were the project's own. From 0.1.0 onwards a bucket must be migrated
// forward instead, so a version below SNAPSHOT_VERSION but at or above 3 is a decoder's job to
// read and upgrade in place, never to refuse. Only a version above it stays refused, since no
// build can migrate forward from a format that did not exist when it shipped.
export const SNAPSHOT_VERSION = 3;

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
// cannot be used — bytes that don't parse into the expected shape, two entries naming the same
// path once Unicode composition is accounted for, two entries whose paths differ only by case, an
// entry whose path is unsafe to ever write to disk, or a format version this build does not know
// how to read.
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
//
// hash and blob answer two different questions that happen to have the same answer today. hash is
// the SHA-256 of the file's own bytes: what the content is, how a diff notices an edit, and what a
// pulled body is verified against before it lands on disk. blob is where those bytes live in the
// bucket (`.geode/blobs/<blob>`, see blobKeyFor): an address, not a claim about content.
//
// They are separate fields because at 0.3.0 they stop being the same string (#184). An encrypted
// vault addresses a blob by a keyed hash of the plaintext rather than its bare digest, so that
// anyone who can list the bucket cannot test whether a file they already hold is in it; deriving
// that address needs the vault key, which a device pulling a file it has never seen does not have
// a plaintext to apply it to. So the address has to be written down against the path, next to,
// rather than instead of, the digest that says whether the bytes came back intact.
//
// Every producer of a FileState derives blob from the file's own content, so two entries with the
// same hash always carry the same blob and nothing downstream has to reconcile the two.
export type FileState = {
  path: string;
  size: number;
  mtime: number;
  hash: string;
  blob: string;
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

// Snapshot is every file geode saw the last time it took a snapshot. vaultId, when present, is the
// identifier of the bucket this snapshot was last synced against (see resolveVaultIdentity in
// sync/plan.ts, #183): carried on the local state.json copy so a device can tell "I have never
// synced" from "I have synced, and this bucket now looks wrong" the next time a manifest and
// sentinel are both missing. Never populated on the remote manifest itself; syncOnce only ever
// attaches it to the snapshot it hands back to the caller for persistence, after the manifest body
// has already been encoded.
export type Snapshot = {
  files: FileState[];
  settingsFingerprint?: string;
  vaultId?: string;
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
// Refusing every version but the current one is only correct while every older version predates
// 0.1.0 and so has no vaults to strand. Once a released format is superseded, this is where its
// migration belongs: read the older shape, upgrade it to the current one, and hand it back ok, so
// the next write stamps the new version and the bucket moves forward on its own. Only a version
// above SNAPSHOT_VERSION stays refused (see the constant).
//
// Every entry's path is checked with isSafePath before the snapshot is handed back: both callers
// are untrusted input (a remote manifest can be shaped by anyone who can write to the bucket, and
// state.json flows through this same decoder), and a single unsafe path fails the whole snapshot
// rather than being silently dropped, so nothing downstream ever has to re-check what decode
// already promised (#132).
//
// Two entries whose paths differ only by case are refused the same way (#94): bucket keys are
// case sensitive, but macOS, Windows, and Android filesystems are case insensitive by default, so
// pulling both onto a device with any of those would silently let the second write replace the
// first with no conflict ever raised. This is checked for every snapshot regardless of which
// filesystem decodes it, since a manifest a case sensitive device wrote is still headed for
// whichever device syncs it next, and geode has no way to know in advance which that will be.
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
    // isSnapshot only confirms files is an array, not that every entry is shaped like a
    // FileState, so an attacker-controlled manifest can still put a non-object entry (reading
    // .path off null or undefined throws) or a non-string path here despite what the narrowed
    // type above claims.
    if (typeof file !== "object" || file === null || typeof file.path !== "string") {
      return { ok: false, reason: "corrupt" };
    }

    // A blob address is the only field here that becomes a bucket key, and it arrives from the
    // same untrusted place every path does. encodeKey preserves "/" as a separator and leaves
    // dots alone, and a signed URL collapses relative segments itself, so an address of
    // "../../elsewhere" would read an object outside the configured prefix entirely; the same
    // reasoning storage.ts refuses a bad prefix for. A missing address is refused by the same
    // check, which is how a version 2 shaped entry smuggled in under a version 3 marker fails
    // here rather than fetching `.geode/blobs/undefined`.
    if (!isSafeAddress(file.blob)) {
      return { ok: false, reason: "corrupt" };
    }

    // Normalizing before every check below is what makes them mean what they claim. A macOS
    // device decomposes (NFD) where Linux and Android compose (NFC), so the same visible filename
    // arrives here as two different byte sequences (#134); folding case on the raw path would let
    // an NFD "Café.md" and an NFC "café.md" both pass as distinct, and every path recorded from
    // here on is the composed form, so one visible name is one identity across every device.
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
  const fingerprintStr = typeof settingsFingerprint === "string" ? settingsFingerprint : undefined;
  const vaultId = (parsed as { vaultId?: unknown }).vaultId;
  const vaultIdStr = typeof vaultId === "string" ? vaultId : undefined;
  const snapshot: Snapshot = { files };
  if (fingerprintStr !== undefined) {
    snapshot.settingsFingerprint = fingerprintStr;
  }
  if (vaultIdStr !== undefined) {
    snapshot.vaultId = vaultIdStr;
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

// fingerprintSettings returns a stable string identifying the sync target, so we can detect when
// that target changes and invalidate old state (#89). It covers only where the vault lives, the
// fields normalized through endpointFor/regionFor/normalizePrefix to match what a connection
// actually uses. Credentials (accessKeyId, secretId) are deliberately excluded: they authorize
// access to a target, they do not identify one, so rotating a key must not invalidate state and
// force a full re-hash. A genuine target change always moves one of the fields below, and a prefix
// is one: repointing at another folder in the same bucket lands somewhere with its own manifest and
// its own sentinel, so carrying the old state across would diff the vault against a stranger.
export function fingerprintSettings(settings: GeodeSettings): string {
  return JSON.stringify({
    provider: settings.provider,
    accountId: settings.accountId,
    endpoint: endpointFor(settings),
    region: regionFor(settings),
    bucket: settings.bucket,
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

// normalizePath returns path with Unicode NFC normalization applied, so the same visible filename
// is always the same byte sequence regardless of which platform composed it. macOS and iOS
// decompose (NFD) by default; Linux and Android compose (NFC). Without this, the same note
// produces two distinct S3 keys and manifest identities when synced across platforms.
export function normalizePath(path: string): string {
  return path.normalize("NFC");
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
    const normalizedPath = normalizePath(file.path);
    const known = previousByPath.get(normalizedPath);
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
      // Unencrypted, a blob is addressed by its own digest, so the two fields hold the same
      // string; see FileState for why they are still recorded separately.
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

// isSafeAddress reports whether value can be used as the last segment of a blob key. It is
// deliberately a statement about keys rather than about digests: an address is 64 lowercase hex
// characters today, but a future suite is free to encode it differently (#184), and a check that
// pinned the alphabet would have to be relaxed exactly when the format changed. What must hold for
// every scheme is that an address addresses one object under the blob prefix and cannot steer a
// request anywhere else, so a separator or a relative segment is what's refused here.
function isSafeAddress(value: unknown): boolean {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  if (value.includes("/") || value.includes("\\")) {
    return false;
  }

  return value !== "." && value !== "..";
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

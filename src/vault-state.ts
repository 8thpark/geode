// FileState is what geode remembers about one vault file as of the last snapshot.
export type FileState = {
  path: string;
  size: number;
  mtime: number;
  hash: string;
};

// VaultSnapshot is every file geode saw the last time it took a snapshot.
export type VaultSnapshot = {
  files: FileState[];
};

// VaultFile is one file as seen live in the vault, before hashing.
export type VaultFile = {
  path: string;
  size: number;
  mtime: number;
};

// VaultReader lists files present in the vault right now and reads their bytes. The real
// implementation wraps Obsidian's Vault API (see vault-adapter.ts); tests use an in-memory fake.
export type VaultReader = {
  listFiles: () => Promise<VaultFile[]>;
  readFile: (path: string) => Promise<Uint8Array>;
};

// StateStore reads and writes the persisted snapshot. The real implementation stores it inside
// the plugin's own data directory (see vault-adapter.ts); tests use an in-memory fake.
export type StateStore = {
  read: () => Promise<VaultSnapshot>;
  write: (snapshot: VaultSnapshot) => Promise<void>;
};

// Change describes one path whose state differs between two snapshots.
export type Change = {
  path: string;
  kind: "added" | "modified" | "deleted";
};

// hashBytes returns the lowercase hex SHA-256 digest of data.
async function hashBytes(data: Uint8Array): Promise<string> {
  // Same TS/DOM lib generic mismatch as storage.ts's BodyInit cast: Uint8Array<ArrayBufferLike>
  // vs BufferSource's stricter ArrayBuffer expectation. Not a real runtime issue.
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// takeSnapshot walks every file the reader currently sees and returns their content hashes. A
// file whose size and mtime both match the previous snapshot reuses that hash instead of
// rereading content — the same stat gated hashing rsync, git, and Syncthing all use, since mtime
// and size alone aren't reliable enough to trust as identity, but are cheap enough to skip a
// rehash when neither has moved.
export async function takeSnapshot(
  reader: VaultReader,
  previous: VaultSnapshot,
): Promise<VaultSnapshot> {
  const previousByPath = new Map(previous.files.map((file) => [file.path, file]));
  const liveFiles = await reader.listFiles();

  const files = await Promise.all(
    liveFiles.map(async (file) => {
      const known = previousByPath.get(file.path);
      if (known !== undefined && known.size === file.size && known.mtime === file.mtime) {
        return known;
      }
      const bytes = await reader.readFile(file.path);
      return { path: file.path, size: file.size, mtime: file.mtime, hash: await hashBytes(bytes) };
    }),
  );

  return { files };
}

// diffSnapshots compares two snapshots and reports every path whose content differs.
export function diffSnapshots(previous: VaultSnapshot, current: VaultSnapshot): Change[] {
  const previousByPath = new Map(previous.files.map((file) => [file.path, file]));
  const currentByPath = new Map(current.files.map((file) => [file.path, file]));
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

import type { DataAdapter, Vault } from "obsidian";
import type { LocalWriter } from "../sync/execute.ts";
import { type FileInfo, isSnapshot, type Reader, type Snapshot, type Store } from "./vault.ts";

// createObsidianLocalWriter returns a LocalWriter that applies pulled remote changes straight
// through the low level data adapter, rather than the Vault API, since a path pulled down for
// the first time has no TFile yet for Vault.modifyBinary/rename to operate on. Pulled content is
// staged to a hidden temp file and renamed into place, never written directly to its destination,
// so an interrupted pull cannot leave torn bytes for the next snapshot to read as a local edit
// and push to the bucket (#88).
export function createObsidianLocalWriter(adapter: DataAdapter): LocalWriter {
  return {
    writeFile: async (path, data) => {
      await ensureParentDir(adapter, path);
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      await writeThroughTemp(adapter, path, buffer as ArrayBuffer);
    },
    deleteFile: async (path) => {
      const exists = await adapter.exists(path);
      if (!exists) {
        return;
      }
      await adapter.remove(path);
    },
    renameFile: async (path, newPath) => {
      await ensureParentDir(adapter, newPath);
      await adapter.rename(path, newPath);
    },
  };
}

// createObsidianReader returns a Reader backed by the real vault's file tree. Obsidian
// already excludes .obsidian/** from Vault.getFiles(), so the plugin's own state file (which
// lives inside .obsidian/plugins/geode/) never shows up as a vault file to snapshot.
export function createObsidianReader(vault: Vault): Reader {
  return {
    fileExists: async (path) => {
      return vault.getFileByPath(path) !== null;
    },
    listFiles: async () => {
      const files: FileInfo[] = [];
      for (const file of vault.getFiles()) {
        files.push({ path: file.path, size: file.stat.size, mtime: file.stat.mtime });
      }
      return files;
    },
    readFile: async (path) => {
      const file = vault.getFileByPath(path);
      if (file === null) {
        throw new Error(`file disappeared during snapshot: ${path}`);
      }
      const buffer = await vault.readBinary(file);
      return new Uint8Array(buffer);
    },
  };
}

// createObsidianStore returns a Store that persists the snapshot at statePath via the
// vault adapter. A missing or unparseable file is treated as "no snapshot yet" rather than an
// error, since the safest fallback for corrupt state is to start fresh, not to crash sync.
export function createObsidianStore(adapter: DataAdapter, statePath: string): Store {
  const empty: Snapshot = { files: [] };

  return {
    read: async () => {
      const exists = await adapter.exists(statePath);
      if (!exists) {
        return empty;
      }
      try {
        const parsed: unknown = JSON.parse(await adapter.read(statePath));
        if (isSnapshot(parsed)) {
          return parsed;
        }
        return empty;
      } catch {
        return empty;
      }
    },
    write: async (snapshot) => {
      await adapter.write(statePath, JSON.stringify(snapshot));
    },
  };
}

// ensureParentDir creates path's parent folder, and any folders above it, before a write that
// might land somewhere the vault has never had a file before. mkdir is assumed to create
// intermediate folders the same way Obsidian's own folder creation does.
async function ensureParentDir(adapter: DataAdapter, path: string): Promise<void> {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    return;
  }
  const dir = path.slice(0, lastSlash);
  const exists = await adapter.exists(dir);
  if (!exists) {
    await adapter.mkdir(dir);
  }
}

// tempWritePath returns the hidden sibling path a pull is staged to before renaming into place.
// The dot prefix keeps it out of Obsidian's file index, so it can never appear in a snapshot, and
// the name is deterministic so a leftover from an interrupted pull is overwritten by the next
// pull of the same path rather than accumulating.
function tempWritePath(path: string): string {
  const lastSlash = path.lastIndexOf("/");

  return `${path.slice(0, lastSlash + 1)}.${path.slice(lastSlash + 1)}.geode-tmp`;
}

// writeThroughTemp stages data at a hidden temp path beside its destination, then renames it into
// place, so a crash mid write leaves the destination either untouched or fully written, never
// holding torn bytes (#88). Desktop's adapter rename replaces an existing destination atomically;
// for an adapter whose rename refuses to overwrite, the destination is removed and the rename
// retried, shrinking the exposure from the whole download and write to the instant between remove
// and rename, where a crash leaves the path absent and the next sync replans the pull instead of
// pushing corruption.
async function writeThroughTemp(
  adapter: DataAdapter,
  path: string,
  data: ArrayBuffer,
): Promise<void> {
  const tempPath = tempWritePath(path);
  await adapter.writeBinary(tempPath, data);
  try {
    await adapter.rename(tempPath, path);
  } catch (err) {
    const exists = await adapter.exists(path);
    if (!exists) {
      throw err;
    }
    await adapter.remove(path);
    await adapter.rename(tempPath, path);
  }
}

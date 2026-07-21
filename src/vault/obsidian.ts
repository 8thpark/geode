import type { DataAdapter, Vault } from "obsidian";
import type { LocalWriter } from "../sync/execute.ts";
import { type FileInfo, isSnapshot, type Reader, type Snapshot, type Store } from "./vault.ts";

// createObsidianLocalWriter returns a LocalWriter that applies pulled remote changes straight
// through the low level data adapter, rather than the Vault API, since a path pulled down for
// the first time has no TFile yet for Vault.modifyBinary/rename to operate on.
export function createObsidianLocalWriter(adapter: DataAdapter): LocalWriter {
  return {
    writeFile: async (path, data) => {
      await ensureParentDir(adapter, path);
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      await adapter.writeBinary(path, buffer as ArrayBuffer);
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

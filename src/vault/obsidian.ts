import type { DataAdapter, Vault } from "obsidian";
import { shouldIgnore } from "../ignore.ts";
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
export function createObsidianReader(vault: Vault, ignorePatterns: string[]): Reader {
  return {
    fileExists: async (path) => {
      return vault.getFileByPath(path) !== null;
    },
    listFiles: async () => {
      const files: FileInfo[] = [];
      for (const file of vault.getFiles()) {
        if (!shouldIgnore(file.path, ignorePatterns)) {
          files.push({
            path: file.path,
            size: file.stat.size,
            mtime: file.stat.mtime,
          });
        }
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

// hiddenSiblingPath returns a dot prefixed sibling of path carrying suffix, the naming scheme for
// geode's staging files: hidden so Obsidian never indexes them and they can never appear in a
// snapshot, deterministic so a leftover from an interrupted write is reclaimed by the next write
// to the same path rather than accumulating.
function hiddenSiblingPath(path: string, suffix: string): string {
  const lastSlash = path.lastIndexOf("/");

  return `${path.slice(0, lastSlash + 1)}.${path.slice(lastSlash + 1)}${suffix}`;
}

// replaceViaAside installs the staged file over an existing destination for an adapter whose
// rename refuses to overwrite: the current content is renamed aside, the staged file claims the
// path, and only then is the aside copy removed. The destination's bytes are never deleted while
// a restore is still possible, so if the rename actually failed for some other reason
// (permissions, a transient I/O error) and the retry fails the same way, the aside copy is
// renamed straight back and the file survives untouched.
async function replaceViaAside(
  adapter: DataAdapter,
  tempPath: string,
  path: string,
): Promise<void> {
  const asidePath = hiddenSiblingPath(path, ".geode-old");
  const leftover = await adapter.exists(asidePath);
  if (leftover) {
    await adapter.remove(asidePath);
  }
  await adapter.rename(path, asidePath);
  try {
    await adapter.rename(tempPath, path);
  } catch (err) {
    await adapter.rename(asidePath, path);
    throw err;
  }
  await adapter.remove(asidePath);
}

// writeThroughTemp stages data at a hidden temp path beside its destination, then renames it into
// place, so a crash mid write leaves the destination either untouched or fully written, never
// holding torn bytes (#88). Desktop's adapter rename replaces an existing destination atomically;
// a rename that fails while the destination exists is retried through replaceViaAside, shrinking
// the exposure from the whole download and write to the instant between the two renames, where a
// crash leaves the path absent and the next sync replans the pull instead of pushing corruption.
async function writeThroughTemp(
  adapter: DataAdapter,
  path: string,
  data: ArrayBuffer,
): Promise<void> {
  const tempPath = hiddenSiblingPath(path, ".geode-tmp");
  await adapter.writeBinary(tempPath, data);
  try {
    await adapter.rename(tempPath, path);
  } catch (err) {
    const exists = await adapter.exists(path);
    if (!exists) {
      throw err;
    }
    await replaceViaAside(adapter, tempPath, path);
  }
}

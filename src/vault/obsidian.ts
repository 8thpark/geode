import type { DataAdapter, Vault, Workspace } from "obsidian";
import type { GeodeSettings } from "../settings/settings.ts";
import { DRIFT_MESSAGE, type LocalWriter, type WriteMode } from "../sync/execute.ts";
import {
  decodeSnapshot,
  encodeSnapshot,
  type FileInfo,
  fingerprintSettings,
  normalizePath,
  type Reader,
  type Snapshot,
  type Store,
} from "./vault.ts";

// createObsidianLocalWriter returns a LocalWriter that applies pulled remote changes through the
// low level data adapter rather than the Vault API, since a newly pulled path has no TFile yet.
export function createObsidianLocalWriter(adapter: DataAdapter): LocalWriter {
  return {
    stageFile: async (path, data, mode) => {
      const normalized = normalizePath(path);
      await ensureParentDir(adapter, normalized);
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const tempPath = hiddenSiblingPath(normalized, ".geode-tmp");
      await adapter.writeBinary(tempPath, buffer as ArrayBuffer);

      return {
        commit: async () => {
          await installStaged(adapter, tempPath, normalized, mode);
        },
        discard: async () => {
          const exists = await adapter.exists(tempPath);
          if (!exists) {
            return;
          }
          await adapter.remove(tempPath);
        },
      };
    },
    deleteFile: async (path) => {
      const normalized = normalizePath(path);
      const exists = await adapter.exists(normalized);
      if (!exists) {
        return;
      }
      // A pulled deletion is moved to trash, never hard removed.
      const trashed = await adapter.trashSystem(normalized);
      if (trashed) {
        return;
      }
      await adapter.trashLocal(normalized);
    },
    renameFile: async (path, newPath) => {
      const normalizedOld = normalizePath(path);
      const normalizedNew = normalizePath(newPath);
      await ensureParentDir(adapter, normalizedNew);
      await adapter.rename(normalizedOld, normalizedNew);
    },
  };
}

// createObsidianReader returns a Reader backed by the real vault's file tree, relying on Obsidian
// already excluding .obsidian/** from Vault.getFiles() so the plugin's own state file never shows
// up as a vault file to snapshot.
export function createObsidianReader(vault: Vault): Reader {
  return {
    listFiles: async () => {
      const files: FileInfo[] = [];
      for (const file of vault.getFiles()) {
        files.push({
          path: normalizePath(file.path),
          size: file.stat.size,
          mtime: file.stat.mtime,
        });
      }
      return files;
    },
    readFile: async (path) => {
      const normalized = normalizePath(path);
      const file = vault.getFileByPath(normalized);
      if (file === null) {
        throw new Error(`file disappeared during snapshot: ${normalized}`);
      }
      const buffer = await vault.readBinary(file);
      return new Uint8Array(buffer);
    },
    // Both fields come from the TFile the vault already holds in memory, so this is an index
    // lookup rather than a filesystem call: cheap enough to run immediately before a destructive
    // write, which is the whole reason a pull can confirm a path is untouched without rereading it.
    stat: async (path) => {
      const file = vault.getFileByPath(normalizePath(path));
      if (file === null) {
        return { present: false, size: 0, mtime: 0 };
      }
      return { present: true, size: file.stat.size, mtime: file.stat.mtime };
    },
  };
}

// createObsidianStore returns a Store persisting the snapshot at statePath, treating an unusable
// file as "no snapshot yet" and writing atomically because every sync's safety reasoning rests on
// this one file.
export function createObsidianStore(
  adapter: DataAdapter,
  statePath: string,
  settings: GeodeSettings,
): Store {
  const empty: Snapshot = { files: [] };

  return {
    read: async () => {
      const exists = await adapter.exists(statePath);
      if (!exists) {
        return empty;
      }
      let raw: string;
      try {
        raw = await adapter.read(statePath);
      } catch {
        return empty;
      }
      const decoded = decodeSnapshot(raw);
      if (!decoded.ok) {
        return empty;
      }
      if (decoded.snapshot.settingsFingerprint !== fingerprintSettings(settings)) {
        return empty;
      }

      return decoded.snapshot;
    },
    write: async (snapshot) => {
      const withFingerprint: Snapshot = {
        ...snapshot,
        settingsFingerprint: fingerprintSettings(settings),
      };
      const tempPath = hiddenSiblingPath(statePath, ".geode-tmp");
      await adapter.write(tempPath, encodeSnapshot(withFingerprint));
      await installStaged(adapter, tempPath, statePath, "replace");
    },
  };
}

// flushOpenEditors writes every open editor's buffer to disk, since the Vault API only ever sees
// bytes already there and Obsidian's own autosave is debounced.
export async function flushOpenEditors(workspace: Workspace): Promise<void> {
  const leaves = workspace.getLeavesOfType("markdown");
  const flushes: Promise<void>[] = [];
  for (const leaf of leaves) {
    const view = leaf.view as unknown as { save?: () => Promise<void> };
    if (typeof view.save !== "function") {
      continue;
    }
    flushes.push(view.save());
  }
  await Promise.all(flushes);
}

// ensureParentDir creates each missing folder level in turn, since Obsidian's API leaves whether
// mkdir recurses undocumented and mobile adapters are not known to match desktop.
async function ensureParentDir(adapter: DataAdapter, path: string): Promise<void> {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    return;
  }
  const dir = path.slice(0, lastSlash);
  let current = "";
  for (const segment of dir.split("/")) {
    current = current === "" ? segment : `${current}/${segment}`;
    const exists = await adapter.exists(current);
    if (!exists) {
      await adapter.mkdir(current);
    }
  }
}

// hiddenSiblingPath names a staging file: hidden so Obsidian never indexes it into a snapshot,
// and deterministic so a leftover is reclaimed by the next write rather than accumulating.
function hiddenSiblingPath(path: string, suffix: string): string {
  const lastSlash = path.lastIndexOf("/");

  return `${path.slice(0, lastSlash + 1)}.${path.slice(lastSlash + 1)}${suffix}`;
}

// replaceViaAside installs a staged file where rename refuses to overwrite, never deleting the
// destination's bytes while a restore is still possible.
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

// installStaged renames a staged file onto its destination, so a crash leaves that destination
// either untouched or fully written. A "create" write refuses an occupied path outright, checked
// against the adapter's own stat.
async function installStaged(
  adapter: DataAdapter,
  tempPath: string,
  path: string,
  mode: WriteMode,
): Promise<void> {
  if (mode === "create") {
    const occupied = await adapter.exists(path);
    if (occupied) {
      throw new Error(DRIFT_MESSAGE);
    }
    await adapter.rename(tempPath, path);

    return;
  }
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

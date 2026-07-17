import type { DataAdapter, Vault } from "obsidian";
import { shouldIgnore } from "./ignore.ts";
import type { StateStore, VaultFile, VaultReader, VaultSnapshot } from "./vault-state.ts";

// createObsidianVaultReader returns a VaultReader backed by the real vault's file tree. Obsidian
// already excludes .obsidian/** from Vault.getFiles(), so the plugin's own state file (which
// lives inside .obsidian/plugins/geode/) never shows up as a vault file to snapshot. Files
// matching ignorePatterns or the built-in local_ prefix convention are filtered out.
export function createObsidianVaultReader(vault: Vault, ignorePatterns: string[]): VaultReader {
  return {
    listFiles: async () => {
      const files: VaultFile[] = [];
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

// createObsidianStateStore returns a StateStore that persists the snapshot at statePath via the
// vault adapter. A missing or unparseable file is treated as "no snapshot yet" rather than an
// error, since the safest fallback for corrupt state is to start fresh, not to crash sync.
export function createObsidianStateStore(adapter: DataAdapter, statePath: string): StateStore {
  const empty: VaultSnapshot = { files: [] };

  return {
    read: async () => {
      const exists = await adapter.exists(statePath);
      if (!exists) {
        return empty;
      }
      try {
        const raw = await adapter.read(statePath);
        return JSON.parse(raw) as VaultSnapshot;
      } catch {
        return empty;
      }
    },
    write: async (snapshot) => {
      await adapter.write(statePath, JSON.stringify(snapshot));
    },
  };
}

// Integration test helper: a node:fs backed stand-in for Obsidian's Vault and DataAdapter, so the
// real vault-adapter.ts code (createObsidianVaultReader/LocalWriter/StateStore) can be exercised
// against a real filesystem in a temp directory. Not shipped: nothing in the plugin bundle imports
// it. This closes the biggest fidelity gap in sync integration tests, the local file I/O layer,
// without needing a running Obsidian.
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DataAdapter, TFile, Vault } from "obsidian";

// abs joins a vault relative, forward slash path onto the temp root as a real OS path.
function abs(root: string, path: string): string {
  return join(root, ...path.split("/"));
}

// walk returns every file (not directory) under the root as vault relative, forward slash paths,
// excluding anything under .obsidian, mirroring what Obsidian's Vault.getFiles() leaves out.
function walk(root: string, dir = ""): string[] {
  const here = dir === "" ? root : abs(root, dir);
  const out: string[] = [];
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    if (entry.name === ".obsidian") {
      continue;
    }
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...walk(root, rel));
      continue;
    }
    out.push(rel);
  }
  return out;
}

// nodeVault returns a Vault and DataAdapter both backed by the same temp directory root. Only the
// subset of methods vault-adapter.ts actually calls is implemented, then cast to the full Obsidian
// interfaces, which is all the real code touches.
export function nodeVault(root: string): { vault: Vault; adapter: DataAdapter } {
  const adapter = {
    exists: async (path: string): Promise<boolean> => {
      try {
        await stat(abs(root, path));
        return true;
      } catch {
        return false;
      }
    },
    mkdir: async (path: string): Promise<void> => {
      await mkdir(abs(root, path), { recursive: true });
    },
    writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      await writeFile(abs(root, path), Buffer.from(data));
    },
    remove: async (path: string): Promise<void> => {
      await rm(abs(root, path));
    },
    rename: async (path: string, newPath: string): Promise<void> => {
      await rename(abs(root, path), abs(root, newPath));
    },
    read: async (path: string): Promise<string> => {
      return readFile(abs(root, path), "utf8");
    },
    write: async (path: string, data: string): Promise<void> => {
      await writeFile(abs(root, path), data);
    },
  } as unknown as DataAdapter;

  const vault = {
    getFiles: (): TFile[] => {
      return walk(root).map((path) => {
        const s = statSync(abs(root, path));
        return { path, stat: { size: s.size, mtime: s.mtimeMs } } as unknown as TFile;
      });
    },
    getFileByPath: (path: string): TFile | null => {
      if (!existsSync(abs(root, path))) {
        return null;
      }
      return { path } as unknown as TFile;
    },
    readBinary: async (file: TFile): Promise<ArrayBuffer> => {
      const buf = await readFile(abs(root, file.path));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  } as unknown as Vault;

  return { vault, adapter };
}

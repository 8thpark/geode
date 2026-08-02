import type { DataAdapter, Vault, Workspace } from "obsidian";
import type { GeodeSettings } from "../settings/settings.ts";
import { DRIFT_MESSAGE, type LocalWriter, type WriteMode } from "../sync/execute.ts";
import {
  decodeSnapshot,
  encodeSnapshot,
  type FileInfo,
  fingerprintSettings,
  type Reader,
  type Snapshot,
  type Store,
} from "./vault.ts";

// createObsidianLocalWriter returns a LocalWriter that applies pulled remote changes straight
// through the low level data adapter, rather than the Vault API, since a path pulled down for
// the first time has no TFile yet for Vault.modifyBinary/rename to operate on. Pulled content is
// staged to a hidden temp file and renamed into place, never written directly to its destination,
// so an interrupted pull cannot leave torn bytes for the next snapshot to read as a local edit
// and push to the bucket (#88).
//
// Staging and installing are separate calls rather than one writeFile, so the caller can run its
// drift checks in between: the payload is already on disk by then, leaving only commit's rename
// between the last check and the destination changing (see commitPulledContent in sync/execute.ts).
export function createObsidianLocalWriter(adapter: DataAdapter): LocalWriter {
  return {
    stageFile: async (path, data, mode) => {
      await ensureParentDir(adapter, path);
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const tempPath = hiddenSiblingPath(path, ".geode-tmp");
      await adapter.writeBinary(tempPath, buffer as ArrayBuffer);

      return {
        commit: async () => {
          await installStaged(adapter, tempPath, path, mode);
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
      const exists = await adapter.exists(path);
      if (!exists) {
        return;
      }
      // A pulled deletion is moved to trash, never hard removed, so a delete that turns out to be
      // a mistake stays recoverable on this device (#53), mirroring what Obsidian does for a
      // manual delete. System trash is tried first and the vault-local .trash folder is the
      // fallback when the OS has no trash (mobile, a headless host), so the file is always
      // recoverable somewhere rather than gone.
      const trashed = await adapter.trashSystem(path);
      if (trashed) {
        return;
      }
      await adapter.trashLocal(path);
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
    // Both fields come from the TFile the vault already holds in memory, so this is an index
    // lookup rather than a filesystem call: cheap enough to run immediately before a destructive
    // write, which is the whole reason a pull can confirm a path is untouched without rereading it.
    stat: async (path) => {
      const file = vault.getFileByPath(path);
      if (file === null) {
        return { present: false, size: 0, mtime: 0 };
      }
      return { present: true, size: file.stat.size, mtime: file.stat.mtime };
    },
  };
}

// createObsidianStore returns a Store that persists the snapshot at statePath via the
// vault adapter. A missing, unparseable, or unsupported-version file is treated as "no snapshot
// yet" rather than an error, since the safest fallback for unusable state is to start fresh, not
// to crash sync: an empty ancestor can at worst produce conflict copies, never data loss, and a
// state.json from a newer format only ever appears alongside a newer format manifest, which
// readRemoteManifest refuses before the ancestor matters.
//
// write stages the new content to a hidden temp file and installs it the same way a pulled file
// is installed (#136): statePath is the one file every sync's safety reasoning rests on as the
// common ancestor, so a crash mid write must never leave it torn. A torn read used to fall back to
// "no snapshot" above, which is safe on its own but still turns every remotely deleted file into a
// resurrection and every divergence into a conflict copy; atomic writes mean that fallback is
// never actually exercised by an interrupted write.
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

// flushOpenEditors forces every open markdown editor to write its current buffer to disk, closing
// the window where Obsidian's own debounced autosave (TextFileView.requestSave, ~2s) leaves
// keystrokes sitting in the editor only: checkLocalDrift reads through the Vault API, which only
// ever sees bytes already on disk, so without this a pull can land on a path whose editor still
// holds older content, and the next autosave then silently overwrites the pulled bytes with
// content sync never saw and never checked. Called right before a snapshot is taken, so the
// residual race is only whatever the user types in the moment between this flush and that read,
// not however long has passed since Obsidian's own debounce last fired. A leaf whose view carries
// no save (anything other than a text file view) is skipped rather than treated as an error.
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

// ensureParentDir creates path's parent folder, and any folders above it, before a write that
// might land somewhere the vault has never had a file before. Each folder level is created in
// turn rather than left to a single adapter.mkdir call on the deepest one, since Obsidian's public
// API leaves whether mkdir recurses through missing intermediate folders undocumented, and mobile
// adapters (Capacitor) are not known to match desktop's behavior here.
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

// installStaged renames an already staged file onto its destination, the step that actually changes
// what the vault holds, so a crash mid write leaves the destination either untouched or fully
// written, never holding torn bytes (#88). Desktop's adapter rename replaces an existing
// destination atomically; a rename that fails while the destination exists is retried through
// replaceViaAside, shrinking the exposure from the whole download and write to the instant between
// the two renames, where a crash leaves the path absent and the next sync replans the pull instead
// of pushing corruption.
//
// A "create" write refuses that replacement entirely: its caller staged these bytes for a path it
// had reason to believe was empty, so a file being there means one appeared since, and installing
// over it would destroy content nothing else holds. The existence check is the adapter's own stat,
// the only view that sees a file the moment it lands rather than when Obsidian's index catches up,
// and it sits one call before the rename, which is as tight as an adapter with no create-exclusive
// rename allows. Throwing is how every failure leaves this layer; executeSyncPlan turns it back
// into an ordinary per file failure the moment it crosses the boundary.
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

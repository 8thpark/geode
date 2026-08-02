import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataAdapter, Workspace } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings/settings.ts";
import type { LocalWriter, WriteMode } from "../sync/execute.ts";
import { createObsidianLocalWriter, createObsidianStore, flushOpenEditors } from "./obsidian.ts";
import { fingerprintSettings, type Snapshot } from "./vault.ts";

// fakeAdapter returns a DataAdapter whose exists/read/write operate over one in-memory file map,
// enough to drive the state store. Only the methods the state store touches are implemented; the
// rest of the DataAdapter surface is never reached from here.
function fakeAdapter(seed: Record<string, string> = {}): DataAdapter {
  const files = new Map<string, string>(Object.entries(seed));
  const adapter = {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return content;
    },
    write: async (path: string, data: string) => {
      files.set(path, data);
    },
    rename: async (path: string, newPath: string) => {
      const data = files.get(path);
      if (data === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      files.delete(path);
      files.set(newPath, data);
    },
  };
  return adapter as unknown as DataAdapter;
}

// WriterBehavior configures the failure modes a fake writer adapter simulates: renameOverwrites
// false mimics a filesystem whose rename refuses to replace an existing destination (as mobile
// can), stagedRenameFails mimics a rename that fails whenever the staged temp file is the source
// (a lock on the staged bytes, a permissions error), and writeBinaryFails mimics an interrupted
// or failed write of the staged bytes.
type WriterBehavior = {
  renameOverwrites: boolean;
  stagedRenameFails: boolean;
  writeBinaryFails: boolean;
};

// fakeWriterAdapter returns a DataAdapter whose binary file methods operate over one in-memory
// file map, enough to drive the local writer, plus an ordered log of every mutating call so tests
// can assert the destination is only ever renamed into, never written directly.
function fakeWriterAdapter(
  behavior: WriterBehavior,
  seed: Record<string, string> = {},
): { adapter: DataAdapter; files: Map<string, string>; ops: string[] } {
  const files = new Map<string, string>(Object.entries(seed));
  const ops: string[] = [];
  const adapter = {
    exists: async (path: string) => files.has(path),
    mkdir: async (path: string) => {
      ops.push(`mkdir ${path}`);
    },
    remove: async (path: string) => {
      ops.push(`remove ${path}`);
      if (!files.delete(path)) {
        throw new Error(`no such file: ${path}`);
      }
    },
    rename: async (path: string, newPath: string) => {
      ops.push(`rename ${path} -> ${newPath}`);
      if (behavior.stagedRenameFails && path.endsWith(".geode-tmp")) {
        throw new Error(`permission denied: ${path}`);
      }
      if (!behavior.renameOverwrites && files.has(newPath)) {
        throw new Error(`destination exists: ${newPath}`);
      }
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      files.delete(path);
      files.set(newPath, content);
    },
    writeBinary: async (path: string, data: ArrayBuffer) => {
      ops.push(`writeBinary ${path}`);
      if (behavior.writeBinaryFails) {
        throw new Error(`disk full: ${path}`);
      }
      files.set(path, new TextDecoder().decode(data));
    },
  };
  return { adapter: adapter as unknown as DataAdapter, files, ops };
}

// bytes encodes body for a staged write.
function bytes(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

// writeThrough stages body at path and commits it, the two step sequence a pull runs its drift
// checks between, collapsed for tests that only care about where the bytes end up. mode defaults to
// the ordinary pull's "replace"; the "create" cases pass it explicitly.
async function writeThrough(
  writer: LocalWriter,
  path: string,
  body: string,
  mode: WriteMode = "replace",
): Promise<void> {
  const staged = await writer.stageFile(path, bytes(body), mode);
  await staged.commit();
}

const STATE_PATH = "state.json";
const empty: Snapshot = { files: [] };

test("createObsidianLocalWriter: a pull is staged to a hidden temp file and renamed into place, never written directly to its destination", async () => {
  const { adapter, files, ops } = fakeWriterAdapter({
    renameOverwrites: true,
    stagedRenameFails: false,
    writeBinaryFails: false,
  });
  const writer = createObsidianLocalWriter(adapter);

  await writeThrough(writer, "notes/a.md", "pulled content");

  assert.equal(files.get("notes/a.md"), "pulled content");
  assert.equal(files.has("notes/.a.md.geode-tmp"), false);
  assert.deepEqual(ops, [
    "mkdir notes",
    "writeBinary notes/.a.md.geode-tmp",
    "rename notes/.a.md.geode-tmp -> notes/a.md",
  ]);
});

test("createObsidianLocalWriter: a pull into a path whose ancestors don't exist creates every folder level, not just the immediate parent", async () => {
  const { adapter, files, ops } = fakeWriterAdapter({
    renameOverwrites: true,
    stagedRenameFails: false,
    writeBinaryFails: false,
  });
  const writer = createObsidianLocalWriter(adapter);

  await writeThrough(writer, "a/b/c/d.md", "pulled content");

  assert.equal(files.get("a/b/c/d.md"), "pulled content");
  assert.deepEqual(ops, [
    "mkdir a",
    "mkdir a/b",
    "mkdir a/b/c",
    "writeBinary a/b/c/.d.md.geode-tmp",
    "rename a/b/c/.d.md.geode-tmp -> a/b/c/d.md",
  ]);
});

test("createObsidianLocalWriter: overwriting an existing file replaces it through the temp rename", async () => {
  const { adapter, files, ops } = fakeWriterAdapter(
    { renameOverwrites: true, stagedRenameFails: false, writeBinaryFails: false },
    { "a.md": "old content" },
  );
  const writer = createObsidianLocalWriter(adapter);

  await writeThrough(writer, "a.md", "new content");

  assert.equal(files.get("a.md"), "new content");
  assert.equal(files.has(".a.md.geode-tmp"), false);
  assert.deepEqual(ops, ["writeBinary .a.md.geode-tmp", "rename .a.md.geode-tmp -> a.md"]);
});

test("createObsidianLocalWriter: a create write onto an occupied destination refuses, never touching what is there", async () => {
  // A conflict's restore stages its bytes for a path its own rename vacated moments earlier, so a
  // file at that path was created in the window since and holds content no conflict copy
  // preserved. The commit must refuse rather than rename over it, and must refuse before the
  // rename, not after: the destination's own bytes are never in play.
  const { adapter, files, ops } = fakeWriterAdapter(
    { renameOverwrites: true, stagedRenameFails: false, writeBinaryFails: false },
    { "a.md": "recreated mid sync" },
  );
  const writer = createObsidianLocalWriter(adapter);

  await assert.rejects(writeThrough(writer, "a.md", "restored content", "create"), {
    message: "changed locally mid sync; sync again to reconcile",
  });

  assert.equal(files.get("a.md"), "recreated mid sync");
  assert.deepEqual(ops, ["writeBinary .a.md.geode-tmp"]);
});

test("createObsidianLocalWriter: a create write onto a free path renames straight in, with no aside dance", async () => {
  const { adapter, files, ops } = fakeWriterAdapter({
    renameOverwrites: true,
    stagedRenameFails: false,
    writeBinaryFails: false,
  });
  const writer = createObsidianLocalWriter(adapter);

  await writeThrough(writer, "a.md", "restored content", "create");

  assert.equal(files.get("a.md"), "restored content");
  assert.equal(files.has(".a.md.geode-tmp"), false);
  assert.deepEqual(ops, ["writeBinary .a.md.geode-tmp", "rename .a.md.geode-tmp -> a.md"]);
});

test("createObsidianLocalWriter: an adapter whose rename refuses to overwrite replaces via the aside rename", async () => {
  const { adapter, files, ops } = fakeWriterAdapter(
    { renameOverwrites: false, stagedRenameFails: false, writeBinaryFails: false },
    { "a.md": "old content" },
  );
  const writer = createObsidianLocalWriter(adapter);

  await writeThrough(writer, "a.md", "new content");

  assert.equal(files.get("a.md"), "new content");
  assert.equal(files.has(".a.md.geode-tmp"), false);
  assert.equal(files.has(".a.md.geode-old"), false);
  assert.deepEqual(ops, [
    "writeBinary .a.md.geode-tmp",
    "rename .a.md.geode-tmp -> a.md",
    "rename a.md -> .a.md.geode-old",
    "rename .a.md.geode-tmp -> a.md",
    "remove .a.md.geode-old",
  ]);
});

test("createObsidianLocalWriter: a rename that keeps failing for another reason restores the destination", async () => {
  // The review edge case on #88: the first rename did not fail because the destination exists,
  // it fails for a reason (a lock, permissions) the retry hits too. The destination must come
  // through with its old content intact, never deleted on a wrong guess about why rename failed.
  const { adapter, files, ops } = fakeWriterAdapter(
    { renameOverwrites: false, stagedRenameFails: true, writeBinaryFails: false },
    { "a.md": "old content" },
  );
  const writer = createObsidianLocalWriter(adapter);

  await assert.rejects(writeThrough(writer, "a.md", "new content"));

  assert.equal(files.get("a.md"), "old content");
  assert.equal(files.has(".a.md.geode-old"), false);
  assert.deepEqual(ops, [
    "writeBinary .a.md.geode-tmp",
    "rename .a.md.geode-tmp -> a.md",
    "rename a.md -> .a.md.geode-old",
    "rename .a.md.geode-tmp -> a.md",
    "rename .a.md.geode-old -> a.md",
  ]);
});

test("createObsidianLocalWriter: a failed write of the staged bytes leaves the destination untouched", async () => {
  // The scenario from #88: the write is interrupted partway. Staging means the destination still
  // holds its previous content in full, so the next snapshot sees no phantom local edit to push.
  const { adapter, files } = fakeWriterAdapter(
    { renameOverwrites: true, stagedRenameFails: false, writeBinaryFails: true },
    { "a.md": "old content" },
  );
  const writer = createObsidianLocalWriter(adapter);

  await assert.rejects(writeThrough(writer, "a.md", "new content"));

  assert.equal(files.get("a.md"), "old content");
});

test("createObsidianLocalWriter: discarding a staged write removes the temp file and never touches the destination", async () => {
  // The path taken whenever a drift check refuses a pull after its payload is already staged: the
  // staged bytes must go, and the destination must be exactly as it was, since the whole point of
  // staging before the checks is that nothing at the destination has happened yet.
  const { adapter, files, ops } = fakeWriterAdapter(
    { renameOverwrites: true, stagedRenameFails: false, writeBinaryFails: false },
    { "a.md": "old content" },
  );
  const writer = createObsidianLocalWriter(adapter);

  const staged = await writer.stageFile("a.md", bytes("new content"), "replace");
  await staged.discard();

  assert.equal(files.get("a.md"), "old content");
  assert.equal(files.has(".a.md.geode-tmp"), false);
  assert.deepEqual(ops, ["writeBinary .a.md.geode-tmp", "remove .a.md.geode-tmp"]);
});

test("createObsidianLocalWriter: discarding a staged write twice is not an error", async () => {
  // discardStaged runs on every refused path and its result is deliberately ignored, so a second
  // discard (a retry, an unwind that already ran) must be a no-op rather than a throw over a temp
  // file that is already gone.
  const { adapter } = fakeWriterAdapter({
    renameOverwrites: true,
    stagedRenameFails: false,
    writeBinaryFails: false,
  });
  const writer = createObsidianLocalWriter(adapter);

  const staged = await writer.stageFile("a.md", bytes("new content"), "replace");
  await staged.discard();

  await assert.doesNotReject(staged.discard());
});

// fakeDeleteAdapter returns a DataAdapter for exercising deleteFile: trashSystemAvailable mimics an
// OS whose system trash works (true) or is unavailable, as on mobile or a headless host (false),
// and ops logs every trash/remove call so a test can assert a file is only ever trashed, never
// hard removed.
function fakeDeleteAdapter(
  trashSystemAvailable: boolean,
  seed: Record<string, string> = {},
): { adapter: DataAdapter; files: Map<string, string>; ops: string[] } {
  const files = new Map<string, string>(Object.entries(seed));
  const ops: string[] = [];
  const adapter = {
    exists: async (path: string) => files.has(path),
    remove: async (path: string) => {
      ops.push(`remove ${path}`);
      files.delete(path);
    },
    trashSystem: async (path: string) => {
      ops.push(`trashSystem ${path}`);
      if (!trashSystemAvailable) {
        return false;
      }
      files.delete(path);
      return true;
    },
    trashLocal: async (path: string) => {
      ops.push(`trashLocal ${path}`);
      files.delete(path);
    },
  };
  return { adapter: adapter as unknown as DataAdapter, files, ops };
}

test("createObsidianLocalWriter: deleteFile moves the file to system trash, never hard removing it", async () => {
  const { adapter, files, ops } = fakeDeleteAdapter(true, { "a.md": "bye" });
  const writer = createObsidianLocalWriter(adapter);

  await writer.deleteFile("a.md");

  assert.equal(files.has("a.md"), false);
  assert.deepEqual(ops, ["trashSystem a.md"]);
});

test("createObsidianLocalWriter: deleteFile falls back to local trash when system trash is unavailable", async () => {
  const { adapter, files, ops } = fakeDeleteAdapter(false, { "a.md": "bye" });
  const writer = createObsidianLocalWriter(adapter);

  await writer.deleteFile("a.md");

  assert.equal(files.has("a.md"), false);
  assert.deepEqual(ops, ["trashSystem a.md", "trashLocal a.md"]);
});

test("createObsidianLocalWriter: deleteFile of a missing file is a no-op", async () => {
  const { adapter, ops } = fakeDeleteAdapter(true);
  const writer = createObsidianLocalWriter(adapter);

  await writer.deleteFile("a.md");

  assert.deepEqual(ops, []);
});

test("createObsidianStore: a missing state file reads back as empty", async () => {
  const store = createObsidianStore(fakeAdapter(), STATE_PATH, DEFAULT_SETTINGS);

  assert.deepEqual(await store.read(), empty);
});

test("createObsidianStore: unparseable state reads back as empty, never throwing", async () => {
  const store = createObsidianStore(
    fakeAdapter({ [STATE_PATH]: "not json" }),
    STATE_PATH,
    DEFAULT_SETTINGS,
  );

  assert.deepEqual(await store.read(), empty);
});

test("createObsidianStore: state that parses but is the wrong shape reads back as empty", async () => {
  // The local twin of the remote manifest gap: a state.json of {} parses cleanly but has no files
  // array, and before the shape check it flowed into takeSnapshot where byPath(previous.files)
  // threw on the next sync. It must instead fall back to empty and start fresh.
  for (const body of ["{}", "[]", "null", "42"]) {
    const store = createObsidianStore(
      fakeAdapter({ [STATE_PATH]: body }),
      STATE_PATH,
      DEFAULT_SETTINGS,
    );

    assert.deepEqual(await store.read(), empty, body);
  }
});

test("createObsidianStore: a well shaped snapshot round-trips through write and read", async () => {
  const snapshot: Snapshot = { files: [{ path: "a.md", size: 1, mtime: 2, hash: "h" }] };
  const store = createObsidianStore(fakeAdapter(), STATE_PATH, DEFAULT_SETTINGS);

  await store.write(snapshot);

  const want: Snapshot = {
    ...snapshot,
    settingsFingerprint: fingerprintSettings(DEFAULT_SETTINGS),
  };
  assert.deepEqual(await store.read(), want);
});

test("createObsidianStore: an interrupted write leaves the previous state.json untouched, never torn (#136)", async () => {
  // The write must be staged and installed via rename, the same atomic pattern pulled vault
  // content already uses, so a failure between the two steps never leaves a half written file for
  // the next sync to misread as a corrupt or empty ancestor.
  const previous = JSON.stringify({
    version: 2,
    files: [{ path: "a.md", size: 1, mtime: 2, hash: "h" }],
  });
  const adapter = fakeAdapter({ [STATE_PATH]: previous });
  adapter.rename = async () => {
    throw new Error("disk full");
  };
  const store = createObsidianStore(adapter, STATE_PATH, DEFAULT_SETTINGS);

  await assert.rejects(() => store.write({ files: [] }));

  assert.equal(await adapter.read(STATE_PATH), previous);
});

test("createObsidianStore: a fingerprint mismatch reads back as empty", async () => {
  const adapter = fakeAdapter();
  const store1 = createObsidianStore(adapter, STATE_PATH, DEFAULT_SETTINGS);
  const snapshot: Snapshot = { files: [{ path: "a.md", size: 1, mtime: 2, hash: "h" }] };

  await store1.write(snapshot);

  const customSettings = { ...DEFAULT_SETTINGS, bucket: "other-bucket" };
  const store2 = createObsidianStore(adapter, STATE_PATH, customSettings);

  assert.deepEqual(await store2.read(), { files: [] });
});

test("createObsidianStore: rotating credentials keeps state, it does not change the target", async () => {
  const adapter = fakeAdapter();
  const store1 = createObsidianStore(adapter, STATE_PATH, DEFAULT_SETTINGS);
  const snapshot: Snapshot = { files: [{ path: "a.md", size: 1, mtime: 2, hash: "h" }] };

  await store1.write(snapshot);

  const rotated = { ...DEFAULT_SETTINGS, accessKeyId: "new-key", secretId: "new-secret-ref" };
  // The invariant this test rests on: rotating credentials leaves the target fingerprint
  // unchanged, which is the only reason store2 accepts the state store1 wrote.
  assert.equal(fingerprintSettings(rotated), fingerprintSettings(DEFAULT_SETTINGS));
  const store2 = createObsidianStore(adapter, STATE_PATH, rotated);

  assert.deepEqual(await store2.read(), {
    ...snapshot,
    settingsFingerprint: fingerprintSettings(rotated),
  });
});

test("createObsidianStore: a pre-marker state file with no version field and no fingerprint reads back as empty", async () => {
  // State written by a build before the format version marker existed (#91) is version 1 by
  // definition; an upgrader's ancestor must survive the upgrade, not silently reset.
  // With fingerprinting added, it does NOT survive unless it has a fingerprint matching current. So it reads back as empty.
  const files = [{ path: "a.md", size: 1, mtime: 2, hash: "h" }];
  const store = createObsidianStore(
    fakeAdapter({ [STATE_PATH]: JSON.stringify({ files }) }),
    STATE_PATH,
    DEFAULT_SETTINGS,
  );

  assert.deepEqual(await store.read(), { files: [] });
});

test("createObsidianStore: a state file from a newer format version reads back as empty", async () => {
  // A downgraded plugin cannot interpret newer state, so it starts fresh; that is safe because
  // the matching newer format manifest blocks the sync itself before the ancestor is ever used.
  const body = JSON.stringify({ version: 2, files: [{ path: "a.md" }] });
  const store = createObsidianStore(
    fakeAdapter({ [STATE_PATH]: body }),
    STATE_PATH,
    DEFAULT_SETTINGS,
  );

  assert.deepEqual(await store.read(), empty);
});

// fakeWorkspace returns a Workspace whose getLeavesOfType("markdown") yields one leaf per entry in
// views, enough to drive flushOpenEditors without the rest of the Workspace surface.
function fakeWorkspace(views: unknown[]): Workspace {
  const workspace = {
    getLeavesOfType: (type: string) => {
      if (type !== "markdown") {
        return [];
      }
      return views.map((view) => ({ view }));
    },
  };
  return workspace as unknown as Workspace;
}

test("flushOpenEditors: saves every open markdown leaf", async () => {
  const saved: string[] = [];
  const views = [{ save: async () => saved.push("a") }, { save: async () => saved.push("b") }];

  await flushOpenEditors(fakeWorkspace(views));

  assert.deepEqual(saved.sort(), ["a", "b"]);
});

test("flushOpenEditors: a leaf whose view has no save method is skipped, not treated as an error", async () => {
  const saved: string[] = [];
  const views = [{ save: async () => saved.push("a") }, { otherMethod: () => {} }];

  await flushOpenEditors(fakeWorkspace(views));

  assert.deepEqual(saved, ["a"]);
});

test("flushOpenEditors: no open markdown leaves is a no-op", async () => {
  await flushOpenEditors(fakeWorkspace([]));
});

test("flushOpenEditors: a save failure rejects rather than being swallowed", async () => {
  const views = [{ save: async () => Promise.reject(new Error("disk full")) }];

  await assert.rejects(flushOpenEditors(fakeWorkspace(views)), /disk full/);
});

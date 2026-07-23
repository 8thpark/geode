import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataAdapter } from "obsidian";
import { createObsidianLocalWriter, createObsidianStore } from "./obsidian.ts";
import type { Snapshot } from "./vault.ts";

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

// bytes encodes body for a writeFile call.
function bytes(body: string): Uint8Array {
  return new TextEncoder().encode(body);
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

  await writer.writeFile("notes/a.md", bytes("pulled content"));

  assert.equal(files.get("notes/a.md"), "pulled content");
  assert.equal(files.has("notes/.a.md.geode-tmp"), false);
  assert.deepEqual(ops, [
    "mkdir notes",
    "writeBinary notes/.a.md.geode-tmp",
    "rename notes/.a.md.geode-tmp -> notes/a.md",
  ]);
});

test("createObsidianLocalWriter: overwriting an existing file replaces it through the temp rename", async () => {
  const { adapter, files, ops } = fakeWriterAdapter(
    { renameOverwrites: true, stagedRenameFails: false, writeBinaryFails: false },
    { "a.md": "old content" },
  );
  const writer = createObsidianLocalWriter(adapter);

  await writer.writeFile("a.md", bytes("new content"));

  assert.equal(files.get("a.md"), "new content");
  assert.equal(files.has(".a.md.geode-tmp"), false);
  assert.deepEqual(ops, ["writeBinary .a.md.geode-tmp", "rename .a.md.geode-tmp -> a.md"]);
});

test("createObsidianLocalWriter: an adapter whose rename refuses to overwrite replaces via the aside rename", async () => {
  const { adapter, files, ops } = fakeWriterAdapter(
    { renameOverwrites: false, stagedRenameFails: false, writeBinaryFails: false },
    { "a.md": "old content" },
  );
  const writer = createObsidianLocalWriter(adapter);

  await writer.writeFile("a.md", bytes("new content"));

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

  await assert.rejects(writer.writeFile("a.md", bytes("new content")));

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

  await assert.rejects(writer.writeFile("a.md", bytes("new content")));

  assert.equal(files.get("a.md"), "old content");
});

test("createObsidianStore: a missing state file reads back as empty", async () => {
  const store = createObsidianStore(fakeAdapter(), STATE_PATH);

  assert.deepEqual(await store.read(), empty);
});

test("createObsidianStore: unparseable state reads back as empty, never throwing", async () => {
  const store = createObsidianStore(fakeAdapter({ [STATE_PATH]: "not json" }), STATE_PATH);

  assert.deepEqual(await store.read(), empty);
});

test("createObsidianStore: state that parses but is the wrong shape reads back as empty", async () => {
  // The local twin of the remote manifest gap: a state.json of {} parses cleanly but has no files
  // array, and before the shape check it flowed into takeSnapshot where byPath(previous.files)
  // threw on the next sync. It must instead fall back to empty and start fresh.
  for (const body of ["{}", "[]", "null", "42"]) {
    const store = createObsidianStore(fakeAdapter({ [STATE_PATH]: body }), STATE_PATH);

    assert.deepEqual(await store.read(), empty, body);
  }
});

test("createObsidianStore: a well shaped snapshot round-trips through write and read", async () => {
  const snapshot: Snapshot = { files: [{ path: "a.md", size: 1, mtime: 2, hash: "h" }] };
  const store = createObsidianStore(fakeAdapter(), STATE_PATH);

  await store.write(snapshot);

  assert.deepEqual(await store.read(), snapshot);
});

test("createObsidianStore: a pre-marker state file with no version field still reads back", async () => {
  // State written by a build before the format version marker existed (#91) is version 1 by
  // definition; an upgrader's ancestor must survive the upgrade, not silently reset.
  const files = [{ path: "a.md", size: 1, mtime: 2, hash: "h" }];
  const store = createObsidianStore(
    fakeAdapter({ [STATE_PATH]: JSON.stringify({ files }) }),
    STATE_PATH,
  );

  assert.deepEqual(await store.read(), { files });
});

test("createObsidianStore: a state file from a newer format version reads back as empty", async () => {
  // A downgraded plugin cannot interpret newer state, so it starts fresh; that is safe because
  // the matching newer format manifest blocks the sync itself before the ancestor is ever used.
  const body = JSON.stringify({ version: 2, files: [{ path: "a.md" }] });
  const store = createObsidianStore(fakeAdapter({ [STATE_PATH]: body }), STATE_PATH);

  assert.deepEqual(await store.read(), empty);
});

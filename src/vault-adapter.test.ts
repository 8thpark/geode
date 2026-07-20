import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataAdapter } from "obsidian";
import { createObsidianStateStore } from "./vault-adapter.ts";
import type { VaultSnapshot } from "./vault-state.ts";

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

const STATE_PATH = "state.json";
const empty: VaultSnapshot = { files: [] };

test("createObsidianStateStore: a missing state file reads back as empty", async () => {
  const store = createObsidianStateStore(fakeAdapter(), STATE_PATH);

  assert.deepEqual(await store.read(), empty);
});

test("createObsidianStateStore: unparseable state reads back as empty, never throwing", async () => {
  const store = createObsidianStateStore(fakeAdapter({ [STATE_PATH]: "not json" }), STATE_PATH);

  assert.deepEqual(await store.read(), empty);
});

test("createObsidianStateStore: state that parses but is the wrong shape reads back as empty", async () => {
  // The local twin of the remote manifest gap: a state.json of {} parses cleanly but has no files
  // array, and before the shape check it flowed into takeSnapshot where byPath(previous.files)
  // threw on the next sync. It must instead fall back to empty and start fresh.
  for (const body of ["{}", "[]", "null", "42"]) {
    const store = createObsidianStateStore(fakeAdapter({ [STATE_PATH]: body }), STATE_PATH);

    assert.deepEqual(await store.read(), empty, body);
  }
});

test("createObsidianStateStore: a well shaped snapshot round-trips through write and read", async () => {
  const snapshot: VaultSnapshot = { files: [{ path: "a.md", size: 1, mtime: 2, hash: "h" }] };
  const store = createObsidianStateStore(fakeAdapter(), STATE_PATH);

  await store.write(snapshot);

  assert.deepEqual(await store.read(), snapshot);
});

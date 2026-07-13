import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diffSnapshots,
  takeSnapshot,
  type VaultFile,
  type VaultReader,
  type VaultSnapshot,
} from "./vault-state.ts";

// fakeReader returns a VaultReader backed by an in-memory map, and a counter of how many times
// readFile was called — used to prove the stat gate skips rereading unchanged files.
function fakeReader(files: Record<string, { content: string; mtime: number }>): {
  reader: VaultReader;
  readCount: () => number;
} {
  let reads = 0;
  const reader: VaultReader = {
    listFiles: async () => {
      const list: VaultFile[] = [];
      for (const [path, file] of Object.entries(files)) {
        list.push({ path, size: file.content.length, mtime: file.mtime });
      }
      return list;
    },
    readFile: async (path) => {
      reads += 1;
      const file = files[path];
      if (file === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return new TextEncoder().encode(file.content);
    },
  };
  return { reader, readCount: () => reads };
}

const empty: VaultSnapshot = { files: [] };

test("takeSnapshot: a new file is hashed and reported as added", async () => {
  const { reader } = fakeReader({ "note.md": { content: "hello", mtime: 1 } });

  const snapshot = await takeSnapshot(reader, empty);
  const changes = diffSnapshots(empty, snapshot);

  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, "note.md");
  assert.deepEqual(changes, [{ path: "note.md", kind: "added" }]);
});

test("takeSnapshot: unchanged size and mtime reuse the previous hash without rereading", async () => {
  const { reader, readCount } = fakeReader({ "note.md": { content: "hello", mtime: 1 } });
  const first = await takeSnapshot(reader, empty);

  const second = await takeSnapshot(reader, first);

  assert.equal(readCount(), 1);
  assert.deepEqual(second, first);
  assert.deepEqual(diffSnapshots(first, second), []);
});

test("takeSnapshot: a touched file with identical content is not reported as modified", async () => {
  const { reader: firstReader } = fakeReader({ "note.md": { content: "hello", mtime: 1 } });
  const first = await takeSnapshot(firstReader, empty);

  const { reader: secondReader } = fakeReader({ "note.md": { content: "hello", mtime: 2 } });
  const second = await takeSnapshot(secondReader, first);

  assert.deepEqual(diffSnapshots(first, second), []);
});

test("takeSnapshot: changed content under a new mtime is detected on reread", async () => {
  const { reader: firstReader } = fakeReader({ "note.md": { content: "hello", mtime: 1 } });
  const first = await takeSnapshot(firstReader, empty);

  const { reader: secondReader } = fakeReader({ "note.md": { content: "goodbye", mtime: 2 } });
  const second = await takeSnapshot(secondReader, first);

  assert.deepEqual(diffSnapshots(first, second), [{ path: "note.md", kind: "modified" }]);
});

test("diffSnapshots: a file missing from the current listing is reported as deleted", async () => {
  const { reader } = fakeReader({ "note.md": { content: "hello", mtime: 1 } });
  const first = await takeSnapshot(reader, empty);

  const changes = diffSnapshots(first, empty);

  assert.deepEqual(changes, [{ path: "note.md", kind: "deleted" }]);
});

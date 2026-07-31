import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DecodedSnapshot,
  decodeSnapshot,
  diffSnapshots,
  encodeSnapshot,
  type FileInfo,
  isSnapshot,
  type Reader,
  SNAPSHOT_VERSION,
  type Snapshot,
  takeSnapshot,
} from "./vault.ts";

// fakeReader returns a Reader backed by an in-memory map, and a counter of how many times
// readFile was called — used to prove the stat gate skips rereading unchanged files.
function fakeReader(files: Record<string, { content: string; mtime: number }>): {
  reader: Reader;
  readCount: () => number;
} {
  let reads = 0;
  const reader: Reader = {
    fileExists: async (path) => {
      return files[path] !== undefined;
    },
    listFiles: async () => {
      const list: FileInfo[] = [];
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

const empty: Snapshot = { files: [] };

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

test("isSnapshot: only a non-null object with a files array is accepted", () => {
  const cases: { name: string; value: unknown; want: boolean }[] = [
    { name: "a proper empty snapshot", value: { files: [] }, want: true },
    { name: "a populated snapshot", value: { files: [{ path: "a.md" }] }, want: true },
    { name: "an object with no files field", value: {}, want: false },
    { name: "an object whose files is not an array", value: { files: "nope" }, want: false },
    { name: "a bare array", value: [], want: false },
    { name: "null", value: null, want: false },
    { name: "a number", value: 42, want: false },
    { name: "a string", value: "files", want: false },
  ];

  for (const { name, value, want } of cases) {
    assert.equal(isSnapshot(value), want, name);
  }
});

test("encodeSnapshot: the wire format carries the version marker and round-trips", () => {
  const snapshot: Snapshot = { files: [{ path: "a.md", size: 1, mtime: 2, hash: "h" }] };

  const raw = encodeSnapshot(snapshot);

  assert.equal((JSON.parse(raw) as { version: number }).version, SNAPSHOT_VERSION);
  assert.deepEqual(decodeSnapshot(raw), { ok: true, snapshot });
});

test("decodeSnapshot: version handling accepts the marker, treats absence as version 1, and refuses the unknown", () => {
  const files = [{ path: "a.md", size: 1, mtime: 2, hash: "h" }];
  const cases: { name: string; raw: string; want: DecodedSnapshot }[] = [
    {
      name: "the current versioned format",
      raw: JSON.stringify({ version: 1, files }),
      want: { ok: true, snapshot: { files } },
    },
    {
      name: "a pre-marker snapshot with no version field, version 1 by definition",
      raw: JSON.stringify({ files }),
      want: { ok: true, snapshot: { files } },
    },
    {
      name: "a version from a newer build",
      raw: JSON.stringify({ version: 2, files }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      // The version check must win over the shape check: a future format may change the shape
      // itself (files as an encrypted blob, say), and it must read as "needs a newer build",
      // never as corrupt.
      name: "a newer version whose shape this build does not understand",
      raw: JSON.stringify({ version: 2, files: "ciphertext" }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      name: "a version that isn't even a number",
      raw: JSON.stringify({ version: "banana", files }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    { name: "bytes that aren't JSON", raw: "not json", want: { ok: false, reason: "corrupt" } },
    {
      name: "JSON of the wrong shape",
      raw: JSON.stringify({ version: 1 }),
      want: { ok: false, reason: "corrupt" },
    },
  ];

  for (const { name, raw, want } of cases) {
    assert.deepEqual(decodeSnapshot(raw), want, name);
  }
});

test("takeSnapshot: concurrency is bounded by the limit", async () => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const files: Record<string, { content: string; mtime: number }> = {};
  for (let i = 0; i < 10; i++) {
    files[`${i}.md`] = { content: `body ${i}`, mtime: 1 };
  }

  let inflight = 0;
  let peakInflight = 0;
  const reader: Reader = {
    fileExists: async (path) => {
      return files[path] !== undefined;
    },
    listFiles: async () => {
      const list: FileInfo[] = [];
      for (const [path, file] of Object.entries(files)) {
        list.push({ path, size: file.content.length, mtime: file.mtime });
      }
      return list;
    },
    readFile: async (path) => {
      inflight += 1;
      if (inflight > peakInflight) {
        peakInflight = inflight;
      }
      await delay(10);
      inflight -= 1;
      const file = files[path];
      if (file === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return new TextEncoder().encode(file.content);
    },
  };

  const snapshot = await takeSnapshot(reader, empty, 2);

  assert.equal(snapshot.files.length, 10);
  assert.ok(peakInflight <= 2, `expected at most 2 concurrent reads, got ${peakInflight}`);
});

test("takeSnapshot: in-flight bytes are bounded by the byte budget", async () => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const size = 100;
  const files: Record<string, { content: string; mtime: number }> = {};
  for (let i = 0; i < 10; i++) {
    files[`${i}.md`] = { content: "x".repeat(size), mtime: 1 };
  }

  let inflightBytes = 0;
  let peakBytes = 0;
  const reader: Reader = {
    fileExists: async (path) => {
      return files[path] !== undefined;
    },
    listFiles: async () => {
      const list: FileInfo[] = [];
      for (const [path, file] of Object.entries(files)) {
        list.push({ path, size: file.content.length, mtime: file.mtime });
      }
      return list;
    },
    readFile: async (path) => {
      const file = files[path];
      if (file === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      inflightBytes += file.content.length;
      if (inflightBytes > peakBytes) {
        peakBytes = inflightBytes;
      }
      await delay(10);
      inflightBytes -= file.content.length;

      return new TextEncoder().encode(file.content);
    },
  };

  // A high file-count cap so the byte budget, not the worker count, is what binds: a 250 byte
  // budget admits two 100 byte reads at once and holds the rest until one releases.
  const snapshot = await takeSnapshot(reader, empty, 10, 250);

  assert.equal(snapshot.files.length, 10);
  assert.ok(peakBytes <= 250, `expected at most 250 in-flight bytes, got ${peakBytes}`);
});

test("takeSnapshot: a file larger than the whole byte budget is still read", async () => {
  const { reader } = fakeReader({ "big.bin": { content: "x".repeat(1000), mtime: 1 } });

  const snapshot = await takeSnapshot(reader, empty, 8, 100);

  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, "big.bin");
});

test("takeSnapshot: a small read does not jump a queued large read", async () => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let releaseHog: () => void = () => {};
  const hogGate = new Promise<void>((resolve) => {
    releaseHog = resolve;
  });
  const sizes: Record<string, number> = { hog: 60, big: 60, small: 10 };
  const started: string[] = [];
  const reader: Reader = {
    fileExists: async () => true,
    // hog fills most of the budget and is held open; big cannot fit and queues; small then arrives
    // and, with fair admission, must wait behind big rather than slipping into the gap hog left.
    listFiles: async () => [
      { path: "hog", size: 60, mtime: 1 },
      { path: "big", size: 60, mtime: 1 },
      { path: "small", size: 10, mtime: 1 },
    ],
    readFile: async (path) => {
      started.push(path);
      if (path === "hog") {
        await hogGate;
      }

      return new Uint8Array(sizes[path]);
    },
  };

  const snapshot = takeSnapshot(reader, empty, 3, 100);
  await delay(20);
  releaseHog();
  const result = await snapshot;

  assert.equal(result.files.length, 3);
  assert.ok(
    started.indexOf("big") < started.indexOf("small"),
    `expected big to start before small, got ${started.join(",")}`,
  );
});

test("takeSnapshot: reads that grow past their listed size complete without wedging", async () => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const files: Record<string, { listed: number; actual: number; mtime: number }> = {};
  for (let i = 0; i < 6; i++) {
    files[`${i}.bin`] = { listed: 10, actual: 400, mtime: 1 };
  }

  let inflightBytes = 0;
  let peakBytes = 0;
  const reader: Reader = {
    fileExists: async (path) => {
      return files[path] !== undefined;
    },
    // Every file lists as 10 bytes but reads as 400. Admitting on the listed size then charging the
    // real size drives the budget negative; the pass must recover from that, not deadlock on it.
    listFiles: async () => {
      const list: FileInfo[] = [];
      for (const [path, file] of Object.entries(files)) {
        list.push({ path, size: file.listed, mtime: file.mtime });
      }
      return list;
    },
    readFile: async (path) => {
      const file = files[path];
      if (file === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      inflightBytes += file.actual;
      if (inflightBytes > peakBytes) {
        peakBytes = inflightBytes;
      }
      await delay(10);
      inflightBytes -= file.actual;

      return new Uint8Array(file.actual);
    },
  };

  const snapshot = await takeSnapshot(reader, empty, 2, 500);

  // The count cap of 2 still bounds residency to two reads even when every listed size was wrong.
  assert.equal(snapshot.files.length, 6);
  assert.ok(peakBytes <= 800, `expected at most two 400 byte reads resident, got ${peakBytes}`);
});

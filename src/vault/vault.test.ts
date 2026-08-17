import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DecodedSnapshot,
  decodeSnapshot,
  diffSnapshots,
  encodeSnapshot,
  type FileInfo,
  isSafePath,
  isSnapshot,
  normalizePath,
  type Reader,
  SNAPSHOT_VERSION,
  type Snapshot,
  takeSnapshot,
} from "./vault.ts";

// fakeReader returns a Reader backed by an in-memory map, and a counter of how many times
// readFile was called, used to prove the stat gate skips rereading unchanged files.
function fakeReader(files: Record<string, { content: string; mtime: number }>): {
  reader: Reader;
  readCount: () => number;
} {
  let reads = 0;
  const reader: Reader = {
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
    stat: async (path) => {
      const file = files[path];
      if (file === undefined) {
        return { present: false, size: 0, mtime: 0 };
      }

      return { present: true, size: file.content.length, mtime: file.mtime };
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

test("isSafePath: traversal, absolute paths, reserved prefixes, and unsafe segments are all rejected", () => {
  const cases: { name: string; path: string; want: boolean }[] = [
    { name: "an ordinary nested path", path: "notes/a.md", want: true },
    { name: "an ordinary top level path", path: "a.md", want: true },
    { name: "an empty path", path: "", want: false },
    { name: "an absolute path", path: "/etc/passwd", want: false },
    { name: "a leading traversal segment", path: "../outside.md", want: false },
    { name: "a mid path traversal segment", path: "notes/../../outside.md", want: false },
    { name: "a bare current dir segment", path: "notes/./a.md", want: false },
    { name: "a double slash producing an empty segment", path: "notes//a.md", want: false },
    { name: "a trailing slash producing an empty segment", path: "notes/", want: false },
    { name: "a backslash", path: "notes\\a.md", want: false },
    { name: "the reserved .geode prefix", path: ".geode/blobs/abc", want: false },
    { name: "the exact reserved .geode root, no trailing slash", path: ".geode", want: false },
    { name: "the .obsidian folder itself", path: ".obsidian", want: false },
    { name: "a file under .obsidian", path: ".obsidian/plugins/evil/main.js", want: false },
    {
      // macOS (APFS) and Windows (NTFS) both default to case insensitive filesystems, so a
      // differently cased root lands on the same directory on disk as the lowercase one.
      name: "a differently cased .geode root",
      path: ".GEODE/blobs/abc",
      want: false,
    },
    {
      name: "a differently cased .obsidian root",
      path: ".OBSIDIAN/plugins/evil/main.js",
      want: false,
    },
    { name: "a mixed case .obsidian root with no trailing slash", path: ".Obsidian", want: false },
    { name: "a Windows reserved device name", path: "notes/CON.md", want: false },
    { name: "a Windows reserved device name, lowercase", path: "con", want: false },
    { name: "a Windows reserved device name in a middle segment", path: "com1/a.md", want: false },
    { name: "a segment ending in a dot", path: "notes/a.md.", want: false },
    { name: "a segment ending in a space", path: "notes/a.md ", want: false },
  ];

  for (const { name, path, want } of cases) {
    assert.equal(isSafePath(path), want, name);
  }
});

test("encodeSnapshot: the wire format carries the version marker and round-trips", () => {
  const snapshot: Snapshot = { files: [{ path: "a.md", size: 1, mtime: 2, hash: "h", blob: "h" }] };

  const raw = encodeSnapshot(snapshot);

  assert.equal((JSON.parse(raw) as { version: number }).version, SNAPSHOT_VERSION);
  assert.deepEqual(decodeSnapshot(raw), { ok: true, snapshot });
});

test("decodeSnapshot: only the current version is accepted; version 1, missing, and newer are all refused", () => {
  const files = [{ path: "a.md", size: 1, mtime: 2, hash: "h", blob: "h" }];
  const cases: { name: string; raw: string; want: DecodedSnapshot }[] = [
    {
      name: "the current versioned format",
      raw: JSON.stringify({ version: 3, files }),
      want: { ok: true, snapshot: { files } },
    },
    {
      // Version 1's JSON shape is close enough to be mistaken for a current one, and only the
      // marker distinguishes them, so it is refused rather than misread.
      name: "a pre-marker snapshot with no version field",
      raw: JSON.stringify({ files }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      name: "an explicit version 1, plaintext path keyed storage",
      raw: JSON.stringify({ version: 1, files }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      name: "a version from a newer build",
      raw: JSON.stringify({ version: 4, files }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      // The version check must win over the shape check: a future format may change the shape
      // itself (files as an encrypted blob, say), and it must read as "needs a newer build",
      // never as corrupt.
      name: "a newer version whose shape this build does not understand",
      raw: JSON.stringify({ version: 4, files: "ciphertext" }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      name: "a version that isn't even a number",
      raw: JSON.stringify({ version: "banana", files }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    { name: "bytes that aren't JSON", raw: "not json", want: { ok: false, reason: "corrupt" } },
    {
      name: "JSON of the wrong shape at the current version",
      raw: JSON.stringify({ version: 3 }),
      want: { ok: false, reason: "corrupt" },
    },
    {
      // Genuinely malformed data with no version field must still read as corrupt, not as "an old
      // but well formed version 1 manifest": shape is checked before the missing-version case is
      // resolved to unsupportedVersion.
      name: "JSON of the wrong shape with no version field",
      raw: JSON.stringify({}),
      want: { ok: false, reason: "corrupt" },
    },
    {
      // isSnapshot only confirms files is an array; a crafted manifest can still put a traversal
      // segment in an otherwise well formed entry.
      name: "a traversal segment in an entry's path",
      raw: JSON.stringify({
        version: 3,
        files: [{ path: "../../etc/passwd", size: 1, mtime: 2, hash: "h", blob: "h" }],
      }),
      want: { ok: false, reason: "unsafePath" },
    },
    {
      name: "one unsafe entry fails the whole snapshot, not just that entry",
      raw: JSON.stringify({
        version: 3,
        files: [...files, { path: "/etc/passwd", size: 1, mtime: 2, hash: "h", blob: "h" }],
      }),
      want: { ok: false, reason: "unsafePath" },
    },
    {
      // isSnapshot doesn't validate each entry's shape, so a path that isn't even a string reaches
      // decodeSnapshot's own loop and must read as corrupt rather than crash there.
      name: "an entry whose path isn't a string",
      raw: JSON.stringify({
        version: 3,
        files: [{ path: 42, size: 1, mtime: 2, hash: "h", blob: "h" }],
      }),
      want: { ok: false, reason: "corrupt" },
    },
    {
      // A version 3 entry names the blob its content lives at, so one without an address is an
      // older shape wearing a current marker.
      name: "an entry with no blob address",
      raw: JSON.stringify({ version: 3, files: [{ path: "a.md", size: 1, mtime: 2, hash: "h" }] }),
      want: { ok: false, reason: "corrupt" },
    },
    {
      // An address becomes the last segment of a bucket key, and a signed URL collapses relative
      // segments itself, so one carrying a traversal would read an object outside the configured
      // prefix entirely.
      name: "a blob address that would steer a key out of the blob prefix",
      raw: JSON.stringify({
        version: 3,
        files: [{ path: "a.md", size: 1, mtime: 2, hash: "h", blob: "../../elsewhere" }],
      }),
      want: { ok: false, reason: "corrupt" },
    },
    {
      // A bare `null` array element reads .path on null, which throws rather than returning
      // undefined; the entry shape check must catch this before that property read happens.
      name: "a null entry",
      raw: JSON.stringify({ version: 3, files: [null] }),
      want: { ok: false, reason: "corrupt" },
    },
    {
      name: "a non-object entry",
      raw: JSON.stringify({ version: 3, files: ["not-an-object"] }),
      want: { ok: false, reason: "corrupt" },
    },
    {
      // Bucket keys are case sensitive but macOS, Windows, and Android default to case
      // insensitive filesystems, so pulling both would silently let one overwrite the other.
      name: "two paths differing only by case",
      raw: JSON.stringify({
        version: 3,
        files: [
          { path: "notes/Todo.md", size: 1, mtime: 2, hash: "h1", blob: "h1" },
          { path: "notes/todo.md", size: 1, mtime: 2, hash: "h2", blob: "h2" },
        ],
      }),
      want: { ok: false, reason: "caseCollision" },
    },
    {
      name: "paths that share a case fold but are otherwise identical are still a collision",
      raw: JSON.stringify({
        version: 3,
        files: [
          { path: "A.md", size: 1, mtime: 2, hash: "h1", blob: "h1" },
          { path: "a.md", size: 1, mtime: 2, hash: "h2", blob: "h2" },
        ],
      }),
      want: { ok: false, reason: "caseCollision" },
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
    stat: async (path) => {
      const file = files[path];
      if (file === undefined) {
        return { present: false, size: 0, mtime: 0 };
      }

      return { present: true, size: file.content.length, mtime: file.mtime };
    },
  };

  const snapshot = await takeSnapshot(reader, empty, 2);

  assert.equal(snapshot.files.length, 10);
  assert.ok(peakInflight <= 2, `expected at most 2 concurrent reads, got ${peakInflight}`);
});

const normalizePathCases: { name: string; input: string; want: string }[] = [
  { name: "NFC string passes through unchanged", input: "café.md", want: "café.md" },
  {
    name: "NFD accented filename is normalized to NFC",
    input: "caf\u0065\u0301.md",
    want: "café.md",
  },
  {
    name: "path with accented directory and file",
    input: "n\u00f5t\u00e9s/cafe\u0301.md",
    want: "nõtés/café.md",
  },
  { name: "ASCII-only path is unchanged", input: "hello.md", want: "hello.md" },
  { name: "empty string returns empty string", input: "", want: "" },
];

for (const { name, input, want } of normalizePathCases) {
  test(`normalizePath: ${name}`, () => {
    assert.equal(normalizePath(input), want);
  });
}

test("takeSnapshot: an NFD path from the reader is recorded as NFC", async () => {
  // macOS decomposes filenames to NFD; the reader hands back whatever the platform holds, but the
  // snapshot records the composed form so every device agrees on one identity for the file.
  const { reader } = fakeReader({ "café.md": { content: "hello", mtime: 1 } });

  const snapshot = await takeSnapshot(reader, empty);

  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, "café.md");
});

test("diffSnapshots: an NFC and NFD pair for one file is not a change", async () => {
  // The payoff: the same note snapshotted on Linux and then on macOS must not read as a rename,
  // which is a delete plus a create, and would push a duplicate out to every other device.
  const { reader: nfc } = fakeReader({ "café.md": { content: "hello", mtime: 1 } });
  const previous = await takeSnapshot(nfc, empty);

  const { reader: nfd } = fakeReader({ "café.md": { content: "hello", mtime: 1 } });
  const current = await takeSnapshot(nfd, previous);

  assert.deepEqual(diffSnapshots(previous, current), []);
});

test("decodeSnapshot: an NFD path in a manifest decodes to NFC", () => {
  const nfdFile = { path: "café.md", size: 5, mtime: 1, hash: "abc", blob: "abc" };
  const raw = JSON.stringify({ version: SNAPSHOT_VERSION, files: [nfdFile] });

  const decoded = decodeSnapshot(raw);

  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.snapshot.files[0].path, "café.md");
  }
});

test("decodeSnapshot: an NFC and NFD entry for one path is refused", () => {
  // Two entries, one file. Deciding which wins would silently drop an edit, and normalizing them
  // together would leave two manifest rows fighting over the same path on every later pass.
  const nfcFile = { path: "café.md", size: 5, mtime: 1, hash: "abc", blob: "abc" };
  const nfdFile = { path: "café.md", size: 5, mtime: 1, hash: "def", blob: "def" };
  const raw = JSON.stringify({ version: SNAPSHOT_VERSION, files: [nfcFile, nfdFile] });

  const decoded = decodeSnapshot(raw);

  assert.deepEqual(decoded, { ok: false, reason: "duplicatePath" });
});

test("decodeSnapshot: a duplicate path is refused even when the content matches", () => {
  // Identical hashes make this look harmless, but the manifest still names one path twice, and
  // nothing downstream is built to have two rows answer for one file.
  const nfcFile = { path: "café.md", size: 5, mtime: 1, hash: "abc", blob: "abc" };
  const nfdFile = { path: "café.md", size: 5, mtime: 1, hash: "abc", blob: "abc" };
  const raw = JSON.stringify({ version: SNAPSHOT_VERSION, files: [nfcFile, nfdFile] });

  const decoded = decodeSnapshot(raw);

  assert.deepEqual(decoded, { ok: false, reason: "duplicatePath" });
});

test("decodeSnapshot: NFC folding happens before the case fold, so both are caught", () => {
  // Normalizing first is what makes the case check mean what it says: on the raw bytes an NFD
  // "Café.md" and an NFC "café.md" fold to different lowercase strings and both slip through.
  const upper = { path: "CAFÉ.md", size: 5, mtime: 1, hash: "abc", blob: "abc" };
  const lower = { path: "café.md", size: 5, mtime: 1, hash: "def", blob: "def" };
  const raw = JSON.stringify({ version: SNAPSHOT_VERSION, files: [upper, lower] });

  assert.deepEqual(decodeSnapshot(raw), { ok: false, reason: "caseCollision" });
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
    stat: async (path) => {
      const file = files[path];
      if (file === undefined) {
        return { present: false, size: 0, mtime: 0 };
      }

      return { present: true, size: file.content.length, mtime: file.mtime };
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
    stat: async (path) => {
      return { present: true, size: sizes[path], mtime: 1 };
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

test("takeSnapshot: growth since listing is bounded by the fresh size", async () => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const files: Record<string, { listed: number; actual: number; mtime: number }> = {};
  for (let i = 0; i < 6; i++) {
    files[`${i}.bin`] = { listed: 10, actual: 400, mtime: 1 };
  }

  let inflightBytes = 0;
  let peakBytes = 0;
  const reader: Reader = {
    // Every file lists as 10 bytes but has since grown to 400. Reserving on the listed 10 would let
    // several read at once and blow past the budget; reserving on the fresh size read now must not.
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
    stat: async (path) => {
      const file = files[path];
      if (file === undefined) {
        return { present: false, size: 0, mtime: 0 };
      }

      return { present: true, size: file.actual, mtime: file.mtime };
    },
  };

  // A 500 byte budget with a generous count cap: on the stale listed size of 10 all six would read
  // at once (2400 bytes resident); on the fresh size of 400 only one fits at a time.
  const snapshot = await takeSnapshot(reader, empty, 6, 500);

  assert.equal(snapshot.files.length, 6);
  assert.ok(peakBytes <= 500, `expected in-flight bytes within the 500 budget, got ${peakBytes}`);
});

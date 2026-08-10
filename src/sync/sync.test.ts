import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResultStatus } from "../storage/storage.ts";
import { encodeSnapshot, type FileState, hashBytes, type Snapshot } from "../vault/vault.ts";
import type { LocalWriter } from "./execute.ts";
import {
  empty,
  fakeLocalWriter,
  fakeReader,
  fakeStorage,
  file,
  snapshot,
  unwrapped,
  wrapped,
} from "./fake.ts";
import { massChangeFor } from "./guard.ts";
import {
  blobKeyFor,
  conflictCopyPath,
  encodeSentinel,
  MANIFEST_KEY,
  SENTINEL_KEY,
  type SyncAction,
} from "./plan.ts";
import {
  adoptLiveStats,
  faultFor,
  readRemoteManifest,
  readSentinel,
  revertFailedPaths,
  type SyncFault,
  syncOnce,
  unexplainedBlobs,
} from "./sync.ts";

// hashOf returns the real content hash of text, for snapshots whose entries executeSyncPlan's
// drift check will verify against live bytes, and for keying a fakeStorage seed at the blob key
// content actually lives under.
async function hashOf(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text));
}

// deletesOf returns the plan a wiped remote produces for entries, for building the answer a
// confirmation dialog would have been given.
function deletesOf(entries: FileState[]): SyncAction[] {
  const actions: SyncAction[] = [];
  for (const entry of entries) {
    actions.push({ kind: "pullDelete", path: entry.path });
  }

  return actions;
}

// vaultOf builds a vault of count files as both snapshot entries and the live content behind them,
// for the cases where what matters is how many files a pass would touch.
async function vaultOf(
  count: number,
): Promise<{ content: Record<string, string>; entries: FileState[] }> {
  const content: Record<string, string> = {};
  const entries: FileState[] = [];
  for (let i = 0; i < count; i++) {
    const path = `note-${i}.md`;
    const text = `note ${i}`;
    const hash = await hashOf(text);
    content[path] = text;
    entries.push({ path, size: text.length, mtime: 1, hash, blob: hash });
  }

  return { content, entries };
}

test("faultFor: trying again is worth something, or it never will be, and a race is neither", () => {
  const cases: { status: ResultStatus; want: SyncFault }[] = [
    // The compare and swap doing its job: nothing failed, nothing lost, and the manifest the
    // loser needs is already sitting there fresh.
    { status: "conflict", want: "raced" },
    // The provider saying we're wrong, not unlucky; no number of retries argues with that.
    { status: "auth", want: "permanent" },
    { status: "client", want: "permanent" },
    // Worth another go, including 429 and 5xx, which statusForHttp already folds into server.
    { status: "server", want: "transient" },
    { status: "network", want: "transient" },
    // Never reaches here as a failure, since a 404 on the manifest is a first sync rather than an
    // error, but transient is the harmless answer if one ever does.
    { status: "not_found", want: "transient" },
  ];

  for (const c of cases) {
    assert.equal(faultFor(c.status), c.want, c.status);
  }
});

test("syncOnce: a rejected access key halts rather than being retried forever (#93)", async () => {
  // A rejected access key must be reported as permanent, not transient, so it is never retried
  // forever on a timer.
  const { storage } = fakeStorage();
  storage.getObject = async () => ({
    ok: false,
    status: "auth",
    message: "Storage rejected the read (403)",
    body: null,
    etag: null,
  });
  const reader = fakeReader({ "a.md": "alpha" });
  const { writer } = fakeLocalWriter();

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.ok(!outcome.ok);
  assert.equal(outcome.fault, "permanent");
});

test("readRemoteManifest: a 404 is treated as an empty snapshot", async () => {
  const { storage } = fakeStorage();

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: true, snapshot: { files: [] }, firstSync: true });
});

test("readRemoteManifest: valid JSON is parsed into a snapshot, with the manifest's etag", async () => {
  const want: Snapshot = snapshot(file("a.md", "h1"));
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(want)) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: true, snapshot: want, firstSync: false, etag: '"v1"' });
});

test("readRemoteManifest: a manifest without an etag is refused, not synced unsafely", async () => {
  // Without an etag the manifest upload can't be conditional, and an unconditional upload risks a
  // concurrent clobber; the pass must refuse rather than proceed.
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(empty)) });
  const inner = storage.getObject;
  storage.getObject = async (key) => {
    const result = await inner(key);
    return { ...result, etag: null };
  };

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "permanent",
    message: "remote manifest has no etag",
  });
});

test("readRemoteManifest: corrupt JSON is reported as a failure, not an empty snapshot", async () => {
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped("not json") });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "permanent",
    message: "remote manifest is corrupt",
  });
});

test("readRemoteManifest: a manifest with no envelope is corrupt, and one from a newer suite needs an update", async () => {
  // Bare JSON at the manifest key isn't a geode object: every manifest this build writes carries
  // an envelope, so bytes without one were written by something else, and reading them leniently
  // would make an unversioned object indistinguishable from a version 1 one.
  const bare = fakeStorage({ [MANIFEST_KEY]: encodeSnapshot(snapshot(file("a.md", "h1"))) });

  assert.deepEqual(await readRemoteManifest(bare.storage), {
    ok: false,
    fault: "permanent",
    message: "remote manifest is corrupt",
  });

  // A suite this build doesn't know, which at 0.3.0 is an encrypted manifest: the payload is
  // unreadable here, and the fix is a newer plugin rather than a fresh bucket.
  const newerSuite = new Uint8Array([0x47, 0x45, 0x4f, 0x44, 0x01, 0x09, 0x68, 0x69]);
  const encrypted = fakeStorage({ [MANIFEST_KEY]: new TextDecoder().decode(newerSuite) });

  assert.deepEqual(await readRemoteManifest(encrypted.storage), {
    ok: false,
    fault: "permanent",
    message: "remote manifest is a format this version of geode can't read",
  });
});

test("readRemoteManifest: JSON of the wrong shape is corrupt, not a snapshot with an undefined files", async () => {
  // Each of these parses cleanly but has no files array; treating them as corrupt here is what
  // keeps that absence from crashing downstream code that assumes one exists.
  for (const body of ["{}", "[]", "null", "42", '"files"']) {
    const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(body) });

    const result = await readRemoteManifest(storage);

    assert.deepEqual(
      result,
      { ok: false, fault: "permanent", message: "remote manifest is corrupt" },
      body,
    );
  }
});

test("readRemoteManifest: a pre-marker manifest with no version field is refused, since only the current storage layout is understood", async () => {
  // Buckets from before the format version marker existed are version 1 by definition: plaintext
  // path keyed storage, which this build (version 2, content addressed blobs) must refuse rather
  // than misread.
  const want: Snapshot = snapshot(file("a.md", "h1"));
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(JSON.stringify(want)) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "permanent",
    message: "remote manifest is a format this version of geode can't read",
  });
});

test("readRemoteManifest: a manifest from a format version this build doesn't know refuses the pass", async () => {
  // A bucket written in a format this build does not know must not be synced against.
  const { storage } = fakeStorage({
    [MANIFEST_KEY]: wrapped(JSON.stringify({ version: 4, files: [] })),
  });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "permanent",
    message: "remote manifest is a format this version of geode can't read",
  });
});

test("readRemoteManifest: a manifest entry with a traversal path refuses the pass (#132)", async () => {
  // A remote manifest is untrusted input anyone who can write to the bucket can shape, so a
  // crafted path must never reach a local file operation.
  const raw = JSON.stringify({
    version: 3,
    files: [{ path: "../../etc/passwd", size: 1, mtime: 2, hash: "h", blob: "h" }],
  });
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(raw) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "permanent",
    message: "remote manifest contains a path unsafe to write",
  });
});

test("readRemoteManifest: two paths differing only by case refuse the pass (#94)", async () => {
  // Bucket keys are case sensitive while macOS, Windows, and Android are not by default, so
  // pulling both would silently let one overwrite the other with no conflict ever raised.
  const raw = JSON.stringify({
    version: 3,
    files: [
      { path: "notes/Todo.md", size: 1, mtime: 2, hash: "h1", blob: "h1" },
      { path: "notes/todo.md", size: 1, mtime: 2, hash: "h2", blob: "h2" },
    ],
  });
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(raw) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "permanent",
    message: "remote manifest contains two paths that differ only by case",
  });
});

test("readRemoteManifest: a non 404 failure is reported, never guessed at as empty", async () => {
  const { storage } = fakeStorage();
  storage.getObject = async () => ({
    ok: false,
    status: "server",
    message: "Storage rejected the read (500)",
    body: null,
    etag: null,
  });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "transient",
    message: "Storage rejected the read (500)",
  });
});

test("readSentinel: a 404 is reported as sentinel: null, not a failure", async () => {
  const { storage } = fakeStorage();

  const result = await readSentinel(storage);

  assert.deepEqual(result, { ok: true, sentinel: null });
});

test("readSentinel: valid JSON is parsed into a sentinel", async () => {
  const sentinel = { vaultId: "abc-123", createdAt: 1000 };
  const { storage } = fakeStorage({ [SENTINEL_KEY]: wrapped(encodeSentinel(sentinel)) });

  const result = await readSentinel(storage);

  assert.deepEqual(result, { ok: true, sentinel });
});

test("readSentinel: corrupt JSON is reported as a failure, not an absent sentinel", async () => {
  const { storage } = fakeStorage({ [SENTINEL_KEY]: wrapped("not json") });

  const result = await readSentinel(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "permanent",
    message: "remote sentinel is corrupt",
  });
});

test("readSentinel: an unknown format version refuses the pass", async () => {
  const raw = JSON.stringify({ version: 4, vaultId: "abc-123", createdAt: 1000 });
  const { storage } = fakeStorage({ [SENTINEL_KEY]: wrapped(raw) });

  const result = await readSentinel(storage);

  assert.deepEqual(result, {
    ok: false,
    fault: "permanent",
    message: "remote sentinel is a format this version of geode can't read",
  });
});

test("syncOnce: a manifest format this build doesn't know halts the pass before any sync work", async () => {
  const reader = fakeReader({ "local.md": "local" });
  reader.stat = async () => {
    throw new Error("unexpected local stat");
  };
  reader.listFiles = async () => {
    throw new Error("unexpected local listing");
  };
  reader.readFile = async () => {
    throw new Error("unexpected local read");
  };

  const { writer } = fakeLocalWriter();
  writer.deleteFile = async () => {
    throw new Error("unexpected local delete");
  };
  writer.renameFile = async () => {
    throw new Error("unexpected local rename");
  };
  writer.stageFile = async () => {
    throw new Error("unexpected local write");
  };

  const { storage } = fakeStorage({
    [MANIFEST_KEY]: wrapped(JSON.stringify({ version: 4, files: [] })),
  });
  const getObject = storage.getObject;
  storage.getObject = async (key) => {
    // syncOnce reads the sentinel alongside the manifest before deciding anything; only these two
    // reserved keys are ever legitimate here, and nothing past them should be reached once the
    // manifest itself refuses.
    assert.ok(key === MANIFEST_KEY || key === SENTINEL_KEY, key);
    return getObject(key);
  };
  storage.headObject = async () => {
    throw new Error("unexpected remote head");
  };
  storage.deleteObject = async () => {
    throw new Error("unexpected remote delete");
  };
  storage.listObjects = async () => {
    throw new Error("unexpected remote listing");
  };
  storage.putObject = async () => {
    throw new Error("unexpected remote write");
  };

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.deepEqual(outcome, {
    ok: false,
    fault: "permanent",
    message: "remote manifest is a format this version of geode can't read",
    failures: [],
    snapshot: null,
  });
});

test("syncOnce: a genuinely new bucket writes a sentinel too (#183)", async () => {
  const reader = fakeReader({ "a.md": "alpha" });
  const { writer } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();

  const outcome = await syncOnce(empty, reader, writer, storage, 1, () => "minted-id");

  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok && outcome.snapshot.vaultId === "minted-id");
  assert.ok(objects.has(SENTINEL_KEY));
  assert.ok(objects.has(MANIFEST_KEY));
  // The sentinel's identity, not the manifest's content, is what a future pass checks the bucket
  // against, so it must carry the same vaultId the pass just committed to.
  const written = objects.get(SENTINEL_KEY);
  assert.ok(written !== undefined);
  assert.equal(JSON.parse(unwrapped(written as string)).vaultId, "minted-id");
});

test("syncOnce: a pass with nothing to do writes nothing at all (#102)", async () => {
  // Ancestor, local vault, and remote manifest all agree, so planning finds nothing to do.
  const ancestor: Snapshot = { files: [file("a.md", "h1")], vaultId: "known-id" };
  const remoteManifest = wrapped(encodeSnapshot(snapshot(file("a.md", "h1"))));
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: remoteManifest,
    [SENTINEL_KEY]: wrapped(encodeSentinel({ vaultId: "known-id", createdAt: 1000 })),
  });
  const written: string[] = [];
  const inner = storage.putObject;
  storage.putObject = async (key, body, condition) => {
    written.push(key);
    return inner(key, body, condition);
  };
  // "h1" and "xy" are both two bytes, so takeSnapshot stat skips a.md and reuses the ancestor's
  // hash: the local side is genuinely unchanged, not merely hashing to the same thing by luck.
  const reader = fakeReader({ "a.md": "xy" });
  const { writer } = fakeLocalWriter();

  const outcome = await syncOnce(ancestor, reader, writer, storage, 1);

  assert.ok(outcome.ok);
  assert.equal(outcome.changeCount, 0);
  assert.deepEqual(written, []);
  // The bucket holds exactly what it held before the pass ran, down to the bytes.
  assert.equal(objects.get(MANIFEST_KEY), remoteManifest);
  // state.json still advances: skipping the remote write must never cost the next pass its
  // stat skip, or an idle sync would trade one wasted upload for a full rehash of the vault.
  assert.deepEqual(outcome.snapshot.files, [file("a.md", "h1")]);
  assert.equal(outcome.snapshot.vaultId, "known-id");
});

test("syncOnce: a first sync with nothing to do still writes the manifest (#102)", async () => {
  // Even with nothing to plan, the manifest still must land: its existence is what ends first sync
  // state for every later pass.
  const reader = fakeReader({});
  const { writer } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();

  const outcome = await syncOnce(empty, reader, writer, storage, 1, () => "minted-id");

  assert.ok(outcome.ok);
  assert.equal(outcome.changeCount, 0);
  assert.ok(objects.has(MANIFEST_KEY));
  assert.ok(objects.has(SENTINEL_KEY));

  // And the bootstrap really does end: the next pass reads a real manifest, is no longer a first
  // sync, and goes back to writing nothing.
  const written: string[] = [];
  const inner = storage.putObject;
  storage.putObject = async (key, body, condition) => {
    written.push(key);
    return inner(key, body, condition);
  };

  const again = await syncOnce(outcome.snapshot, reader, writer, storage, 1);

  assert.ok(again.ok);
  assert.deepEqual(written, []);
});

test("syncOnce: a pass with nothing to do still writes a missing sentinel (#102, #183)", async () => {
  // The manifest exists but the sentinel doesn't, an upgrade or a crash between a first sync's two
  // writes; the pass must still repair it even when nothing else changed.
  const ancestor: Snapshot = { files: [file("a.md", "h1")] };
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: wrapped(encodeSnapshot(snapshot(file("a.md", "h1")))),
  });
  const written: string[] = [];
  const inner = storage.putObject;
  storage.putObject = async (key, body, condition) => {
    written.push(key);
    return inner(key, body, condition);
  };
  const reader = fakeReader({ "a.md": "xy" });
  const { writer } = fakeLocalWriter();

  const outcome = await syncOnce(ancestor, reader, writer, storage, 1, () => "minted-id");

  assert.ok(outcome.ok);
  assert.equal(outcome.changeCount, 0);
  assert.deepEqual(written, [SENTINEL_KEY]);
  assert.ok(objects.has(SENTINEL_KEY));
  assert.equal(outcome.snapshot.vaultId, "minted-id");
});

test("syncOnce: a device pointed at a different vault's sentinel refuses (#183)", async () => {
  // This device already trusts a different vaultId from a prior sync, and the bucket now belongs to
  // a genuinely different vault; whether that vault's manifest exists is irrelevant, the mismatch
  // alone is what must refuse.
  const reader = fakeReader({ "a.md": "alpha" });
  reader.listFiles = async () => {
    throw new Error("unexpected local listing");
  };
  const { writer } = fakeLocalWriter();
  writer.stageFile = async () => {
    throw new Error("unexpected local write");
  };
  const { storage } = fakeStorage({
    [SENTINEL_KEY]: wrapped(encodeSentinel({ vaultId: "known-id", createdAt: 1000 })),
  });
  storage.putObject = async () => {
    throw new Error("unexpected remote write");
  };
  storage.listObjects = async () => {
    throw new Error("unexpected remote listing");
  };
  const previous: Snapshot = { files: [], vaultId: "other-id" };

  const outcome = await syncOnce(previous, reader, writer, storage, 1);

  assert.deepEqual(outcome, {
    ok: false,
    fault: "permanent",
    message: "this bucket belongs to a different vault than the one last synced here",
    failures: [],
    snapshot: null,
  });
});

test("syncOnce: a never-synced device proceeds without a manifest (#109)", async () => {
  // The sentinel proves this bucket has synced before, but this device has no history of its own to
  // compare against, so it falls through to the first sync path rather than refuse.
  const reader = fakeReader({ "a.md": "alpha" });
  const { writer } = fakeLocalWriter();
  const { storage } = fakeStorage({
    [SENTINEL_KEY]: wrapped(encodeSentinel({ vaultId: "known-id", createdAt: 1000 })),
  });

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok && outcome.snapshot.vaultId === "known-id");
});

test("syncOnce: a stale ancestor is ignored on a first sync, so a populated vault is pushed, not wiped", async () => {
  // An upgrader's stale state.json describes the whole vault even though nothing ever reached the
  // empty bucket; a first sync must drop that ancestor rather than diff against it.
  const previous = snapshot(file("a.md", "h1"), file("b.md", "h2"));
  const reader = fakeReader({ "a.md": "alpha", "b.md": "beta" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "alpha");
  files.set("b.md", "beta");
  const { storage, objects } = fakeStorage();

  const outcome = await syncOnce(previous, reader, writer, storage, 1);

  assert.equal(outcome.ok, true);
  assert.equal(files.get("a.md"), "alpha");
  assert.equal(files.get("b.md"), "beta");
  assert.equal(objects.get(blobKeyFor(await hashOf("alpha"))), wrapped("alpha"));
  assert.equal(objects.get(blobKeyFor(await hashOf("beta"))), wrapped("beta"));
});

test("syncOnce: a present but empty manifest still trusts the ancestor and pulls a real remote deletion", async () => {
  // Unlike the previous test, this manifest genuinely is empty, so a file the ancestor knew about
  // must be pulled and deleted rather than suppressed; the reader matches the ancestor's size and
  // mtime so the hash is reused and the drift check also sees it as unchanged.
  const previous = snapshot({
    path: "a.md",
    size: 2,
    mtime: 1,
    hash: await hashOf("xy"),
    blob: await hashOf("xy"),
  });
  const reader = fakeReader({ "a.md": "xy" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "xy");
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(empty)) });

  const outcome = await syncOnce(previous, reader, writer, storage, 1);

  assert.equal(outcome.ok, true);
  assert.equal(files.has("a.md"), false);
});

test("syncOnce: a remote that lost most of a vault halts before deleting anything", async () => {
  // A manifest that looks wiped plans as "delete every local file", which is the one pass that
  // must never run unasked: it stops instead, leaving both sides exactly as they were.
  const vault = await vaultOf(12);
  const reader = fakeReader(vault.content);
  const { writer, files } = fakeLocalWriter();
  for (const path of Object.keys(vault.content)) {
    files.set(path, vault.content[path]);
  }
  const { storage, objects } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(empty)) });

  const outcome = await syncOnce(snapshot(...vault.entries), reader, writer, storage, 1);

  assert.ok(!outcome.ok);
  assert.equal(outcome.fault, "blocked");
  if (outcome.fault === "blocked") {
    assert.equal(outcome.change.localDeletes, 12);
    assert.equal(outcome.change.tracked, 12);
    assert.equal(outcome.change.paths.length, 12);
    assert.equal(outcome.restated, false);
  }
  assert.equal(outcome.snapshot, null);
  assert.equal(files.size, 12);
  // Only the seeded manifest: no blob, no sentinel, and no manifest of its own went up.
  assert.equal(objects.size, 1);
});

test("syncOnce: the confirmed pass runs in full when it is still the plan that was confirmed", async () => {
  const vault = await vaultOf(12);
  const reader = fakeReader(vault.content);
  const { writer, files } = fakeLocalWriter();
  for (const path of Object.keys(vault.content)) {
    files.set(path, vault.content[path]);
  }
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(empty)) });
  const confirmed = massChangeFor(deletesOf(vault.entries), snapshot(...vault.entries), 12);

  const outcome = await syncOnce(
    snapshot(...vault.entries),
    reader,
    writer,
    storage,
    1,
    () => "vault-1",
    "",
    confirmed,
  );

  assert.equal(outcome.ok, true);
  assert.equal(files.size, 0);
});

test("syncOnce: a confirmation is spent on the plan it was given and no other", async () => {
  // The vault moved on between the dialog and the answer, so what would run is not what was on
  // the screen. The pass is asked again rather than executing an unseen plan under an old yes.
  const vault = await vaultOf(12);
  const reader = fakeReader(vault.content);
  const { writer, files } = fakeLocalWriter();
  for (const path of Object.keys(vault.content)) {
    files.set(path, vault.content[path]);
  }
  const { storage, objects } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(empty)) });
  const stale = await vaultOf(12);
  stale.entries[0] = { ...stale.entries[0], path: "somewhere-else.md" };
  const confirmed = massChangeFor(deletesOf(stale.entries), snapshot(...stale.entries), 12);

  const outcome = await syncOnce(
    snapshot(...vault.entries),
    reader,
    writer,
    storage,
    1,
    () => "vault-1",
    "",
    confirmed,
  );

  assert.ok(!outcome.ok);
  assert.equal(outcome.fault, "blocked");
  if (outcome.fault === "blocked") {
    assert.equal(outcome.restated, true);
  }
  assert.equal(files.size, 12);
  assert.equal(objects.size, 1);
});

test("syncOnce: a first sync pushing a whole vault is never mistaken for a mass deletion", async () => {
  // Every action here is an addition, so a bootstrap of any size must sail through the guard the
  // wiped remote above trips.
  const vault = await vaultOf(200);
  const reader = fakeReader(vault.content);
  const { writer } = fakeLocalWriter();
  const { storage } = fakeStorage();

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.equal(outcome.ok, true);
});

test("syncOnce: a missing manifest with unexplained blobs reports and proceeds, rather than deadlocking every future sync", async () => {
  // A lifecycle rule or manual cleanup deleted the manifest while a blob survived that matches
  // nothing local; refusing here would deadlock every future sync, so the pass proceeds and reports
  // the stranded content instead.
  const strayHash = await hashOf("not local");
  const { storage, objects } = fakeStorage({ [blobKeyFor(strayHash)]: wrapped("not local") });
  const reader = fakeReader({ "a.md": "alpha" });
  const { writer } = fakeLocalWriter();

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.ok(!outcome.ok);
  assert.equal(outcome.message, "1 file(s) failed to sync");
  assert.deepEqual(outcome.failures, [
    { path: blobKeyFor(strayHash), message: "in the bucket but not in the local vault" },
  ]);
  // The local file still pushed and a manifest still landed, ending firstSync state; the stray
  // blob is left exactly where it was, unreferenced but undestroyed.
  assert.equal(objects.get(blobKeyFor(await hashOf("alpha"))), wrapped("alpha"));
  assert.equal(objects.has(MANIFEST_KEY), true);

  // Because a manifest now exists, the next sync is an ordinary sync rather than a repeat of the
  // same refusal: it completes cleanly, not deadlocked on content it will never be able to explain.
  assert.ok(outcome.snapshot !== null);
  const retry = await syncOnce(outcome.snapshot, reader, writer, storage, 1);
  assert.equal(retry.ok, true);
});

test("syncOnce: an interrupted first sync's own uploads never block the retry", async () => {
  // A first sync that pushed a.md's blob then died before the manifest upload leaves a blob with
  // no manifest; unlike the unexplained case above, its hash matches what the local vault still
  // holds, so the retry must fold it in and complete rather than refuse.
  const aHash = await hashOf("alpha");
  const { storage, objects } = fakeStorage({ [blobKeyFor(aHash)]: wrapped("alpha") });
  const reader = fakeReader({ "a.md": "alpha", "b.md": "beta" });
  const { writer } = fakeLocalWriter();

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.equal(outcome.ok, true);
  assert.equal(objects.get(blobKeyFor(aHash)), wrapped("alpha"));
  assert.equal(objects.get(blobKeyFor(await hashOf("beta"))), wrapped("beta"));
  assert.equal(objects.has(MANIFEST_KEY), true);
});

test("syncOnce: a failed bucket listing on a first sync is reported, never guessed at as empty", async () => {
  const { storage } = fakeStorage();
  storage.listObjects = async () => ({
    ok: false,
    status: "server",
    message: "Storage rejected the list (500)",
    objects: [],
  });
  const reader = fakeReader({ "a.md": "alpha" });
  const { writer } = fakeLocalWriter();

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.deepEqual(outcome, {
    ok: false,
    fault: "transient",
    message: "Storage rejected the list (500)",
    failures: [],
    snapshot: null,
  });
});

test("unexplainedBlobs: a blob whose hash matches nothing local is unexplained; a matching one is not", () => {
  // syncOnce always calls this with an already prefix filtered listing (storage.listObjects is
  // called with BLOB_PREFIX), so every key here is a blob key; the manifest itself is never among
  // them.
  const objects = [
    { key: blobKeyFor("h1"), size: 5, lastModified: "" },
    { key: blobKeyFor("h2"), size: 5, lastModified: "" },
  ];
  const local = snapshot(file("a.md", "h1"));

  assert.deepEqual(unexplainedBlobs(objects, local), [blobKeyFor("h2")]);
});

test("syncOnce: a manifest overwritten by another device mid sync fails the pass instead of clobbering it", async () => {
  // Device A and B share a synced vault and sync at overlapping times: B's whole pass lands while
  // A sits between reading the manifest and uploading its own, so A's conditional upload must
  // lose the race and fail rather than clobber B's manifest.
  const ancestor = snapshot(file("a.md", "h1"));
  const { storage, objects } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(ancestor)) });
  const beeHash = await hashOf("bee");
  const bManifest = encodeSnapshot(snapshot(file("a.md", "h1"), file("b.md", beeHash)));
  const inner = storage.putObject;
  let raced = false;
  storage.putObject = async (key, body, condition) => {
    if (key === MANIFEST_KEY && !raced) {
      raced = true;
      await inner(blobKeyFor(beeHash), new TextEncoder().encode(wrapped("bee")));
      await inner(MANIFEST_KEY, new TextEncoder().encode(wrapped(bManifest)));
    }
    return inner(key, body, condition);
  };
  // a.md matches the ancestor's size and mtime so takeSnapshot reuses its hash and sees no local
  // change there; c.md is A's new local file, so A has something to push and a manifest to upload.
  const reader = fakeReader({ "a.md": "xy", "c.md": "ccc" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "xy");
  files.set("c.md", "ccc");

  const outcome = await syncOnce(ancestor, reader, writer, storage, 1);

  assert.deepEqual(outcome, {
    ok: false,
    fault: "raced",
    message: "another device synced at the same time; sync again",
    failures: [],
    snapshot: null,
  });
  assert.equal(objects.get(MANIFEST_KEY), wrapped(bManifest));
  // A's push still reached the bucket (harmless: the next pass folds it into the manifest).
  assert.equal(objects.get(blobKeyFor(await hashOf("ccc"))), wrapped("ccc"));
  assert.equal(files.get("a.md"), "xy");
  assert.equal(files.get("c.md"), "ccc");

  // The failed pass never advanced state.json, so A retries with the same ancestor, now against
  // B's manifest: b.md is pulled, nothing is deleted, and the pass completes.
  const retry = await syncOnce(ancestor, reader, writer, storage, 1);
  assert.equal(retry.ok, true);
  assert.equal(files.get("b.md"), "bee");
  assert.equal(files.get("a.md"), "xy");
});

test("syncOnce: retry adopts an identical orphaned upload with a HEAD, not another PUT", async () => {
  // The blob PUT lands before the manifest CAS is attempted, so it survives a pass that fails on
  // the manifest race; a naive retry would PUT it again, so ensureBlobStored's HEAD-before-PUT is
  // what makes the retry free.
  const ancestor = snapshot({
    path: "a.md",
    size: 4,
    mtime: 1,
    hash: await hashOf("base"),
    blob: await hashOf("base"),
  });
  const { storage, objects } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(ancestor)) });
  const oursHash = await hashOf("ours!");
  const inner = storage.putObject;
  let filePuts = 0;
  let raceManifest = true;
  storage.putObject = async (key, body, condition) => {
    if (key === blobKeyFor(oursHash)) {
      filePuts++;
    }
    if (key === MANIFEST_KEY && raceManifest) {
      raceManifest = false;
      await inner(MANIFEST_KEY, new TextEncoder().encode(wrapped(encodeSnapshot(ancestor))));
    }
    return inner(key, body, condition);
  };
  const reader = fakeReader({ "a.md": "ours!" });
  const { writer } = fakeLocalWriter();
  const newVaultId = () => "fixed-vault-id";

  const first = await syncOnce(ancestor, reader, writer, storage, 1, newVaultId);

  assert.deepEqual(first, {
    ok: false,
    fault: "raced",
    message: "another device synced at the same time; sync again",
    failures: [],
    snapshot: null,
  });
  assert.equal(objects.get(blobKeyFor(oursHash)), wrapped("ours!"));
  assert.equal(filePuts, 1);

  // The manifest is still at the ancestor while the blob already holds our bytes, so the retry's
  // HEAD must find it and skip the PUT entirely.
  const retry = await syncOnce(ancestor, reader, writer, storage, 1, newVaultId);

  assert.deepEqual(retry, {
    ok: true,
    snapshot: {
      files: [{ path: "a.md", size: 5, mtime: 1, hash: oursHash, blob: oursHash }],
      vaultId: "fixed-vault-id",
    },
    changeCount: 1,
  });
  assert.equal(filePuts, 1, "retry replaced an identical orphaned upload with a HEAD, not a PUT");
  assert.ok(retry.ok);
  // The stored manifest never carries vaultId, only the snapshot syncOnce hands back for local
  // persistence does, so the comparison strips it before checking the two agree.
  const { vaultId: _vaultId, ...storedShape } = retry.snapshot;
  assert.equal(objects.get(MANIFEST_KEY), wrapped(encodeSnapshot(storedShape)));
});

test("syncOnce: a file changed mid sync is not recorded in the manifest and is pushed next pass", async () => {
  // The vault is in sync except b.md, new locally; while its push is in flight the user edits a.md
  // and creates c.md, so the manifest must keep claiming only what the bucket holds, not a fresh
  // disk snapshot.
  const xyHash = await hashOf("xy");
  const ancestor = snapshot({ path: "a.md", size: 2, mtime: 1, hash: xyHash, blob: xyHash });
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: wrapped(encodeSnapshot(ancestor)),
    [blobKeyFor(xyHash)]: wrapped("xy"),
  });
  // a.md matches the ancestor's size and mtime so takeSnapshot reuses its hash and sees no local
  // change there; b.md is the new local file whose push is the mid sync moment to interleave on.
  const readerFiles: Record<string, string> = { "a.md": "xy", "b.md": "beta" };
  const reader = fakeReader(readerFiles);
  const { writer } = fakeLocalWriter();
  const inner = storage.putObject;
  const betaHash = await hashOf("beta");
  let edited = false;
  storage.putObject = async (key, body, condition) => {
    if (key === blobKeyFor(betaHash) && !edited) {
      edited = true;
      readerFiles["a.md"] = "edited mid sync";
      readerFiles["c.md"] = "created mid sync";
    }
    return inner(key, body, condition);
  };

  const outcome = await syncOnce(ancestor, reader, writer, storage, 1);

  assert.ok(outcome.ok);
  // The manifest still records a.md as the bucket knows it, and doesn't know c.md at all: neither
  // file's new content ever reached the bucket.
  const manifestBody = objects.get(MANIFEST_KEY);
  assert.ok(manifestBody !== undefined);
  const manifest = JSON.parse(unwrapped(manifestBody)) as Snapshot;
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths.sort(), ["a.md", "b.md"]);
  assert.deepEqual(
    manifest.files.filter((f) => f.path === "a.md"),
    ancestor.files,
  );
  assert.equal(objects.has(blobKeyFor(await hashOf("created mid sync"))), false);

  // The next pass sees both as plain local changes and pushes them.
  const retry = await syncOnce(outcome.snapshot, reader, writer, storage, 1);
  assert.equal(retry.ok, true);
  assert.equal(
    objects.get(blobKeyFor(await hashOf("edited mid sync"))),
    wrapped("edited mid sync"),
  );
  assert.equal(
    objects.get(blobKeyFor(await hashOf("created mid sync"))),
    wrapped("created mid sync"),
  );
});

test("syncOnce: a file edited mid sync is never overwritten by a pull, and the retry preserves it as a conflict copy", async () => {
  // An edit lands on b.md while a.md's pull is in flight. The pull planned for b.md must refuse
  // rather than overwrite it, so the retry sees both sides changed and preserves the edit.
  const aV2Hash = await hashOf("a v2");
  const bV2Hash = await hashOf("b v2");
  const ancestor = snapshot(
    { path: "a.md", size: 4, mtime: 1, hash: await hashOf("a v1"), blob: await hashOf("a v1") },
    { path: "b.md", size: 4, mtime: 1, hash: await hashOf("b v1"), blob: await hashOf("b v1") },
  );
  const remoteManifest = encodeSnapshot(snapshot(file("a.md", aV2Hash), file("b.md", bV2Hash)));
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: wrapped(remoteManifest),
    [blobKeyFor(aV2Hash)]: wrapped("a v2"),
    [blobKeyFor(bV2Hash)]: wrapped("b v2"),
  });
  const readerFiles: Record<string, string> = { "a.md": "a v1", "b.md": "b v1" };
  const reader = fakeReader(readerFiles);
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "a v1");
  files.set("b.md", "b v1");
  // Mirror pulls into the reader as a real vault would, on commit rather than on staging, so the
  // reader only ever sees content that actually reached its destination.
  const innerStage = writer.stageFile;
  writer.stageFile = async (path, data, mode) => {
    const staged = await innerStage(path, data, mode);

    return {
      commit: async () => {
        await staged.commit();
        readerFiles[path] = new TextDecoder().decode(data);
      },
      discard: staged.discard,
    };
  };
  const inner = storage.getObject;
  let edited = false;
  storage.getObject = async (key) => {
    if (key === blobKeyFor(aV2Hash) && !edited) {
      edited = true;
      readerFiles["b.md"] = "edited mid sync";
      files.set("b.md", "edited mid sync");
    }
    return inner(key);
  };
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const outcome = await syncOnce(ancestor, reader, writer, storage, now);

  assert.ok(!outcome.ok);
  // The edit survived and a.md's pull still landed.
  assert.equal(files.get("b.md"), "edited mid sync");
  assert.equal(files.get("a.md"), "a v2");
  // A manifest still went up, recording exactly what the bucket holds rather than what the pass
  // intended to do to it.
  const manifestBody = objects.get(MANIFEST_KEY);
  assert.ok(manifestBody !== undefined);
  const manifest = JSON.parse(unwrapped(manifestBody)) as Snapshot;
  const hashes = new Map(manifest.files.map((f) => [f.path, f.hash]));
  assert.equal(hashes.get("a.md"), aV2Hash);
  assert.equal(hashes.get("b.md"), bV2Hash);

  // The pass still returned a snapshot, with b.md held at the ancestor's view, so the retry reads
  // it as changed on both sides and resolves it as a conflict.
  assert.ok(outcome.snapshot !== null);
  const retry = await syncOnce(outcome.snapshot, reader, writer, storage, now);

  assert.equal(retry.ok, true);
  const copyPath = conflictCopyPath("b.md", now);
  assert.equal(files.get(copyPath), "edited mid sync");
  assert.equal(
    objects.get(blobKeyFor(await hashOf("edited mid sync"))),
    wrapped("edited mid sync"),
  );
  assert.equal(files.get("b.md"), "b v2");
});

test("syncOnce: a conflict copy carries the device that made the edit (#103)", async () => {
  // Both sides changed relative to the ancestor, so the local edit is preserved under a conflict
  // copy. On a three device vault a timestamp alone leaves whose edit it holds to be guessed, so
  // the device this pass ran on has to be in the name, on disk and in the uploaded manifest.
  const remoteHash = await hashOf("from another device");
  const ancestor = snapshot({
    path: "a.md",
    size: 4,
    mtime: 1,
    hash: await hashOf("shared base"),
    blob: await hashOf("shared base"),
  });
  const remoteManifest = encodeSnapshot(
    snapshot({ path: "a.md", size: 19, mtime: 1, hash: remoteHash, blob: remoteHash }),
  );
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: wrapped(remoteManifest),
    [blobKeyFor(remoteHash)]: wrapped("from another device"),
  });
  const reader = fakeReader({ "a.md": "my own edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "my own edit");
  const now = Date.parse("2026-07-14T14:37:22.123Z");

  const outcome = await syncOnce(ancestor, reader, writer, storage, now, undefined, "mac-k3pl7qna");

  assert.equal(outcome.ok, true);
  const copyPath = conflictCopyPath("a.md", now, "mac-k3pl7qna");
  assert.equal(copyPath, "a_conflict_mac-k3pl7qna_20260714-143722-123.md");
  // The preserved edit sits under the device named copy, and the remote version claimed the path.
  assert.equal(files.get(copyPath), "my own edit");
  assert.equal(files.get("a.md"), "from another device");
  // Other devices see it too: the copy reached the bucket and the manifest names it.
  assert.equal(objects.get(blobKeyFor(await hashOf("my own edit"))), wrapped("my own edit"));
  const manifestBody = objects.get(MANIFEST_KEY);
  assert.ok(manifestBody !== undefined);
  const manifest = JSON.parse(unwrapped(manifestBody)) as Snapshot;
  const paths = manifest.files.map((f) => f.path);
  assert.ok(paths.includes(copyPath), paths.join(", "));
});

test("syncOnce: a manifest that moves on mid pull is caught before stale content lands on disk", async () => {
  // Another device completes a whole sync between this pass reading the manifest and its pull
  // committing. A blob read by its own address cannot notice that itself, so the manifest check
  // right before the write is the only thing that catches it.
  const aV1Hash = await hashOf("a v1");
  const aV2Hash = await hashOf("a v2");
  const aV3Hash = await hashOf("a v3");
  const ancestor = snapshot({ path: "a.md", size: 4, mtime: 1, hash: aV1Hash, blob: aV1Hash });
  const remoteManifestV2 = encodeSnapshot(
    snapshot({ path: "a.md", size: 4, mtime: 1, hash: aV2Hash, blob: aV2Hash }),
  );
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: wrapped(remoteManifestV2),
    [blobKeyFor(aV2Hash)]: wrapped("a v2"),
  });
  const reader = fakeReader({ "a.md": "a v1" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "a v1");

  const inner = storage.getObject;
  let raced = false;
  storage.getObject = async (key) => {
    if (key === blobKeyFor(aV2Hash) && !raced) {
      raced = true;
      // Another device wins outright: its own blob and manifest both land before this pass's pull
      // gets to write anything locally.
      await storage.putObject(blobKeyFor(aV3Hash), new TextEncoder().encode(wrapped("a v3")));
      await storage.putObject(
        MANIFEST_KEY,
        new TextEncoder().encode(wrapped(encodeSnapshot(snapshot(file("a.md", aV3Hash))))),
      );
    }
    return inner(key);
  };

  const outcome = await syncOnce(ancestor, reader, writer, storage, 1);

  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.failures, [
    { path: "a.md", message: "changed remotely mid sync; sync again to reconcile" },
  ]);
  // The stale v2 content was never written; the local file is untouched.
  assert.equal(files.get("a.md"), "a v1");
  assert.equal(objects.get(MANIFEST_KEY), wrapped(encodeSnapshot(snapshot(file("a.md", aV3Hash)))));

  // The failed pass never advanced state.json, so the retry re-reads the now current manifest and
  // pulls the real latest version.
  const retry = await syncOnce(ancestor, reader, writer, storage, 1);
  assert.equal(retry.ok, true);
  assert.equal(files.get("a.md"), "a v3");
});

test("syncOnce: a failed push doesn't discard the progress of the rest of the pass", async () => {
  // One push is rejected and the other lands. The pass must record the successful one in both the
  // manifest and the returned snapshot, so one bad file never wedges sync for the rest.
  const reader = fakeReader({ "a.md": "alpha", "b.md": "world" });
  const { writer } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();
  const alphaHash = await hashOf("alpha");
  const worldHash = await hashOf("world");
  const inner = storage.putObject;
  let rejectA = true;
  let bPushes = 0;
  storage.putObject = async (key, body, condition) => {
    if (key === blobKeyFor(alphaHash) && rejectA) {
      return { ok: false, status: "server", message: "Storage rejected the write (500)" };
    }
    if (key === blobKeyFor(worldHash)) {
      bPushes++;
    }
    return inner(key, body, condition);
  };

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.failures, [
    { path: "a.md", message: "Storage rejected the write (500)" },
  ]);
  // b.md's push landed and the manifest records it, so other devices can already see it; a.md
  // never reached the bucket and the manifest doesn't claim it.
  assert.equal(objects.get(blobKeyFor(worldHash)), wrapped("world"));
  const manifestBody = objects.get(MANIFEST_KEY);
  assert.ok(manifestBody !== undefined);
  const manifest = JSON.parse(unwrapped(manifestBody)) as Snapshot;
  assert.deepEqual(
    manifest.files.map((f) => f.path),
    ["b.md"],
  );
  // The snapshot records the same progress: b.md done, a.md still absent so it re-plans as a
  // push.
  assert.ok(outcome.snapshot !== null);
  assert.deepEqual(
    outcome.snapshot.files.map((f) => f.path),
    ["b.md"],
  );

  // Once the provider accepts a.md, the retry pushes only it; b.md's completed work is never
  // re-done.
  rejectA = false;
  const retry = await syncOnce(outcome.snapshot, reader, writer, storage, 1);

  assert.equal(retry.ok, true);
  assert.equal(objects.get(blobKeyFor(alphaHash)), wrapped("alpha"));
  assert.equal(bPushes, 1);
});

test("syncOnce: a conflict's copy push survives into the uploaded manifest even when the restore fails", async () => {
  // A conflict's copy push succeeds while its restore fails. The copy is in the bucket either
  // way, so the manifest must name it or the object stays invisible to every other device.
  const aV2Hash = await hashOf("a v2");
  const ancestor = snapshot({
    path: "a.md",
    size: 4,
    mtime: 1,
    hash: await hashOf("a v1"),
    blob: await hashOf("a v1"),
  });
  const remoteManifest = encodeSnapshot(
    snapshot({ path: "a.md", size: 4, mtime: 1, hash: aV2Hash, blob: aV2Hash }),
  );
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: wrapped(remoteManifest),
    [blobKeyFor(aV2Hash)]: wrapped("a v2"),
  });
  const reader = fakeReader({ "a.md": "a local" });
  const { writer } = fakeLocalWriter();
  writer.stageFile = async () => {
    return {
      commit: async () => {
        throw new Error("EACCES: permission denied");
      },
      discard: async () => {},
    };
  };
  const now = 1;
  const copyPath = conflictCopyPath("a.md", now);

  const outcome = await syncOnce(ancestor, reader, writer, storage, now);

  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.failures, [{ path: "a.md", message: "EACCES: permission denied" }]);
  // The copy really did reach the bucket.
  assert.equal(objects.get(blobKeyFor(await hashOf("a local"))), wrapped("a local"));
  // The uploaded manifest names it, even though the conflict as a whole is reported failed.
  const manifestBody = objects.get(MANIFEST_KEY);
  assert.ok(manifestBody !== undefined);
  const manifest = JSON.parse(unwrapped(manifestBody)) as Snapshot;
  const hashes = new Map(manifest.files.map((f) => [f.path, f.hash]));
  assert.equal(hashes.get(copyPath), await hashOf("a local"));
});

test("syncOnce: the failure message counts files, not operation failures", async () => {
  // A conflict whose restore and copy push both fail reports two operation failures for one vault
  // path. The user facing message must count the one file, not the two operations.
  const aV2Hash = await hashOf("a v2");
  const ancestor = snapshot({
    path: "a.md",
    size: 4,
    mtime: 1,
    hash: await hashOf("a v1"),
    blob: await hashOf("a v1"),
  });
  const remoteManifest = encodeSnapshot(
    snapshot({ path: "a.md", size: 4, mtime: 1, hash: aV2Hash, blob: aV2Hash }),
  );
  // Both sides changed relative to the ancestor, so the plan is a single conflict (deletedSide
  // "none") for a.md. Its restore fails on the commit and its copy push is rejected by the
  // override below.
  const { storage } = fakeStorage({
    [MANIFEST_KEY]: wrapped(remoteManifest),
    [blobKeyFor(aV2Hash)]: wrapped("a v2"),
  });
  const copyBlobKey = blobKeyFor(await hashOf("a local"));
  const inner = storage.putObject;
  storage.putObject = async (key, body, condition) => {
    if (key === copyBlobKey) {
      return { ok: false, status: "server", message: "Storage rejected the write (500)" };
    }
    return inner(key, body, condition);
  };
  const reader = fakeReader({ "a.md": "a local" });
  const { writer } = fakeLocalWriter();
  writer.stageFile = async () => {
    return {
      commit: async () => {
        throw new Error("EACCES: permission denied");
      },
      discard: async () => {},
    };
  };

  const outcome = await syncOnce(ancestor, reader, writer, storage, 1);

  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.failures, [
    { path: "a.md", message: "EACCES: permission denied" },
    { path: conflictCopyPath("a.md", 1), message: "Storage rejected the write (500)" },
  ]);
  assert.equal(outcome.message, "1 file(s) failed to sync");
});

test("syncOnce: a failed pull records progress without the ancestor ever advancing past it", async () => {
  // Why a failed action's path must revert to the ancestor. Advancing it to the manifest's view
  // would make the unchanged local copy read as a fresh edit and push over the newer remote one.
  const aV1Hash = await hashOf("a v1");
  const aV2Hash = await hashOf("a v2");
  const beeHash = await hashOf("bee");
  const ancestor = snapshot({ path: "a.md", size: 4, mtime: 1, hash: aV1Hash, blob: aV1Hash });
  const remoteManifest = encodeSnapshot(
    snapshot(
      { path: "a.md", size: 4, mtime: 1, hash: aV2Hash, blob: aV2Hash },
      { path: "b.md", size: 3, mtime: 1, hash: beeHash, blob: beeHash },
    ),
  );
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: wrapped(remoteManifest),
    [blobKeyFor(aV2Hash)]: wrapped("a v2"),
    [blobKeyFor(beeHash)]: wrapped("bee"),
  });
  const inner = storage.putObject;
  let aPushes = 0;
  storage.putObject = async (key, body, condition) => {
    if (key === blobKeyFor(aV1Hash)) {
      aPushes++;
    }
    return inner(key, body, condition);
  };
  const readerFiles: Record<string, string> = { "a.md": "a v1" };
  const reader = fakeReader(readerFiles);
  let lockA = true;
  // The lock bites on commit rather than on staging: a lock is held on the destination, and
  // staging only ever touches a temp file beside it.
  const writer: LocalWriter = {
    stageFile: async (path, data) => {
      return {
        commit: async () => {
          if (path === "a.md" && lockA) {
            throw new Error("EBUSY: resource busy or locked");
          }
          readerFiles[path] = new TextDecoder().decode(data);
        },
        discard: async () => {},
      };
    },
    deleteFile: async (path) => {
      delete readerFiles[path];
    },
    renameFile: async () => {
      throw new Error("unexpected rename");
    },
  };

  const outcome = await syncOnce(ancestor, reader, writer, storage, 1);

  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.failures, [{ path: "a.md", message: "EBUSY: resource busy or locked" }]);
  // b.md's pull landed and is recorded; a.md stays at the ancestor's view, not the manifest's.
  assert.equal(readerFiles["b.md"], "bee");
  assert.ok(outcome.snapshot !== null);
  const entries = new Map(outcome.snapshot.files.map((f) => [f.path, f.hash]));
  assert.equal(entries.get("a.md"), aV1Hash);
  assert.equal(entries.get("b.md"), beeHash);

  // Once the file unlocks, the retry pulls the newer remote version; the stale local copy is
  // never pushed over it.
  lockA = false;
  const retry = await syncOnce(outcome.snapshot, reader, writer, storage, 1);

  assert.equal(retry.ok, true);
  assert.equal(readerFiles["a.md"], "a v2");
  assert.equal(objects.get(blobKeyFor(aV2Hash)), wrapped("a v2"));
  assert.equal(aPushes, 0);
});

test("syncOnce: two first syncs racing for an empty bucket, the loser fails instead of clobbering", async () => {
  // Both devices see no manifest and plan a first sync. The other device's manifest lands while
  // this one is mid pass; the "ifAbsent" conditional upload must lose rather than overwrite it.
  const { storage, objects } = fakeStorage();
  const otherManifest = encodeSnapshot(snapshot(file("b.md", "h2")));
  const inner = storage.putObject;
  let raced = false;
  storage.putObject = async (key, body, condition) => {
    if (key === MANIFEST_KEY && !raced) {
      raced = true;
      await inner(MANIFEST_KEY, new TextEncoder().encode(wrapped(otherManifest)));
    }
    return inner(key, body, condition);
  };
  const reader = fakeReader({ "a.md": "alpha" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "alpha");

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.equal(outcome.ok, false);
  assert.equal(objects.get(MANIFEST_KEY), wrapped(otherManifest));
  assert.equal(files.get("a.md"), "alpha");
});

test("adoptLiveStats: an entry whose content matches the live vault adopts the live stats", () => {
  const manifest = snapshot({ path: "a.md", size: 2, mtime: 5, hash: "h1", blob: "h1" });
  const live = snapshot({ path: "a.md", size: 2, mtime: 9, hash: "h1", blob: "h1" });

  assert.deepEqual(adoptLiveStats(manifest, live), live);
});

test("adoptLiveStats: a mid sync edit keeps the manifest's entry, so the next diff sees it", () => {
  const manifest = snapshot(file("a.md", "h1"));
  const live = snapshot({ path: "a.md", size: 7, mtime: 9, hash: "h2", blob: "h2" });

  assert.deepEqual(adoptLiveStats(manifest, live), manifest);
});

test("adoptLiveStats: a mid sync deletion keeps the manifest's entry, so the next diff sees it", () => {
  const manifest = snapshot(file("a.md", "h1"));

  assert.deepEqual(adoptLiveStats(manifest, empty), manifest);
});

test("adoptLiveStats: a mid sync creation is never added to the manifest", () => {
  const live = snapshot(file("c.md", "h9"));

  assert.deepEqual(adoptLiveStats(empty, live), empty);
});

test("revertFailedPaths: a failed action's path is restored to the ancestor's entry", () => {
  const manifest = snapshot(file("a.md", "h2"), file("b.md", "h3"));
  const ancestor = snapshot(file("a.md", "h1"));

  const result = revertFailedPaths(manifest, ancestor, [{ kind: "pull", path: "a.md" }]);

  assert.deepEqual(result, snapshot(file("a.md", "h1"), file("b.md", "h3")));
});

test("revertFailedPaths: a path the ancestor never knew is dropped, so it re-plans from scratch", () => {
  const manifest = snapshot(file("a.md", "h2"));

  const result = revertFailedPaths(manifest, empty, [{ kind: "pull", path: "a.md" }]);

  assert.deepEqual(result, empty);
});

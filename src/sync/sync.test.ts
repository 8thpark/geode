import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeSnapshot, hashBytes, type Snapshot } from "../vault/vault.ts";
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
import {
  blobKeyFor,
  conflictCopyPath,
  encodeSentinel,
  MANIFEST_KEY,
  SENTINEL_KEY,
} from "./plan.ts";
import {
  adoptLiveStats,
  readRemoteManifest,
  readSentinel,
  revertFailedPaths,
  syncOnce,
  unexplainedBlobs,
} from "./sync.ts";

// hashOf returns the real content hash of text, for snapshots whose entries executeSyncPlan's
// drift check will verify against live bytes, and for keying a fakeStorage seed at the blob key
// content actually lives under.
async function hashOf(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text));
}

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
  // Without an etag the manifest upload can't be conditional, and an unconditional upload is the
  // concurrent clobber #83 fixed; the pass must refuse rather than proceed.
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(encodeSnapshot(empty)) });
  const inner = storage.getObject;
  storage.getObject = async (key) => {
    const result = await inner(key);
    return { ...result, etag: null };
  };

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: false, message: "remote manifest has no etag" });
});

test("readRemoteManifest: corrupt JSON is reported as a failure, not an empty snapshot", async () => {
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped("not json") });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: false, message: "remote manifest is corrupt" });
});

test("readRemoteManifest: a manifest with no envelope is corrupt, and one from a newer suite needs an update", async () => {
  // Bare JSON at the manifest key is not a geode object (#184): every manifest this build writes
  // carries an envelope, so bytes without one were written by something else, and reading them
  // leniently would make an unversioned object indistinguishable from a version 1 one.
  const bare = fakeStorage({ [MANIFEST_KEY]: encodeSnapshot(snapshot(file("a.md", "h1"))) });

  assert.deepEqual(await readRemoteManifest(bare.storage), {
    ok: false,
    message: "remote manifest is corrupt",
  });

  // A suite this build doesn't know, which at 0.3.0 is an encrypted manifest: the payload is
  // unreadable here, and the fix is a newer plugin rather than a fresh bucket.
  const newerSuite = new Uint8Array([0x47, 0x45, 0x4f, 0x44, 0x01, 0x09, 0x68, 0x69]);
  const encrypted = fakeStorage({ [MANIFEST_KEY]: new TextDecoder().decode(newerSuite) });

  assert.deepEqual(await readRemoteManifest(encrypted.storage), {
    ok: false,
    message: "remote manifest is a format this version of geode can't read",
  });
});

test("readRemoteManifest: JSON of the wrong shape is corrupt, not a snapshot with an undefined files", async () => {
  // Each of these parses cleanly but has no files array. Without the shape check they returned
  // ok:true and later threw TypeError in planSync when byPath iterated remote.files; they must
  // instead surface as the corrupt-manifest result the signature promises.
  for (const body of ["{}", "[]", "null", "42", '"files"']) {
    const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(body) });

    const result = await readRemoteManifest(storage);

    assert.deepEqual(result, { ok: false, message: "remote manifest is corrupt" }, body);
  }
});

test("readRemoteManifest: a pre-marker manifest with no version field is refused, since only the current storage layout is understood", async () => {
  // Buckets written before the format version marker existed (#91) are version 1 by definition:
  // plaintext path keyed storage. This build only understands version 2, content addressed blobs,
  // so a version 1 manifest must be refused rather than misread against a layout it never used.
  const want: Snapshot = snapshot(file("a.md", "h1"));
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(JSON.stringify(want)) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
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
    message: "remote manifest is a format this version of geode can't read",
  });
});

test("readRemoteManifest: a manifest entry with a traversal path refuses the pass (#132)", async () => {
  // A remote manifest is untrusted input: anyone who can write to the bucket can shape it. A
  // crafted path must never reach a local file operation.
  const raw = JSON.stringify({
    version: 3,
    files: [{ path: "../../etc/passwd", size: 1, mtime: 2, hash: "h", blob: "h" }],
  });
  const { storage } = fakeStorage({ [MANIFEST_KEY]: wrapped(raw) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, {
    ok: false,
    message: "remote manifest contains a path unsafe to write",
  });
});

test("readRemoteManifest: two paths differing only by case refuse the pass (#94)", async () => {
  // Bucket keys are case sensitive; macOS, Windows, and Android are not by default. Pulling both
  // would silently let one overwrite the other with no conflict ever raised.
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

  assert.deepEqual(result, { ok: false, message: "Storage rejected the read (500)" });
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

  assert.deepEqual(result, { ok: false, message: "remote sentinel is corrupt" });
});

test("readSentinel: an unknown format version refuses the pass", async () => {
  const raw = JSON.stringify({ version: 4, vaultId: "abc-123", createdAt: 1000 });
  const { storage } = fakeStorage({ [SENTINEL_KEY]: wrapped(raw) });

  const result = await readSentinel(storage);

  assert.deepEqual(result, {
    ok: false,
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
  // Ancestor, local vault, and remote manifest all agree, so planSync produces no actions. Every
  // manifest upload is a compare-and-swap, so a device with nothing to say is a device that can
  // lose a race it had no reason to enter; under automatic sync (#93) two idle devices on a timer
  // would trade "another device synced at the same time" errors over a vault nobody touched.
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
  // "h1" and "xy" are both two bytes, so takeSnapshot stat-skips a.md and reuses the ancestor's
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
  // stat-skip, or an idle sync would trade one wasted upload for a full rehash of the vault.
  assert.deepEqual(outcome.snapshot.files, [file("a.md", "h1")]);
  assert.equal(outcome.snapshot.vaultId, "known-id");
});

test("syncOnce: a first sync with nothing to do still writes the manifest (#102)", async () => {
  // An empty vault against an empty bucket plans nothing, but the manifest existing is what tells
  // every later pass this bucket has been synced before (see resolveVaultIdentity). Skipping it
  // because the plan was empty would leave the bucket stuck in first sync state forever.
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
  // The manifest exists but the sentinel does not: an upgrade from before sentinels existed, or a
  // crash between the two writes of an otherwise successful first sync. Skipping the manifest write
  // must not skip the repair. The sentinel write carries its own condition precisely so a bucket
  // that lost one heals on the next pass, whether or not that pass had anything else to do.
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
  // The sentinel, and only the sentinel.
  assert.deepEqual(written, [SENTINEL_KEY]);
  assert.ok(objects.has(SENTINEL_KEY));
  assert.equal(outcome.snapshot.vaultId, "minted-id");
});

test("syncOnce: a device pointed at a different vault's sentinel refuses (#183)", async () => {
  // This device already trusts a different vaultId (its state.json carries one from a prior
  // successful sync), and the bucket it is pointed at now belongs to a genuinely different vault.
  // Whether that other vault's manifest happens to exist is irrelevant here; the mismatch alone is
  // the danger #183 exists to catch (a typo in a configured prefix, the wrong bucket entirely).
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
    message: "this bucket belongs to a different vault than the one last synced here",
    failures: [],
    snapshot: null,
  });
});

test("syncOnce: a never-synced device proceeds without a manifest (#109)", async () => {
  // The sentinel proves someone has used this bucket before, but this particular device has no
  // history of its own to protect, so it must fall through to the ordinary first-sync path rather
  // than refuse: exactly the #109 scenario a manifest deleted while its blob survives, which the
  // existing unexplainedBlobs reporting already resolves. Refusing here for every device, not just
  // ones with something to lose, would silently reinstate that permanent deadlock.
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
  // An older build wrote state.json on every file event rather than only on completed syncs, so an
  // upgrader carries a `previous` snapshot describing their whole vault even though nothing ever
  // reached the (still empty) bucket. Diffed against that empty remote it reads as "every file
  // deleted remotely", and before the fix syncOnce pullDeleted the lot. A first sync (no remote
  // manifest) must instead drop the ancestor and push whatever is local.
  const previous = snapshot(file("a.md", "h1"), file("b.md", "h2"));
  const reader = fakeReader({ "a.md": "alpha", "b.md": "beta" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "alpha");
  files.set("b.md", "beta");
  const { storage, objects } = fakeStorage();

  const outcome = await syncOnce(previous, reader, writer, storage, 1);

  assert.equal(outcome.ok, true);
  // Nothing was deleted locally.
  assert.equal(files.get("a.md"), "alpha");
  assert.equal(files.get("b.md"), "beta");
  // Both files' blobs reached the previously empty bucket.
  assert.equal(objects.get(blobKeyFor(await hashOf("alpha"))), wrapped("alpha"));
  assert.equal(objects.get(blobKeyFor(await hashOf("beta"))), wrapped("beta"));
});

test("syncOnce: a present but empty manifest still trusts the ancestor and pulls a real remote deletion", async () => {
  // The other side of the same coin: here a manifest genuinely exists and is empty, so a prior sync
  // really did produce an empty remote. A file the ancestor knew about, unchanged locally, was
  // deleted remotely, and pullDelete is the correct result that must NOT be suppressed. The reader
  // reports the file at the same size and mtime as the ancestor so takeSnapshot reuses its hash and
  // sees no local change; the hash is the real content hash so the pullDelete's drift check also
  // sees the file as unchanged.
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

test("syncOnce: a missing manifest with unexplained blobs reports and proceeds, rather than deadlocking every future sync", async () => {
  // Reproduces #109 for content addressed storage, and the regression an outright refusal here
  // caused. A lifecycle rule or manual cleanup deleted the manifest while a blob survived, and its
  // hash matches nothing in this device's local vault: this device cannot say what path, if any,
  // that content used to live at. A blanket refusal here never writes a manifest, so
  // remote.firstSync stays true and every future attempt hits the identical refusal, forever, even
  // once the explanation is entirely mundane (an interrupted first sync's blob, whose local file
  // was deleted before the retry) rather than another vault's stray data. The pass must instead
  // proceed, push what is local, and report the stranded content as a failure so a human can still
  // notice it without every future sync being blocked on it.
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
  // A first sync that pushed a.md's blob and then died before its manifest upload leaves a blob
  // and no manifest, the same bucket signature as #109's hazard. Its hash matches what the local
  // vault still holds, so nothing is unexplained; the retry must fold it in and complete, not
  // refuse.
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
  // Reproduces #83. Device A (under test) and device B share a synced vault containing a.md, then
  // sync at overlapping times: B's whole pass (pushing b.md and its manifest) lands while A is
  // between reading the manifest and uploading its own. Before the fix A's unconditional upload
  // clobbered B's manifest, so b.md read as a remote deletion on B's next sync and was silently
  // deleted. A's conditional upload must instead lose the race and fail the pass.
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
    message: "another device synced at the same time; sync again",
    failures: [],
    snapshot: null,
  });
  // B's manifest survived; A's never landed.
  assert.equal(objects.get(MANIFEST_KEY), wrapped(bManifest));
  // A's push still reached the bucket (harmless: the next pass folds it into the manifest).
  assert.equal(objects.get(blobKeyFor(await hashOf("ccc"))), wrapped("ccc"));
  // Nothing was touched locally.
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
  // Reproduces #110's shape for content addressed storage. The file's blob PUT lands before the
  // manifest CAS is even attempted, so it survives a pass that then fails on the manifest race; a
  // naive retry that always PUTs again would waste the upload a second time. ensureBlobStored's
  // HEAD-before-PUT is what makes the retry free.
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
  // persistence does (#183), so the comparison strips it before checking the two agree.
  const { vaultId: _vaultId, ...storedShape } = retry.snapshot;
  assert.equal(objects.get(MANIFEST_KEY), wrapped(encodeSnapshot(storedShape)));
});

test("syncOnce: a file changed mid sync is not recorded in the manifest and is pushed next pass", async () => {
  // Reproduces #84. The vault is in sync (a.md, unchanged), and b.md is new locally, so the pass
  // pushes b.md. While that push is in flight the user edits a.md and creates c.md. Before the
  // fix the manifest was a re-snapshot of the disk taken after the plan ran, so it recorded both
  // with content the bucket never received; neither then ever uploaded (state.json already agreed
  // with the manifest), and another device could push the stale bucket copy of a.md back over the
  // edit. The manifest must instead keep claiming only what the bucket holds, leaving both files
  // as local changes for the next pass to push.
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
  // Reproduces #86. Both files are in sync locally and edited remotely, so the pass plans a pull
  // for each. While a.md's pull is fetching, the user edits b.md; before the fix the pull planned
  // for b.md then overwrote that edit with the remote version, silently discarding it. The pass
  // must refuse that pull and fail instead, and because state.json never advances, the retry sees
  // b.md changed on both sides and preserves the edit as a conflict copy.
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
  // Mirror pulls into the reader, as writing to a real vault would: the retry below re-snapshots
  // through the reader and must see what the first pass's completed pull actually left on disk.
  // Mirrored on commit, not on staging, so the reader only ever sees content that reached the
  // destination, exactly as the vault would.
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
  // A manifest was still uploaded (#87), and it records exactly what the bucket really holds:
  // both remote versions, untouched by this pass's pulls.
  const manifestBody = objects.get(MANIFEST_KEY);
  assert.ok(manifestBody !== undefined);
  const manifest = JSON.parse(unwrapped(manifestBody)) as Snapshot;
  const hashes = new Map(manifest.files.map((f) => [f.path, f.hash]));
  assert.equal(hashes.get("a.md"), aV2Hash);
  assert.equal(hashes.get("b.md"), bV2Hash);

  // The pass still returned a snapshot recording its progress, with b.md held at the ancestor's
  // view. The retry diffs b.md against that same ancestor: changed locally and remotely, a
  // genuine conflict, so the edit is renamed to a conflict copy, pushed, and the remote version
  // pulled.
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
  // A blob fetched by its own hash always reads back exactly that content, so unlike the plaintext
  // path keyed layout this replaced, a pull can never notice on its own that a newer manifest has
  // since pointed the path at a different hash. Another device completes an entire sync (new
  // content, new manifest) in the window between this pass reading the manifest and its pull's
  // fetch finishing; the drift check right before the write must catch this rather than let the
  // now stale content land on disk, only to be discovered afterward when this pass's own manifest
  // upload fails.
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
  // Reproduces #87. Two new local files; a.md's push is rejected by the provider, b.md's lands.
  // Before the fix the pass bailed without uploading a manifest or returning a snapshot: b.md sat
  // in the bucket invisible to every other device, all completed work was re-planned from scratch
  // next time, and a file that fails permanently wedged sync forever. The pass must instead
  // record b.md's progress in both the manifest and the returned snapshot, leaving only a.md
  // pending.
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
  // Reproduces #177: the local edit is moved aside and its copy pushed, but installing the remote
  // version over the vacated path fails (a locked destination here, a note recreated in the gap in
  // production). The copy still landed in the bucket; if the manifest this pass uploads doesn't
  // name it, the object sits there forever, invisible to every other device, until this same one
  // syncs again.
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
  // The other half of #87, and the reason a failed action's path must revert to the ancestor's
  // view: a.md was edited remotely and its pull fails (a locked file, say), while b.md is new
  // remotely and pulls fine. The pass must record b.md's progress, but if a.md's entry advanced
  // to the manifest's view the unchanged local copy would read as a fresh local edit on the next
  // pass and be pushed over the newer remote version, quietly undoing the remote edit.
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

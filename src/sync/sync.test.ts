import assert from "node:assert/strict";
import { test } from "node:test";
import { hashBytes, type Snapshot } from "../vault/vault.ts";
import type { LocalWriter } from "./execute.ts";
import { empty, fakeLocalWriter, fakeReader, fakeStorage, file, snapshot } from "./fake.ts";
import { conflictCopyPath, MANIFEST_KEY } from "./plan.ts";
import { adoptLiveStats, readRemoteManifest, revertFailedPaths, syncOnce } from "./sync.ts";

// hashOf returns the real content hash of text, for snapshots whose entries executeSyncPlan's
// drift check will verify against live bytes.
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
  const { storage } = fakeStorage({ [MANIFEST_KEY]: JSON.stringify(want) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: true, snapshot: want, firstSync: false, etag: '"v1"' });
});

test("readRemoteManifest: a manifest without an etag is refused, not synced unsafely", async () => {
  // Without an etag the manifest upload can't be conditional, and an unconditional upload is the
  // concurrent clobber #83 fixed; the pass must refuse rather than proceed.
  const { storage } = fakeStorage({ [MANIFEST_KEY]: JSON.stringify(empty) });
  const inner = storage.getObject;
  storage.getObject = async (key) => {
    const result = await inner(key);
    return { ...result, etag: null };
  };

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: false, message: "remote manifest has no etag" });
});

test("readRemoteManifest: corrupt JSON is reported as a failure, not an empty snapshot", async () => {
  const { storage } = fakeStorage({ [MANIFEST_KEY]: "not json" });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: false, message: "remote manifest is corrupt" });
});

test("readRemoteManifest: JSON of the wrong shape is corrupt, not a snapshot with an undefined files", async () => {
  // Each of these parses cleanly but has no files array. Without the shape check they returned
  // ok:true and later threw TypeError in planSync when byPath iterated remote.files; they must
  // instead surface as the corrupt-manifest result the signature promises.
  for (const body of ["{}", "[]", "null", "42", '"files"']) {
    const { storage } = fakeStorage({ [MANIFEST_KEY]: body });

    const result = await readRemoteManifest(storage);

    assert.deepEqual(result, { ok: false, message: "remote manifest is corrupt" }, body);
  }
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
  // Both files reached the previously empty bucket.
  assert.equal(objects.get("a.md"), "alpha");
  assert.equal(objects.get("b.md"), "beta");
});

test("syncOnce: a present but empty manifest still trusts the ancestor and pulls a real remote deletion", async () => {
  // The other side of the same coin: here a manifest genuinely exists and is empty, so a prior sync
  // really did produce an empty remote. A file the ancestor knew about, unchanged locally, was
  // deleted remotely, and pullDelete is the correct result that must NOT be suppressed. The reader
  // reports the file at the same size and mtime as the ancestor so takeSnapshot reuses its hash and
  // sees no local change; the hash is the real content hash so the pullDelete's drift check also
  // sees the file as unchanged.
  const previous = snapshot({ path: "a.md", size: 2, mtime: 1, hash: await hashOf("xy") });
  const reader = fakeReader({ "a.md": "xy" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "xy");
  const { storage } = fakeStorage({ [MANIFEST_KEY]: JSON.stringify(empty) });

  const outcome = await syncOnce(previous, reader, writer, storage, 1);

  assert.equal(outcome.ok, true);
  assert.equal(files.has("a.md"), false);
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

test("syncOnce: a manifest overwritten by another device mid sync fails the pass instead of clobbering it", async () => {
  // Reproduces #83. Device A (under test) and device B share a synced vault containing a.md, then
  // sync at overlapping times: B's whole pass (pushing b.md and its manifest) lands while A is
  // between reading the manifest and uploading its own. Before the fix A's unconditional upload
  // clobbered B's manifest, so b.md read as a remote deletion on B's next sync and was silently
  // deleted. A's conditional upload must instead lose the race and fail the pass.
  const ancestor = snapshot(file("a.md", "h1"));
  const { storage, objects } = fakeStorage({ [MANIFEST_KEY]: JSON.stringify(ancestor) });
  const bManifest = JSON.stringify(snapshot(file("a.md", "h1"), file("b.md", "h2")));
  const inner = storage.putObject;
  let raced = false;
  storage.putObject = async (key, body, condition) => {
    if (key === MANIFEST_KEY && !raced) {
      raced = true;
      await inner("b.md", new TextEncoder().encode("bee"));
      await inner(MANIFEST_KEY, new TextEncoder().encode(bManifest));
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
  assert.equal(objects.get(MANIFEST_KEY), bManifest);
  // A's push still reached the bucket (harmless: the next pass folds it into the manifest).
  assert.equal(objects.get("c.md"), "ccc");
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

test("syncOnce: a file changed mid sync is not recorded in the manifest and is pushed next pass", async () => {
  // Reproduces #84. The vault is in sync (a.md, unchanged), and b.md is new locally, so the pass
  // pushes b.md. While that push is in flight the user edits a.md and creates c.md. Before the
  // fix the manifest was a re-snapshot of the disk taken after the plan ran, so it recorded both
  // with content the bucket never received; neither then ever uploaded (state.json already agreed
  // with the manifest), and another device could push the stale bucket copy of a.md back over the
  // edit. The manifest must instead keep claiming only what the bucket holds, leaving both files
  // as local changes for the next pass to push.
  const ancestor = snapshot(file("a.md", "h1"));
  const { storage, objects } = fakeStorage({ [MANIFEST_KEY]: JSON.stringify(ancestor) });
  // a.md matches the ancestor's size and mtime so takeSnapshot reuses its hash and sees no local
  // change there; b.md is the new local file whose push is the mid sync moment to interleave on.
  const readerFiles: Record<string, string> = { "a.md": "xy", "b.md": "beta" };
  const reader = fakeReader(readerFiles);
  const { writer } = fakeLocalWriter();
  const inner = storage.putObject;
  let edited = false;
  storage.putObject = async (key, body, condition) => {
    if (key === "b.md" && !edited) {
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
  const manifest = JSON.parse(manifestBody) as Snapshot;
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths.sort(), ["a.md", "b.md"]);
  assert.deepEqual(
    manifest.files.filter((f) => f.path === "a.md"),
    [file("a.md", "h1")],
  );
  assert.equal(objects.has("c.md"), false);

  // The next pass sees both as plain local changes and pushes them.
  const retry = await syncOnce(outcome.snapshot, reader, writer, storage, 1);
  assert.equal(retry.ok, true);
  assert.equal(objects.get("a.md"), "edited mid sync");
  assert.equal(objects.get("c.md"), "created mid sync");
});

test("syncOnce: a file edited mid sync is never overwritten by a pull, and the retry preserves it as a conflict copy", async () => {
  // Reproduces #86. Both files are in sync locally and edited remotely, so the pass plans a pull
  // for each. While a.md's pull is fetching, the user edits b.md; before the fix the pull planned
  // for b.md then overwrote that edit with the remote version, silently discarding it. The pass
  // must refuse that pull and fail instead, and because state.json never advances, the retry sees
  // b.md changed on both sides and preserves the edit as a conflict copy.
  const ancestor = snapshot(
    { path: "a.md", size: 4, mtime: 1, hash: await hashOf("a v1") },
    { path: "b.md", size: 4, mtime: 1, hash: await hashOf("b v1") },
  );
  const remoteManifest = JSON.stringify(
    snapshot(file("a.md", await hashOf("a v2")), file("b.md", await hashOf("b v2"))),
  );
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: remoteManifest,
    "a.md": "a v2",
    "b.md": "b v2",
  });
  const readerFiles: Record<string, string> = { "a.md": "a v1", "b.md": "b v1" };
  const reader = fakeReader(readerFiles);
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "a v1");
  files.set("b.md", "b v1");
  // Mirror pulls into the reader, as writing to a real vault would: the retry below re-snapshots
  // through the reader and must see what the first pass's completed pull actually left on disk.
  const innerWrite = writer.writeFile;
  writer.writeFile = async (path, data) => {
    await innerWrite(path, data);
    readerFiles[path] = new TextDecoder().decode(data);
  };
  const inner = storage.getObject;
  let edited = false;
  storage.getObject = async (key) => {
    if (key === "a.md" && !edited) {
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
  const manifest = JSON.parse(manifestBody) as Snapshot;
  const hashes = new Map(manifest.files.map((f) => [f.path, f.hash]));
  assert.equal(hashes.get("a.md"), await hashOf("a v2"));
  assert.equal(hashes.get("b.md"), await hashOf("b v2"));

  // The pass still returned a snapshot recording its progress, with b.md held at the ancestor's
  // view. The retry diffs b.md against that same ancestor: changed locally and remotely, a
  // genuine conflict, so the edit is renamed to a conflict copy, pushed, and the remote version
  // pulled.
  assert.ok(outcome.snapshot !== null);
  const retry = await syncOnce(outcome.snapshot, reader, writer, storage, now);

  assert.equal(retry.ok, true);
  const copyPath = conflictCopyPath("b.md", now);
  assert.equal(files.get(copyPath), "edited mid sync");
  assert.equal(objects.get(copyPath), "edited mid sync");
  assert.equal(files.get("b.md"), "b v2");
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
  const inner = storage.putObject;
  let rejectA = true;
  let bPushes = 0;
  storage.putObject = async (key, body, condition) => {
    if (key === "a.md" && rejectA) {
      return { ok: false, status: "server", message: "Storage rejected the write (500)" };
    }
    if (key === "b.md") {
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
  assert.equal(objects.get("b.md"), "world");
  const manifestBody = objects.get(MANIFEST_KEY);
  assert.ok(manifestBody !== undefined);
  const manifest = JSON.parse(manifestBody) as Snapshot;
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
  assert.equal(objects.get("a.md"), "alpha");
  assert.equal(bPushes, 1);
});

test("syncOnce: a failed pull records progress without the ancestor ever advancing past it", async () => {
  // The other half of #87, and the reason a failed action's path must revert to the ancestor's
  // view: a.md was edited remotely and its pull fails (a locked file, say), while b.md is new
  // remotely and pulls fine. The pass must record b.md's progress, but if a.md's entry advanced
  // to the manifest's view the unchanged local copy would read as a fresh local edit on the next
  // pass and be pushed over the newer remote version, quietly undoing the remote edit.
  const ancestor = snapshot({ path: "a.md", size: 4, mtime: 1, hash: await hashOf("a v1") });
  const remoteManifest = JSON.stringify(
    snapshot(
      { path: "a.md", size: 4, mtime: 1, hash: await hashOf("a v2") },
      { path: "b.md", size: 3, mtime: 1, hash: await hashOf("bee") },
    ),
  );
  const { storage, objects } = fakeStorage({
    [MANIFEST_KEY]: remoteManifest,
    "a.md": "a v2",
    "b.md": "bee",
  });
  const inner = storage.putObject;
  let aPushes = 0;
  storage.putObject = async (key, body, condition) => {
    if (key === "a.md") {
      aPushes++;
    }
    return inner(key, body, condition);
  };
  const readerFiles: Record<string, string> = { "a.md": "a v1" };
  const reader = fakeReader(readerFiles);
  let lockA = true;
  const writer: LocalWriter = {
    writeFile: async (path, data) => {
      if (path === "a.md" && lockA) {
        throw new Error("EBUSY: resource busy or locked");
      }
      readerFiles[path] = new TextDecoder().decode(data);
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
  assert.equal(entries.get("a.md"), await hashOf("a v1"));
  assert.equal(entries.get("b.md"), await hashOf("bee"));

  // Once the file unlocks, the retry pulls the newer remote version; the stale local copy is
  // never pushed over it.
  lockA = false;
  const retry = await syncOnce(outcome.snapshot, reader, writer, storage, 1);

  assert.equal(retry.ok, true);
  assert.equal(readerFiles["a.md"], "a v2");
  assert.equal(objects.get("a.md"), "a v2");
  assert.equal(aPushes, 0);
});

test("syncOnce: two first syncs racing for an empty bucket, the loser fails instead of clobbering", async () => {
  // Both devices see no manifest and plan a first sync. The other device's manifest lands while
  // this one is mid pass; the "ifAbsent" conditional upload must lose rather than overwrite it.
  const { storage, objects } = fakeStorage();
  const otherManifest = JSON.stringify(snapshot(file("b.md", "h2")));
  const inner = storage.putObject;
  let raced = false;
  storage.putObject = async (key, body, condition) => {
    if (key === MANIFEST_KEY && !raced) {
      raced = true;
      await inner(MANIFEST_KEY, new TextEncoder().encode(otherManifest));
    }
    return inner(key, body, condition);
  };
  const reader = fakeReader({ "a.md": "alpha" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "alpha");

  const outcome = await syncOnce(empty, reader, writer, storage, 1);

  assert.equal(outcome.ok, false);
  assert.equal(objects.get(MANIFEST_KEY), otherManifest);
  assert.equal(files.get("a.md"), "alpha");
});

test("adoptLiveStats: an entry whose content matches the live vault adopts the live stats", () => {
  const manifest = snapshot({ path: "a.md", size: 2, mtime: 5, hash: "h1" });
  const live = snapshot({ path: "a.md", size: 2, mtime: 9, hash: "h1" });

  assert.deepEqual(adoptLiveStats(manifest, live), live);
});

test("adoptLiveStats: a mid sync edit keeps the manifest's entry, so the next diff sees it", () => {
  const manifest = snapshot(file("a.md", "h1"));
  const live = snapshot({ path: "a.md", size: 7, mtime: 9, hash: "h2" });

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

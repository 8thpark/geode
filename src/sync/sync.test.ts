import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "../vault/vault.ts";
import { empty, fakeLocalWriter, fakeReader, fakeStorage, file, snapshot } from "./fake.ts";
import { MANIFEST_KEY } from "./plan.ts";
import { readRemoteManifest, syncOnce } from "./sync.ts";

test("readRemoteManifest: a 404 is treated as an empty snapshot", async () => {
  const { storage } = fakeStorage();

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: true, snapshot: { files: [] }, firstSync: true });
});

test("readRemoteManifest: valid JSON is parsed into a snapshot", async () => {
  const want: Snapshot = snapshot(file("a.md", "h1"));
  const { storage } = fakeStorage({ [MANIFEST_KEY]: JSON.stringify(want) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: true, snapshot: want, firstSync: false });
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
  // sees no local change.
  const previous = snapshot(file("a.md", "h1"));
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
  });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: false, message: "Storage rejected the read (500)" });
});

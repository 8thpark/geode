import assert from "node:assert/strict";
import { test } from "node:test";
import { hashBytes, type Reader } from "../vault/vault.ts";
import { executeSyncPlan } from "./execute.ts";
import {
  empty,
  fakeLocalWriter,
  fakeReader,
  fakeStorage,
  file,
  snapshot,
  wrapped,
} from "./fake.ts";
import { blobKeyFor, conflictCopyPath, MANIFEST_KEY, type SyncAction } from "./plan.ts";

// hashOf returns the real content hash of text, for local snapshots the drift check can verify
// against a fake reader's live bytes, and for keying a fakeStorage seed at the blob key content
// actually lives under.
async function hashOf(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text));
}

test("executeSyncPlan: push reads the local file and puts its blob remotely", async () => {
  const reader = fakeReader({ "a.md": "hello" });
  const { writer, files } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();

  const { failures, pushedFiles } = await executeSyncPlan(
    [{ kind: "push", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
  );

  const hash = await hashOf("hello");
  assert.deepEqual(failures, []);
  assert.equal(objects.get(blobKeyFor(hash)), wrapped("hello"));
  assert.equal(files.size, 0);
  assert.deepEqual(pushedFiles, [{ path: "a.md", size: 5, mtime: 1, hash, blob: hash }]);
});

test("executeSyncPlan: a push records the bytes it actually uploaded, not the pre push snapshot's hash", async () => {
  // a.md was edited again after the local snapshot this pass planned from, but before the push
  // read its bytes; the manifest must record the hash of what was actually pushed, not the
  // snapshot's stale one.
  const reader = fakeReader({ "a.md": "edited after snapshot" });
  const local = snapshot(file("a.md", await hashOf("as snapshotted")));
  const { writer } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();

  const { failures, pushedFiles } = await executeSyncPlan(
    [{ kind: "push", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
  );

  const hash = await hashOf("edited after snapshot");
  assert.deepEqual(failures, []);
  assert.equal(objects.get(blobKeyFor(hash)), wrapped("edited after snapshot"));
  assert.deepEqual(pushedFiles, [
    { path: "a.md", size: "edited after snapshot".length, mtime: 1, hash, blob: hash },
  ]);
});

test("executeSyncPlan: pushing content already stored under another path costs a HEAD, never a re-upload", async () => {
  // The whole point of a content addressed key: a rename, or a second file with identical bytes,
  // recognises the blob already exists and skips the PUT entirely.
  const reader = fakeReader({ "b.md": "hello" });
  const { writer } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const { storage, objects } = fakeStorage({ [blobKeyFor(hash)]: wrapped("hello") });
  let puts = 0;
  storage.putObject = async () => {
    puts++;
    return { ok: true, status: "ok", message: "" };
  };

  const { failures, pushedFiles } = await executeSyncPlan(
    [{ kind: "push", path: "b.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
  );

  assert.deepEqual(failures, []);
  assert.equal(puts, 0);
  assert.equal(objects.size, 1);
  assert.deepEqual(pushedFiles, [{ path: "b.md", size: 5, mtime: 1, hash, blob: hash }]);
});

test("executeSyncPlan: pushDelete completes without touching the bucket, and the blob survives", async () => {
  const reader = fakeReader({});
  const { writer } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const { storage, objects } = fakeStorage({ [blobKeyFor(hash)]: wrapped("hello") });
  const remote = snapshot(file("a.md", hash));

  const { completed, failures } = await executeSyncPlan(
    [{ kind: "pushDelete", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    0,
    remote,
  );

  assert.deepEqual(failures, []);
  assert.deepEqual(completed, [{ kind: "pushDelete", path: "a.md" }]);
  // Deletion is a manifest change, never a bucket write: the blob is never destroyed, so it stays
  // reachable at its hash for as long as any retained manifest, past or present, still names it.
  assert.equal(objects.get(blobKeyFor(hash)), wrapped("hello"));
});

test("executeSyncPlan: pushDelete succeeds even when the bucket never held a blob for the path", async () => {
  const reader = fakeReader({});
  const { writer } = fakeLocalWriter();
  const { storage, objects } = fakeStorage({});

  const { completed, failures } = await executeSyncPlan(
    [{ kind: "pushDelete", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    0,
  );

  assert.deepEqual(failures, []);
  assert.equal(completed.length, 1);
  assert.equal(objects.size, 0);
});

test("executeSyncPlan: pull fetches the remote blob and writes it locally", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("hello") });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "hello");
});

test("executeSyncPlan: pull overwrites a local file that still matches the snapshot", async () => {
  const reader = fakeReader({ "a.md": "unchanged" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "unchanged");
  const local = snapshot(file("a.md", await hashOf("unchanged")));
  const remoteHash = await hashOf("remote edit");
  const { storage } = fakeStorage({ [blobKeyFor(remoteHash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", remoteHash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "remote edit");
});

test("executeSyncPlan: pull onto a file edited after the snapshot is refused and the edit survives", async () => {
  // The pull was planned from a snapshot in which a.md was unchanged, but the user edited it
  // before the plan reached this action; overwriting it now would silently discard that edit, so
  // the action must fail and the rest of the plan must still run.
  const reader = fakeReader({ "a.md": "edited after snapshot" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "edited after snapshot");
  const local = snapshot(file("a.md", await hashOf("as snapshotted")));
  const aHash = await hashOf("remote edit");
  const bHash = await hashOf("remote b");
  const { storage } = fakeStorage({
    [blobKeyFor(aHash)]: wrapped("remote edit"),
    [blobKeyFor(bHash)]: wrapped("remote b"),
  });
  const remote = snapshot(file("a.md", aHash), file("b.md", bHash));

  const actions: SyncAction[] = [
    { kind: "pull", path: "a.md" },
    { kind: "pull", path: "b.md" },
  ];
  const { failures } = await executeSyncPlan(actions, local, reader, writer, storage, 1, remote);

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "edited after snapshot");
  // The following action still ran.
  assert.equal(files.get("b.md"), "remote b");
});

test("executeSyncPlan: pull onto a file created after the snapshot is refused", async () => {
  // The snapshot saw nothing at this path (the pull was planned for a remote only file), but the
  // user created one there before the plan reached this action, so writing the remote version over
  // it would discard content the plan never knew existed.
  const reader = fakeReader({ "a.md": "created after snapshot" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "created after snapshot");
  const hash = await hashOf("remote edit");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "created after snapshot");
});

test("executeSyncPlan: a pull whose manifest entry carries no hash is refused before any storage read", async () => {
  // Every pull through syncOnce carries a manifest entry; a caller that supplies no remote view at
  // all (the empty default) has no key to even attempt a read against.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const { storage } = fakeStorage();

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "manifest missing expected hash for this path" },
  ]);
  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: pullDelete removes a local file that still matches the snapshot", async () => {
  const reader = fakeReader({ "a.md": "hello" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "hello");
  const local = snapshot(file("a.md", await hashOf("hello")));
  const { storage } = fakeStorage();

  await executeSyncPlan([{ kind: "pullDelete", path: "a.md" }], local, reader, writer, storage, 1);

  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: pullDelete of a file edited after the snapshot is refused and the edit survives", async () => {
  // The remote deletion was planned against a snapshot in which a.md was unchanged, but the user
  // edited it in the window since, so deleting it now would silently discard that edit.
  const reader = fakeReader({ "a.md": "edited after snapshot" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "edited after snapshot");
  const local = snapshot(file("a.md", await hashOf("as snapshotted")));
  const { storage } = fakeStorage();

  const { failures } = await executeSyncPlan(
    [{ kind: "pullDelete", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "edited after snapshot");
});

test("executeSyncPlan: pullDelete of a file that exists but cannot be read is refused, never treated as absent", async () => {
  // A read failing on a file that is still present must not read as "nothing to discard", since the
  // delete could then succeed against content the drift check never verified.
  const reader = fakeReader({ "a.md": "hello" });
  reader.readFile = async () => {
    throw new Error("EACCES: permission denied");
  };
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "hello");
  const local = snapshot(file("a.md", await hashOf("hello")));
  const { storage } = fakeStorage();

  const { failures } = await executeSyncPlan(
    [{ kind: "pullDelete", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
  );

  assert.deepEqual(failures, [{ path: "a.md", message: "EACCES: permission denied" }]);
  assert.equal(files.get("a.md"), "hello");
});

test("executeSyncPlan: pullDelete refuses when the manifest has moved on, rather than deleting a repopulated path", async () => {
  // pullDelete has no bucket object of its own to check, unlike pull's fetch, so it would
  // otherwise remove a local file purely on the say of a stale plan even though another device has
  // since pushed new content back to this exact path.
  const reader = fakeReader({ "a.md": "hello" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "hello");
  const local = snapshot(file("a.md", await hashOf("hello")));
  const { storage } = fakeStorage({ [MANIFEST_KEY]: "irrelevant" });

  const { failures } = await executeSyncPlan(
    [{ kind: "pullDelete", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    empty,
    '"stale-etag"',
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed remotely mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "hello");
});

test("executeSyncPlan: a conflict renames the local copy, pushes its blob to storage, and pulls the remote version clean", async () => {
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const remoteHash = await hashOf("remote edit");
  const { storage, objects } = fakeStorage({ [blobKeyFor(remoteHash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", remoteHash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures, pushedFiles } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  const copyHash = await hashOf("local edit");
  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "remote edit");
  assert.equal(files.get(conflictCopyPath("a.md", now)), "local edit");
  // The conflict copy's blob must also reach storage: otherwise the manifest uploaded after this
  // sync claims a path pointing at a blob that doesn't exist, and every other device fails
  // forever trying to pull it.
  assert.equal(objects.get(blobKeyFor(copyHash)), wrapped("local edit"));
  // Recorded at the hash of the copy's own bytes, the same race a push closes: the conflict copy
  // is read fresh at execution time, never assumed from a pre-sync snapshot.
  assert.deepEqual(pushedFiles, [
    {
      path: conflictCopyPath("a.md", now),
      size: "local edit".length,
      mtime: now,
      hash: copyHash,
      blob: copyHash,
    },
  ]);
});

test("executeSyncPlan: a conflict with nothing local to preserve just pulls the remote version, never reading a deleted local file", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const hash = await hashOf("remote edit");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", hash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "local" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "remote edit");
  assert.equal(files.has(conflictCopyPath("a.md", now)), false);
});

test("executeSyncPlan: a conflict restore onto a path recreated after the snapshot is refused", async () => {
  // The snapshot saw this path as locally deleted, so the plan restores the remote edit with
  // nothing to preserve; the user recreated the file before the plan reached this action, and no
  // remote snapshot is supplied either, so the fetch refuses before that recreated file is touched.
  const reader = fakeReader({ "a.md": "recreated after snapshot" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "recreated after snapshot");
  const { storage } = fakeStorage();
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "local" }],
    empty,
    reader,
    writer,
    storage,
    now,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "manifest missing expected hash for this path" },
  ]);
  assert.equal(files.get("a.md"), "recreated after snapshot");
});

test("executeSyncPlan: a conflict restore onto a path recreated after the snapshot is refused even with a real remote entry", async () => {
  // Same scenario as above with a real remote entry present, so the fetch succeeds and it is
  // checkLocalDrift that must catch the recreated local file.
  const reader = fakeReader({ "a.md": "recreated after snapshot" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "recreated after snapshot");
  const hash = await hashOf("remote edit");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", hash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "local" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "recreated after snapshot");
});

test("executeSyncPlan: a conflict restore onto a path recreated after its own rename is refused, and the recreated file survives", async () => {
  // The window the "create" commit exists for: between the rename that vacates the path and the
  // commit landing the remote version, ample room exists for a note to appear at the same path,
  // one the restore must refuse rather than silently replace.
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const innerRename = writer.renameFile;
  writer.renameFile = async (path, newPath) => {
    await innerRename(path, newPath);
    files.set(path, "recreated mid sync");
  };
  const remoteHash = await hashOf("remote edit");
  const { storage, objects } = fakeStorage({ [blobKeyFor(remoteHash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", remoteHash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { completed, failures, pushedFiles } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.deepEqual(completed, []);
  assert.equal(files.get("a.md"), "recreated mid sync");
  // Neither of the other two versions is lost: the local edit is still under its copy name and in
  // the bucket, and the next sync sees the recreated file as a local change and replans it as an
  // ordinary conflict.
  const copyHash = await hashOf("local edit");
  assert.equal(files.get(conflictCopyPath("a.md", now)), "local edit");
  assert.equal(objects.get(blobKeyFor(copyHash)), wrapped("local edit"));
  assert.deepEqual(pushedFiles, [
    {
      path: conflictCopyPath("a.md", now),
      size: "local edit".length,
      mtime: now,
      hash: copyHash,
      blob: copyHash,
    },
  ]);
});

test("executeSyncPlan: a conflict restore is refused by its commit even when the recreated file is too new for the reader to see", async () => {
  // checkLocalDrift reads through Obsidian's file index, which lags a file by however long the
  // index takes to notice it, so a file already on disk but not yet indexed needs the writer's own
  // "create" commit check to stop the restore.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "created but not yet indexed");
  const hash = await hashOf("remote edit");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", hash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "local" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "created but not yet indexed");
});

test("executeSyncPlan: an ordinary pull still replaces the file its plan decided to move on from", async () => {
  // The counterpart to the restore's "create": a pull's whole job is to install over content
  // checkLocalDrift already confirmed matches the snapshot, so refusing an occupied destination
  // here would break every update of an existing note.
  const reader = fakeReader({ "a.md": "as snapshotted" });
  const local = snapshot(file("a.md", await hashOf("as snapshotted")));
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "as snapshotted");
  const hash = await hashOf("remote edit");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "remote edit");
});

test("executeSyncPlan: a conflict with nothing remote to pull preserves the local edit as a copy and reports no failure", async () => {
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const { storage, objects } = fakeStorage();
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "remote" }],
    empty,
    reader,
    writer,
    storage,
    now,
  );

  const copyHash = await hashOf("local edit");
  assert.deepEqual(failures, []);
  assert.equal(files.has("a.md"), false);
  assert.equal(files.get(conflictCopyPath("a.md", now)), "local edit");
  assert.equal(objects.get(blobKeyFor(copyHash)), wrapped("local edit"));
});

test("executeSyncPlan: a push whose local file vanished is reported and doesn't stop the rest of the plan", async () => {
  // a.md is gone from the reader (a user deleted it between the snapshot and now), so readFile
  // throws. Before the fix that exception escaped executeSyncPlan and abandoned b.md; it must
  // instead be recorded as a per file failure and the loop must carry on.
  const reader = fakeReader({ "b.md": "world" });
  const { writer } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();

  const actions: SyncAction[] = [
    { kind: "push", path: "a.md" },
    { kind: "push", path: "b.md" },
  ];
  const { failures } = await executeSyncPlan(actions, empty, reader, writer, storage, 1);

  const worldHash = await hashOf("world");
  assert.deepEqual(failures, [{ path: "a.md", message: "no such file: a.md" }]);
  assert.equal(objects.get(blobKeyFor(worldHash)), wrapped("world"));
});

test("executeSyncPlan: a conflict whose local file vanished is reported, nothing is renamed or pushed, and the plan continues", async () => {
  // The conflict path also reads local bytes to preserve them. If that file vanished first, the
  // read throws: it must be reported, the rename/push skipped so no partial state is left behind,
  // and the following action still run.
  const reader = fakeReader({ "b.md": "world" });
  const { writer, files } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const actions: SyncAction[] = [
    { kind: "conflict", path: "a.md", deletedSide: "none" },
    { kind: "push", path: "b.md" },
  ];
  const { failures } = await executeSyncPlan(actions, empty, reader, writer, storage, now);

  const worldHash = await hashOf("world");
  assert.deepEqual(failures, [{ path: "a.md", message: "no such file: a.md" }]);
  // No conflict copy was created locally or remotely from a file that wasn't there to preserve.
  assert.equal(files.has(conflictCopyPath("a.md", now)), false);
  // The following action still ran.
  assert.equal(objects.get(blobKeyFor(worldHash)), wrapped("world"));
});

test("executeSyncPlan: a failed push is reported and doesn't stop the rest of the plan", async () => {
  const reader = fakeReader({ "a.md": "hello", "b.md": "world" });
  const { writer, files } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();
  const helloHash = await hashOf("hello");
  storage.putObject = async (key, body) => {
    if (key === blobKeyFor(helloHash)) {
      return { ok: false, status: "server", message: "Storage rejected the write (500)" };
    }
    objects.set(key, new TextDecoder().decode(body));
    return { ok: true, status: "ok", message: "" };
  };

  const actions: SyncAction[] = [
    { kind: "push", path: "a.md" },
    { kind: "push", path: "b.md" },
  ];
  const { completed, failed, failures } = await executeSyncPlan(
    actions,
    empty,
    reader,
    writer,
    storage,
    1,
  );

  const worldHash = await hashOf("world");
  assert.deepEqual(failures, [{ path: "a.md", message: "Storage rejected the write (500)" }]);
  assert.equal(objects.get(blobKeyFor(worldHash)), wrapped("world"));
  assert.equal(files.size, 0);
  // The pass reports exactly which actions completed and which didn't, so syncOnce can record
  // b.md's progress in the manifest while leaving a.md pending for the next pass.
  assert.deepEqual(completed, [{ kind: "push", path: "b.md" }]);
  assert.deepEqual(failed, [{ kind: "push", path: "a.md" }]);
});

test("executeSyncPlan: a conflict whose copy push fails is a failed action, even though the failure names the copy path", async () => {
  // The copy push failure is recorded against copyPath, not the action's own path; failed must
  // still carry the action itself, so syncOnce reverts the right path and the manifest never
  // claims a copy pointing at a blob the bucket refused.
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const remoteHash = await hashOf("remote edit");
  const { storage, objects } = fakeStorage({ [blobKeyFor(remoteHash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", remoteHash));
  storage.putObject = async () => ({
    ok: false,
    status: "server",
    message: "Storage rejected the write (500)",
  });
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const action: SyncAction = { kind: "conflict", path: "a.md", deletedSide: "none" };
  const { completed, failed, failures } = await executeSyncPlan(
    [action],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  const copyHash = await hashOf("local edit");
  assert.deepEqual(failures, [
    { path: conflictCopyPath("a.md", now), message: "Storage rejected the write (500)" },
  ]);
  assert.deepEqual(completed, []);
  assert.deepEqual(failed, [action]);
  // The remote version still landed locally, and the local edit survived under its copy name,
  // ready to push next pass.
  assert.equal(files.get("a.md"), "remote edit");
  assert.equal(files.get(conflictCopyPath("a.md", now)), "local edit");
  assert.equal(objects.has(blobKeyFor(copyHash)), false);
});

test("executeSyncPlan: a pull whose local write throws is reported and doesn't stop the rest of the plan", async () => {
  // A commit can throw on a disk full or permission error. Like every storage failure, that must
  // be recorded as a per file failure rather than escaping the loop and abandoning b.md.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  writer.stageFile = async (path) => {
    return {
      commit: async () => {
        if (path === "a.md") {
          throw new Error("EACCES: permission denied");
        }
        files.set(path, "pulled");
      },
      discard: async () => {},
    };
  };
  const aHash = await hashOf("remote a");
  const bHash = await hashOf("remote b");
  const { storage } = fakeStorage({
    [blobKeyFor(aHash)]: wrapped("remote a"),
    [blobKeyFor(bHash)]: wrapped("remote b"),
  });
  const remote = snapshot(file("a.md", aHash), file("b.md", bHash));

  const actions: SyncAction[] = [
    { kind: "pull", path: "a.md" },
    { kind: "pull", path: "b.md" },
  ];
  const { failures } = await executeSyncPlan(actions, empty, reader, writer, storage, 1, remote);

  assert.deepEqual(failures, [{ path: "a.md", message: "EACCES: permission denied" }]);
  assert.equal(files.get("b.md"), "pulled");
});

test("executeSyncPlan: a conflict whose rename throws is reported and the local edit is never overwritten", async () => {
  // If the rename that vacates the local path throws, the local edit is still sitting there. The
  // failure must be reported and the staged remote version thrown away rather than committed,
  // otherwise the remote version would clobber a diverged edit we failed to preserve.
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  writer.renameFile = async () => {
    throw new Error("EACCES: permission denied");
  };
  const hash = await hashOf("remote edit");
  const { storage, objects } = fakeStorage({ [blobKeyFor(hash)]: wrapped("remote edit") });
  const remote = snapshot(file("a.md", hash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  const copyHash = await hashOf("local edit");
  assert.deepEqual(failures, [{ path: "a.md", message: "EACCES: permission denied" }]);
  // The local edit is untouched and the remote version never overwrote it.
  assert.equal(files.get("a.md"), "local edit");
  assert.equal(objects.has(blobKeyFor(copyHash)), false);
});

test("executeSyncPlan: pull with matching hash writes the file to disk", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("hello") });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "hello");
});

test("executeSyncPlan: pull with hash mismatch is refused and nothing is written to disk", async () => {
  // The blob key claims to hold "correct content"'s hash but the bytes under it don't match:
  // storage corruption, essentially impossible in the real world once the key is the hash, but
  // still checked rather than trusted blind.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const correctHash = await hashOf("correct content");
  const { storage } = fakeStorage({ [blobKeyFor(correctHash)]: wrapped("wrong content") });
  const remote = snapshot(file("a.md", correctHash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, [
    {
      path: "a.md",
      message: "fetched bytes do not match manifest hash; sync again to reconcile",
    },
  ]);
  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: pull of a blob that isn't a geode object is refused, never written as content", async () => {
  // Whatever is at this key carries no envelope, so it is another tool's object or a truncated
  // one. Handing its bytes on would write them straight into the vault.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: "hello" });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "stored blob is not in geode's object format" },
  ]);
  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: pull of a blob a newer build wrote reports needing an update, not damage", async () => {
  // An envelope this build can read the header of but not the payload of: the bucket was written
  // by a geode that knows a suite this one doesn't, which at 0.3.0 is an encrypted vault. The fix
  // is updating the plugin, so it must not be reported as corruption.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const newerSuite = new Uint8Array([0x47, 0x45, 0x4f, 0x44, 0x01, 0x09, 0x68, 0x69]);
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: new TextDecoder().decode(newerSuite) });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "stored blob is a format this version of geode can't read" },
  ]);
  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: pull with truncated body is refused and nothing is written to disk", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("hel") });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, [
    {
      path: "a.md",
      message: "fetched bytes do not match manifest hash; sync again to reconcile",
    },
  ]);
  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: pull refuses when the manifest has moved on, rather than writing stale content", async () => {
  // A stale etag simulates another device completing a whole sync between this pass reading the
  // manifest and this pull committing.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({
    [blobKeyFor(hash)]: wrapped("hello"),
    [MANIFEST_KEY]: "irrelevant",
  });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
    '"stale-etag"',
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed remotely mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: pull proceeds when the manifest etag still matches what the plan was made from", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({
    [blobKeyFor(hash)]: wrapped("hello"),
    [MANIFEST_KEY]: "current",
  });
  const remote = snapshot(file("a.md", hash));
  const manifestHead = await storage.headObject(MANIFEST_KEY);

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
    manifestHead.etag,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "hello");
});

test("executeSyncPlan: a pull whose local file is edited while its payload stages is refused, and the edit survives", async () => {
  // The window staging closes: on a large attachment the payload write is nearly the whole pull,
  // so an edit landing inside it would be checked for before it existed and then overwritten.
  const readerFiles: Record<string, string> = { "a.md": "as snapshotted" };
  const reader = fakeReader(readerFiles);
  const local = snapshot(file("a.md", await hashOf("as snapshotted")));
  const { writer, files } = fakeLocalWriter();
  let discarded = 0;
  const innerStage = writer.stageFile;
  writer.stageFile = async (path, data, mode) => {
    readerFiles["a.md"] = "edited while staging";
    const staged = await innerStage(path, data, mode);

    return {
      commit: staged.commit,
      discard: async () => {
        discarded++;
        await staged.discard();
      },
    };
  };
  const hash = await hashOf("remote a");
  const { storage } = fakeStorage({ [blobKeyFor(hash)]: wrapped("remote a") });
  const remote = snapshot(file("a.md", hash));

  const { failures, completed } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    remote,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.deepEqual(completed, []);
  assert.equal(files.has("a.md"), false);
  assert.equal(readerFiles["a.md"], "edited while staging");
  assert.equal(discarded, 1);
});

test("executeSyncPlan: a pull stages its payload, then checks cheapest-last, and commits only after every check", async () => {
  // The ordering asserted directly, since every other test here can only observe its consequences.
  const ops: string[] = [];
  const baseReader = fakeReader({ "a.md": "as snapshotted" });
  const reader: Reader = {
    ...baseReader,
    readFile: async (path) => {
      ops.push("hashLocal");
      return baseReader.readFile(path);
    },
    stat: async (path) => {
      ops.push("statLocal");
      return baseReader.stat(path);
    },
  };
  const { writer, files } = fakeLocalWriter();
  const innerStage = writer.stageFile;
  writer.stageFile = async (path, data, mode) => {
    ops.push("stage");
    const staged = await innerStage(path, data, mode);

    return {
      commit: async () => {
        ops.push("commit");
        await staged.commit();
      },
      discard: staged.discard,
    };
  };
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({
    [blobKeyFor(hash)]: wrapped("hello"),
    [MANIFEST_KEY]: "current",
  });
  const innerHead = storage.headObject;
  storage.headObject = async (key) => {
    if (key === MANIFEST_KEY) {
      ops.push("checkManifest");
    }
    return innerHead(key);
  };
  const manifestHead = await storage.headObject(MANIFEST_KEY);
  ops.length = 0;
  const remote = snapshot(file("a.md", hash));
  const local = snapshot({
    path: "a.md",
    size: "as snapshotted".length,
    mtime: 1,
    hash: await hashOf("as snapshotted"),
    blob: await hashOf("as snapshotted"),
  });

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    remote,
    manifestHead.etag,
  );

  assert.deepEqual(failures, []);
  // The stat either side of hashLocal is checkLocalDrift bracketing its own read; the one after
  // checkManifest is the confirmation, and nothing but the commit follows it.
  assert.deepEqual(ops, [
    "stage",
    "statLocal",
    "hashLocal",
    "statLocal",
    "checkManifest",
    "statLocal",
    "commit",
  ]);
  assert.equal(files.get("a.md"), "hello");
});

test("executeSyncPlan: a pull whose local file is edited while the manifest check is in flight is refused", async () => {
  // The half of the guarantee the content hash cannot cover: an edit landing during the manifest
  // round trip that follows it. The index only confirmation after that HEAD is what catches it.
  const readerFiles: Record<string, string> = { "a.md": "as snapshotted" };
  const reader = fakeReader(readerFiles);
  const local = snapshot({
    path: "a.md",
    size: "as snapshotted".length,
    mtime: 1,
    hash: await hashOf("as snapshotted"),
    blob: await hashOf("as snapshotted"),
  });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "as snapshotted");
  const hash = await hashOf("remote a");
  const { storage } = fakeStorage({
    [blobKeyFor(hash)]: wrapped("remote a"),
    [MANIFEST_KEY]: "current",
  });
  const head = await storage.headObject(MANIFEST_KEY);
  const innerHead = storage.headObject;
  storage.headObject = async (key) => {
    if (key === MANIFEST_KEY) {
      readerFiles["a.md"] = "edited during the manifest check";
    }
    return innerHead(key);
  };
  const remote = snapshot(file("a.md", hash));

  const { failures, completed } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    remote,
    head.etag,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.deepEqual(completed, []);
  assert.equal(files.get("a.md"), "as snapshotted");
  assert.equal(readerFiles["a.md"], "edited during the manifest check");
});

test("executeSyncPlan: a pull refused when the edit landing during the manifest check keeps the byte length", async () => {
  // A typo fixed in place rewrites a note without changing its length, so an existence and size
  // comparison would wave it through. The mtime is what makes the final check a real guard.
  const readerFiles: Record<string, string> = { "a.md": "hello world" };
  const readerMtimes: Record<string, number> = { "a.md": 1 };
  const reader = fakeReader(readerFiles, readerMtimes);
  const local = snapshot({
    path: "a.md",
    size: "hello world".length,
    mtime: 1,
    hash: await hashOf("hello world"),
    blob: await hashOf("hello world"),
  });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "hello world");
  const hash = await hashOf("remote a");
  const { storage } = fakeStorage({
    [blobKeyFor(hash)]: wrapped("remote a"),
    [MANIFEST_KEY]: "current",
  });
  const head = await storage.headObject(MANIFEST_KEY);
  const innerHead = storage.headObject;
  storage.headObject = async (key) => {
    if (key === MANIFEST_KEY) {
      readerFiles["a.md"] = "hello werld";
      readerMtimes["a.md"] = 2;
    }
    return innerHead(key);
  };
  const remote = snapshot(file("a.md", hash));

  const { failures, completed } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    remote,
    head.etag,
  );

  assert.equal("hello werld".length, "hello world".length);
  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.deepEqual(completed, []);
  assert.equal(files.get("a.md"), "hello world");
});

test("executeSyncPlan: a pullDelete refused when the edit landing during the manifest check keeps the byte length", async () => {
  // The same rewrite guarding a deletion, where losing it trashes the file the user was mid edit
  // on rather than overwriting one save.
  const readerFiles: Record<string, string> = { "a.md": "hello world" };
  const readerMtimes: Record<string, number> = { "a.md": 1 };
  const reader = fakeReader(readerFiles, readerMtimes);
  const local = snapshot({
    path: "a.md",
    size: "hello world".length,
    mtime: 1,
    hash: await hashOf("hello world"),
    blob: await hashOf("hello world"),
  });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "hello world");
  const { storage } = fakeStorage({ [MANIFEST_KEY]: "current" });
  const head = await storage.headObject(MANIFEST_KEY);
  const innerHead = storage.headObject;
  storage.headObject = async (key) => {
    if (key === MANIFEST_KEY) {
      readerFiles["a.md"] = "hello werld";
      readerMtimes["a.md"] = 2;
    }
    return innerHead(key);
  };

  const { failures } = await executeSyncPlan(
    [{ kind: "pullDelete", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    empty,
    head.etag,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "hello world");
});

test("executeSyncPlan: a pullDelete whose local file is edited while the manifest check is in flight is refused", async () => {
  // The same window guarding a deletion rather than a write, where losing it costs the user the
  // file itself rather than one edit.
  const readerFiles: Record<string, string> = { "a.md": "as snapshotted" };
  const reader = fakeReader(readerFiles);
  const local = snapshot({
    path: "a.md",
    size: "as snapshotted".length,
    mtime: 1,
    hash: await hashOf("as snapshotted"),
    blob: await hashOf("as snapshotted"),
  });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "as snapshotted");
  const { storage } = fakeStorage({ [MANIFEST_KEY]: "current" });
  const head = await storage.headObject(MANIFEST_KEY);
  const innerHead = storage.headObject;
  storage.headObject = async (key) => {
    if (key === MANIFEST_KEY) {
      readerFiles["a.md"] = "edited during the manifest check";
    }
    return innerHead(key);
  };

  const { failures } = await executeSyncPlan(
    [{ kind: "pullDelete", path: "a.md" }],
    local,
    reader,
    writer,
    storage,
    1,
    empty,
    head.etag,
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed locally mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "as snapshotted");
});

test("executeSyncPlan: a conflict fetches, stages and checks the manifest before it vacates the path", async () => {
  // Every slow and fallible step runs while the local edit still sits at its own path, so the
  // interval in which that path stands empty is two adjacent renames rather than a download.
  const ops: string[] = [];
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const innerStage = writer.stageFile;
  writer.stageFile = async (path, data, mode) => {
    ops.push("stage");
    const staged = await innerStage(path, data, mode);

    return {
      commit: async () => {
        ops.push("commit");
        await staged.commit();
      },
      discard: staged.discard,
    };
  };
  const innerRename = writer.renameFile;
  writer.renameFile = async (path, newPath) => {
    ops.push("rename");
    await innerRename(path, newPath);
  };
  const remoteHash = await hashOf("remote edit");
  const { storage } = fakeStorage({
    [blobKeyFor(remoteHash)]: wrapped("remote edit"),
    [MANIFEST_KEY]: "current",
  });
  const head = await storage.headObject(MANIFEST_KEY);
  const innerGet = storage.getObject;
  storage.getObject = async (key, size) => {
    ops.push("fetch");
    return innerGet(key, size);
  };
  const innerHead = storage.headObject;
  storage.headObject = async (key) => {
    if (key === MANIFEST_KEY) {
      ops.push("checkManifest");
    }
    return innerHead(key);
  };
  const innerPut = storage.putObject;
  storage.putObject = async (key, body, condition) => {
    ops.push("pushCopy");
    return innerPut(key, body, condition);
  };
  const remote = snapshot(file("a.md", remoteHash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
    head.etag,
  );

  assert.deepEqual(failures, []);
  assert.deepEqual(ops, ["fetch", "stage", "checkManifest", "rename", "commit", "pushCopy"]);
  assert.equal(files.get("a.md"), "remote edit");
  assert.equal(files.get(conflictCopyPath("a.md", now)), "local edit");
});

test("executeSyncPlan: a pull refused by manifest drift discards its staged payload", async () => {
  // A refused write must not leave its staging file behind holding a copy of remote content. The
  // path is deterministic so a leftover would eventually be reclaimed, but "eventually" means the
  // next pull of the same path, which may never come.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  let discarded = 0;
  const innerStage = writer.stageFile;
  writer.stageFile = async (path, data, mode) => {
    const staged = await innerStage(path, data, mode);

    return {
      commit: staged.commit,
      discard: async () => {
        discarded++;
        await staged.discard();
      },
    };
  };
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({
    [blobKeyFor(hash)]: wrapped("hello"),
    [MANIFEST_KEY]: "irrelevant",
  });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
    '"stale-etag"',
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed remotely mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.has("a.md"), false);
  assert.equal(discarded, 1);
});

test("executeSyncPlan: a discard that itself fails never masks the failure that refused the write", async () => {
  // discardStaged swallows its own errors on purpose: the caller is already returning the reason
  // the write was refused, and that reason is the one worth reporting. A throwing discard must not
  // replace it, nor escape the loop and abandon the rest of the plan.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const innerStage = writer.stageFile;
  writer.stageFile = async (path, data, mode) => {
    const staged = await innerStage(path, data, mode);

    return {
      commit: staged.commit,
      discard: async () => {
        throw new Error("EACCES: cannot remove staged file");
      },
    };
  };
  const hash = await hashOf("hello");
  const { storage } = fakeStorage({
    [blobKeyFor(hash)]: wrapped("hello"),
    [MANIFEST_KEY]: "irrelevant",
  });
  const remote = snapshot(file("a.md", hash));

  const { failures } = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    empty,
    reader,
    writer,
    storage,
    1,
    remote,
    '"stale-etag"',
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed remotely mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: a conflict restore refuses when the manifest has moved on, leaving the vault exactly as it was", async () => {
  // The manifest is confirmed before the local edit moves, so a stale plan costs nothing locally
  // and the whole conflict is replanned next pass.
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const hash = await hashOf("remote edit");
  const { storage, objects } = fakeStorage({
    [blobKeyFor(hash)]: wrapped("remote edit"),
    [MANIFEST_KEY]: "irrelevant",
  });
  const remote = snapshot(file("a.md", hash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures, pushedFiles } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
    '"stale-etag"',
  );

  assert.deepEqual(failures, [
    { path: "a.md", message: "changed remotely mid sync; sync again to reconcile" },
  ]);
  assert.equal(files.get("a.md"), "local edit");
  assert.equal(files.has(conflictCopyPath("a.md", now)), false);
  assert.equal(objects.has(blobKeyFor(await hashOf("local edit"))), false);
  assert.deepEqual(pushedFiles, []);
});

test("executeSyncPlan: conflict restore with hash mismatch is refused and nothing is written", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const correctHash = await hashOf("correct content");
  const { storage } = fakeStorage({ [blobKeyFor(correctHash)]: wrapped("wrong content") });
  const remote = snapshot(file("a.md", correctHash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "local" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  assert.deepEqual(failures, [
    {
      path: "a.md",
      message: "fetched bytes do not match manifest hash; sync again to reconcile",
    },
  ]);
  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: conflict with hash mismatch on remote restore leaves the local edit where the user left it", async () => {
  // The fetch and its integrity check run before anything local moves, so corrupt remote bytes
  // leave the local edit untouched and the conflict simply replans next pass.
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const correctHash = await hashOf("correct content");
  const { storage, objects } = fakeStorage({ [blobKeyFor(correctHash)]: wrapped("wrong content") });
  const remote = snapshot(file("a.md", correctHash));
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const { failures, completed, pushedFiles } = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    empty,
    reader,
    writer,
    storage,
    now,
    remote,
  );

  assert.deepEqual(failures, [
    {
      path: "a.md",
      message: "fetched bytes do not match manifest hash; sync again to reconcile",
    },
  ]);
  assert.equal(files.get("a.md"), "local edit");
  assert.equal(files.has(conflictCopyPath("a.md", now)), false);
  assert.equal(objects.has(blobKeyFor(await hashOf("local edit"))), false);
  assert.deepEqual(completed, []);
  assert.deepEqual(pushedFiles, []);
});

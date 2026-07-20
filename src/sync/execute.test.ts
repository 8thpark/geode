import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSyncPlan } from "./execute.ts";
import { fakeLocalWriter, fakeReader, fakeStorage } from "./fake.ts";
import { conflictCopyPath, type SyncAction } from "./plan.ts";

test("executeSyncPlan: push reads the local file and puts it remotely", async () => {
  const reader = fakeReader({ "a.md": "hello" });
  const { writer, files } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();

  const failures = await executeSyncPlan(
    [{ kind: "push", path: "a.md" }],
    reader,
    writer,
    storage,
    1,
  );

  assert.deepEqual(failures, []);
  assert.equal(objects.get("a.md"), "hello");
  assert.equal(files.size, 0);
});

test("executeSyncPlan: pushDelete removes the remote object", async () => {
  const reader = fakeReader({});
  const { writer } = fakeLocalWriter();
  const { storage, objects } = fakeStorage({ "a.md": "hello" });

  await executeSyncPlan([{ kind: "pushDelete", path: "a.md" }], reader, writer, storage, 1);

  assert.equal(objects.has("a.md"), false);
});

test("executeSyncPlan: pull fetches the remote object and writes it locally", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const { storage } = fakeStorage({ "a.md": "hello" });

  const failures = await executeSyncPlan(
    [{ kind: "pull", path: "a.md" }],
    reader,
    writer,
    storage,
    1,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "hello");
});

test("executeSyncPlan: pullDelete removes the local file", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "hello");
  const { storage } = fakeStorage();

  await executeSyncPlan([{ kind: "pullDelete", path: "a.md" }], reader, writer, storage, 1);

  assert.equal(files.has("a.md"), false);
});

test("executeSyncPlan: a conflict renames the local copy, pushes it to storage, and pulls the remote version clean", async () => {
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const { storage, objects } = fakeStorage({ "a.md": "remote edit" });
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const failures = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    reader,
    writer,
    storage,
    now,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "remote edit");
  assert.equal(files.get(conflictCopyPath("a.md", now)), "local edit");
  // The conflict copy must also reach storage: otherwise the manifest uploaded after this sync
  // claims a remote object that doesn't exist, and every other device fails forever trying to
  // pull it.
  assert.equal(objects.get(conflictCopyPath("a.md", now)), "local edit");
});

test("executeSyncPlan: a conflict with nothing local to preserve just pulls the remote version, never reading a deleted local file", async () => {
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  const { storage } = fakeStorage({ "a.md": "remote edit" });
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const failures = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "local" }],
    reader,
    writer,
    storage,
    now,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.get("a.md"), "remote edit");
  assert.equal(files.has(conflictCopyPath("a.md", now)), false);
});

test("executeSyncPlan: a conflict with nothing remote to pull preserves the local edit as a copy and reports no failure", async () => {
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  const { storage, objects } = fakeStorage();
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const failures = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "remote" }],
    reader,
    writer,
    storage,
    now,
  );

  assert.deepEqual(failures, []);
  assert.equal(files.has("a.md"), false);
  assert.equal(files.get(conflictCopyPath("a.md", now)), "local edit");
  assert.equal(objects.get(conflictCopyPath("a.md", now)), "local edit");
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
  const failures = await executeSyncPlan(actions, reader, writer, storage, 1);

  assert.deepEqual(failures, [{ path: "a.md", message: "no such file: a.md" }]);
  assert.equal(objects.get("b.md"), "world");
  assert.equal(objects.has("a.md"), false);
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
  const failures = await executeSyncPlan(actions, reader, writer, storage, now);

  assert.deepEqual(failures, [{ path: "a.md", message: "no such file: a.md" }]);
  // No conflict copy was created locally or remotely from a file that wasn't there to preserve.
  assert.equal(files.has(conflictCopyPath("a.md", now)), false);
  assert.equal(objects.has(conflictCopyPath("a.md", now)), false);
  // The following action still ran.
  assert.equal(objects.get("b.md"), "world");
});

test("executeSyncPlan: a failed push is reported and doesn't stop the rest of the plan", async () => {
  const reader = fakeReader({ "a.md": "hello", "b.md": "world" });
  const { writer, files } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();
  storage.putObject = async (key) => {
    if (key === "a.md") {
      return { ok: false, status: "server", message: "Storage rejected the write (500)" };
    }
    objects.set(key, "world");
    return { ok: true, status: "ok", message: "" };
  };

  const actions: SyncAction[] = [
    { kind: "push", path: "a.md" },
    { kind: "push", path: "b.md" },
  ];
  const failures = await executeSyncPlan(actions, reader, writer, storage, 1);

  assert.deepEqual(failures, [{ path: "a.md", message: "Storage rejected the write (500)" }]);
  assert.equal(objects.get("b.md"), "world");
  assert.equal(files.size, 0);
});

test("executeSyncPlan: a pull whose local write throws is reported and doesn't stop the rest of the plan", async () => {
  // writeFile can throw on a disk full or permission error. Like every storage failure, that must
  // be recorded as a per file failure rather than escaping the loop and abandoning b.md.
  const reader = fakeReader({});
  const { writer, files } = fakeLocalWriter();
  writer.writeFile = async (path) => {
    if (path === "a.md") {
      throw new Error("EACCES: permission denied");
    }
    files.set(path, "pulled");
  };
  const { storage } = fakeStorage({ "a.md": "remote a", "b.md": "remote b" });

  const actions: SyncAction[] = [
    { kind: "pull", path: "a.md" },
    { kind: "pull", path: "b.md" },
  ];
  const failures = await executeSyncPlan(actions, reader, writer, storage, 1);

  assert.deepEqual(failures, [{ path: "a.md", message: "EACCES: permission denied" }]);
  assert.equal(files.get("b.md"), "pulled");
});

test("executeSyncPlan: a conflict whose rename throws is reported and the local edit is never overwritten", async () => {
  // If the rename that vacates the local path throws, the local edit is still sitting there. We
  // must report the failure and skip the pull, otherwise the remote version would clobber a
  // diverged edit we failed to preserve.
  const reader = fakeReader({ "a.md": "local edit" });
  const { writer, files } = fakeLocalWriter();
  files.set("a.md", "local edit");
  writer.renameFile = async () => {
    throw new Error("EACCES: permission denied");
  };
  const { storage, objects } = fakeStorage({ "a.md": "remote edit" });
  const now = Date.parse("2026-07-14T10:00:00.000Z");

  const failures = await executeSyncPlan(
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    reader,
    writer,
    storage,
    now,
  );

  assert.deepEqual(failures, [{ path: "a.md", message: "EACCES: permission denied" }]);
  // The local edit is untouched and the remote version never overwrote it.
  assert.equal(files.get("a.md"), "local edit");
  assert.equal(objects.has(conflictCopyPath("a.md", now)), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DeleteResult,
  GetResult,
  ListResult,
  PutResult,
  StorageClient,
} from "./storage/storage.ts";
import {
  conflictCopyPath,
  executeSyncPlan,
  type LocalWriter,
  MANIFEST_KEY,
  planSync,
  readRemoteManifest,
  type SyncAction,
  syncOnce,
} from "./sync.ts";
import type { FileState, Reader, Snapshot } from "./vault/vault.ts";

const empty: Snapshot = { files: [] };

function file(path: string, hash: string): FileState {
  return { path, size: hash.length, mtime: 1, hash };
}

function snapshot(...files: FileState[]): Snapshot {
  return { files };
}

test("planSync: a path only changed locally is pushed", () => {
  const previous = empty;
  const local = snapshot(file("a.md", "h1"));
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "push", path: "a.md" }]);
});

test("planSync: a local deletion pushes the delete", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = empty;
  const remote = snapshot(file("a.md", "h1"));

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "pushDelete", path: "a.md" }]);
});

test("planSync: a path only changed remotely is pulled", () => {
  const previous = empty;
  const local = empty;
  const remote = snapshot(file("a.md", "h1"));

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "pull", path: "a.md" }]);
});

test("planSync: a remote deletion pulls the delete", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h1"));
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "pullDelete", path: "a.md" }]);
});

test("planSync: both sides changed to identical content needs no action", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h2"));
  const remote = snapshot(file("a.md", "h2"));

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("planSync: both sides changed to different content is a conflict", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h2"));
  const remote = snapshot(file("a.md", "h3"));

  assert.deepEqual(planSync(previous, local, remote), [
    { kind: "conflict", path: "a.md", deletedSide: "none" },
  ]);
});

test("planSync: deleted locally but modified remotely is a conflict with nothing local to preserve", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = empty;
  const remote = snapshot(file("a.md", "h2"));

  assert.deepEqual(planSync(previous, local, remote), [
    { kind: "conflict", path: "a.md", deletedSide: "local" },
  ]);
});

test("planSync: modified locally but deleted remotely is a conflict with nothing remote to pull", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h2"));
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), [
    { kind: "conflict", path: "a.md", deletedSide: "remote" },
  ]);
});

test("planSync: deleted independently on both sides needs no reconciliation", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = empty;
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("planSync: the manifest's own path is never turned into an action", () => {
  const previous = empty;
  const local = snapshot(file(MANIFEST_KEY, "h1"));
  const remote = snapshot(file(MANIFEST_KEY, "h2"));

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("conflictCopyPath: keeps the extension", () => {
  assert.equal(
    conflictCopyPath("notes/todo.md", Date.parse("2026-07-14T10:00:00.000Z")),
    "notes/todo (conflicted copy 2026-07-14T10-00-00-000Z).md",
  );
});

test("conflictCopyPath: a file with no extension", () => {
  assert.equal(
    conflictCopyPath("notes/todo", Date.parse("2026-07-14T10:00:00.000Z")),
    "notes/todo (conflicted copy 2026-07-14T10-00-00-000Z)",
  );
});

test("conflictCopyPath: a dot in a folder name isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath("my.notes/todo", Date.parse("2026-07-14T10:00:00.000Z")),
    "my.notes/todo (conflicted copy 2026-07-14T10-00-00-000Z)",
  );
});

test("conflictCopyPath: a leading dot in the filename isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath("notes/.gitignore", Date.parse("2026-07-14T10:00:00.000Z")),
    "notes/.gitignore (conflicted copy 2026-07-14T10-00-00-000Z)",
  );
});

test("conflictCopyPath: a dotfile at the vault root isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath(".editorconfig", Date.parse("2026-07-14T10:00:00.000Z")),
    ".editorconfig (conflicted copy 2026-07-14T10-00-00-000Z)",
  );
});

// fakeReader returns a Reader backed by an in-memory map of path to content.
function fakeReader(files: Record<string, string>): Reader {
  return {
    listFiles: async () => {
      const list = [];
      for (const [path, content] of Object.entries(files)) {
        list.push({ path, size: content.length, mtime: 1 });
      }
      return list;
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return new TextEncoder().encode(content);
    },
  };
}

// fakeLocalWriter returns a LocalWriter backed by an in-memory map, and the map itself so tests
// can assert on the result.
function fakeLocalWriter(): { writer: LocalWriter; files: Map<string, string> } {
  const files = new Map<string, string>();
  const writer: LocalWriter = {
    writeFile: async (path, data) => {
      files.set(path, new TextDecoder().decode(data));
    },
    deleteFile: async (path) => {
      files.delete(path);
    },
    renameFile: async (path, newPath) => {
      const content = files.get(path);
      if (content !== undefined) {
        files.delete(path);
        files.set(newPath, content);
      }
    },
  };
  return { writer, files };
}

// fakeStorage returns a StorageClient backed by an in-memory map of key to content.
function fakeStorage(objects: Record<string, string> = {}): {
  storage: StorageClient;
  objects: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(objects));
  const storage: StorageClient = {
    putObject: async (key, body): Promise<PutResult> => {
      store.set(key, new TextDecoder().decode(body));
      return { ok: true, status: "ok", message: "" };
    },
    getObject: async (key): Promise<GetResult> => {
      const content = store.get(key);
      if (content === undefined) {
        return {
          ok: false,
          status: "not_found",
          message: "Storage rejected the read (404)",
          body: null,
        };
      }
      return { ok: true, status: "ok", message: "", body: new TextEncoder().encode(content) };
    },
    deleteObject: async (key): Promise<DeleteResult> => {
      store.delete(key);
      return { ok: true, status: "ok", message: "" };
    },
    listObjects: async (): Promise<ListResult> => {
      return { ok: true, status: "ok", message: "", objects: [] };
    },
  };
  return { storage, objects: store };
}

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

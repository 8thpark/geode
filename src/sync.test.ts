import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeleteResult, GetResult, ListResult, PutResult, StorageClient } from "./storage.ts";
import {
  conflictCopyPath,
  executeSyncPlan,
  type LocalWriter,
  MANIFEST_KEY,
  planSync,
  readRemoteManifest,
  type SyncAction,
} from "./sync.ts";
import type { FileState, VaultReader, VaultSnapshot } from "./vault-state.ts";

const empty: VaultSnapshot = { files: [] };

function file(path: string, hash: string): FileState {
  return { path, size: hash.length, mtime: 1, hash };
}

function snapshot(...files: FileState[]): VaultSnapshot {
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

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "conflict", path: "a.md" }]);
});

test("planSync: deleted locally but modified remotely is a conflict", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = empty;
  const remote = snapshot(file("a.md", "h2"));

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "conflict", path: "a.md" }]);
});

test("planSync: modified locally but deleted remotely is a conflict", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h2"));
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "conflict", path: "a.md" }]);
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

// fakeReader returns a VaultReader backed by an in-memory map of path to content.
function fakeReader(files: Record<string, string>): VaultReader {
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
      return { ok: true, message: "" };
    },
    getObject: async (key): Promise<GetResult> => {
      const content = store.get(key);
      if (content === undefined) {
        return { ok: false, message: "Storage rejected the read (404)", body: null };
      }
      return { ok: true, message: "", body: new TextEncoder().encode(content) };
    },
    deleteObject: async (key): Promise<DeleteResult> => {
      store.delete(key);
      return { ok: true, message: "" };
    },
    listObjects: async (): Promise<ListResult> => {
      return { ok: true, message: "", objects: [] };
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
    [{ kind: "conflict", path: "a.md" }],
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

test("executeSyncPlan: a failed push is reported and doesn't stop the rest of the plan", async () => {
  const reader = fakeReader({ "a.md": "hello", "b.md": "world" });
  const { writer, files } = fakeLocalWriter();
  const { storage, objects } = fakeStorage();
  storage.putObject = async (key) => {
    if (key === "a.md") {
      return { ok: false, message: "Storage rejected the write (500)" };
    }
    objects.set(key, "world");
    return { ok: true, message: "" };
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

test("readRemoteManifest: a 404 is treated as an empty snapshot", async () => {
  const { storage } = fakeStorage();

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: true, snapshot: { files: [] } });
});

test("readRemoteManifest: valid JSON is parsed into a snapshot", async () => {
  const want: VaultSnapshot = snapshot(file("a.md", "h1"));
  const { storage } = fakeStorage({ [MANIFEST_KEY]: JSON.stringify(want) });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: true, snapshot: want });
});

test("readRemoteManifest: corrupt JSON is reported as a failure, not an empty snapshot", async () => {
  const { storage } = fakeStorage({ [MANIFEST_KEY]: "not json" });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: false, message: "remote manifest is corrupt" });
});

test("readRemoteManifest: a non 404 failure is reported, never guessed at as empty", async () => {
  const { storage } = fakeStorage();
  storage.getObject = async () => ({
    ok: false,
    message: "Storage rejected the read (500)",
    body: null,
  });

  const result = await readRemoteManifest(storage);

  assert.deepEqual(result, { ok: false, message: "Storage rejected the read (500)" });
});

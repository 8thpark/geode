import { unwrapObject, wrapObject } from "../storage/envelope.ts";
import type {
  DeleteResult,
  GetResult,
  HeadResult,
  ListResult,
  ObjectMeta,
  PutResult,
  StorageClient,
} from "../storage/storage.ts";
import type { FileState, Reader, Snapshot } from "../vault/vault.ts";
import { DRIFT_MESSAGE, type LocalWriter } from "./execute.ts";

// empty is the zero snapshot: a vault with no files.
export const empty: Snapshot = { files: [] };

// fakeLocalWriter returns a LocalWriter backed by an in-memory map, and the map itself so tests
// can assert on the result. Staged content is held aside and only reaches files on commit, the same
// seam the real writer has, so a test asserting nothing landed on disk is really asserting the
// destination was never touched rather than that a write happened to be skipped. A "create" write
// refuses an occupied destination exactly as the real writer's adapter stat does, so a test can
// drive the case the real one exists for: a path recreated after a conflict's rename vacated it.
export function fakeLocalWriter(): { writer: LocalWriter; files: Map<string, string> } {
  const files = new Map<string, string>();
  const staged = new Map<string, string>();
  const writer: LocalWriter = {
    stageFile: async (path, data, mode) => {
      staged.set(path, new TextDecoder().decode(data));

      return {
        commit: async () => {
          const pending = staged.get(path);
          if (pending === undefined) {
            throw new Error(`nothing staged for ${path}`);
          }
          if (mode === "create" && files.has(path)) {
            throw new Error(DRIFT_MESSAGE);
          }
          staged.delete(path);
          files.set(path, pending);
        },
        discard: async () => {
          staged.delete(path);
        },
      };
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

// fakeReader returns a Reader backed by an in-memory map of path to content. mtimes carries the
// modification time of any path a test needs one for, defaulting to 1: a test simulating a mid sync
// edit sets both maps, exactly as a real editor save moves both content and mtime, which is what
// lets a same length rewrite still read as a change.
export function fakeReader(
  files: Record<string, string>,
  mtimes: Record<string, number> = {},
): Reader {
  function mtimeOf(path: string): number {
    const known = mtimes[path];
    if (known === undefined) {
      return 1;
    }

    return known;
  }

  return {
    listFiles: async () => {
      const list = [];
      for (const [path, content] of Object.entries(files)) {
        list.push({ path, size: content.length, mtime: mtimeOf(path) });
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
    stat: async (path) => {
      const content = files[path];
      if (content === undefined) {
        return { present: false, size: 0, mtime: 0 };
      }

      return { present: true, size: content.length, mtime: mtimeOf(path) };
    },
  };
}

// fakeStorage returns a StorageClient backed by an in-memory map of key to content. Etags are
// fake but real shaped: a quoted revision counter bumped on every write, so a conditional put
// detects a concurrent writer exactly the way a real ETag would.
export function fakeStorage(objects: Record<string, string> = {}): {
  storage: StorageClient;
  objects: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(objects));
  let revision = 0;
  const etags = new Map<string, string>();
  for (const key of store.keys()) {
    revision++;
    etags.set(key, `"v${revision}"`);
  }
  const storage: StorageClient = {
    putObject: async (key, body, condition): Promise<PutResult> => {
      if (condition !== undefined && condition.kind === "ifAbsent" && store.has(key)) {
        return { ok: false, status: "conflict", message: "Storage rejected the write (412)" };
      }
      if (
        condition !== undefined &&
        condition.kind === "ifMatch" &&
        etags.get(key) !== condition.etag
      ) {
        return { ok: false, status: "conflict", message: "Storage rejected the write (412)" };
      }
      revision++;
      etags.set(key, `"v${revision}"`);
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
          etag: null,
        };
      }
      let etag: string | null = null;
      const stored = etags.get(key);
      if (stored !== undefined) {
        etag = stored;
      }
      return {
        ok: true,
        status: "ok",
        message: "",
        body: new TextEncoder().encode(content),
        etag,
      };
    },
    headObject: async (key): Promise<HeadResult> => {
      if (!store.has(key)) {
        return {
          ok: false,
          status: "not_found",
          message: "Storage rejected the head (404)",
          etag: null,
        };
      }
      let etag: string | null = null;
      const stored = etags.get(key);
      if (stored !== undefined) {
        etag = stored;
      }
      return { ok: true, status: "ok", message: "", etag };
    },
    deleteObject: async (key): Promise<DeleteResult> => {
      store.delete(key);
      etags.delete(key);
      return { ok: true, status: "ok", message: "" };
    },
    listObjects: async (prefix): Promise<ListResult> => {
      const objects: ObjectMeta[] = [];
      for (const [key, content] of store) {
        if (prefix !== undefined && prefix !== "" && !key.startsWith(prefix)) {
          continue;
        }
        objects.push({ key, size: content.length, lastModified: "" });
      }
      return { ok: true, status: "ok", message: "", objects };
    },
  };
  return { storage, objects: store };
}

// file builds a FileState for path with the given hash, using the hash length as a stand-in size.
// The blob address matches the hash, as it does for every unencrypted vault.
export function file(path: string, hash: string): FileState {
  return { path, size: hash.length, mtime: 1, hash, blob: hash };
}

// snapshot builds a Snapshot from the given file states.
export function snapshot(...files: FileState[]): Snapshot {
  return { files };
}

// unwrapped is the inverse of wrapped, for a test that wants to look inside an object a sync
// wrote. A body that is not a geode object at all throws rather than returning a result to
// inspect: the test asked for the payload of something it expected sync to have written, and
// there is nothing sensible for it to assert on if that isn't what it got.
export function unwrapped(body: string): string {
  const opened = unwrapObject(new TextEncoder().encode(body));
  if (!opened.ok) {
    throw new Error(`not a geode object: ${opened.reason}`);
  }

  return new TextDecoder().decode(opened.payload);
}

// wrapped returns what the bucket actually holds for content: the payload inside its object
// envelope (#184). Tests seed and assert through it so a fixture is the object a real bucket would
// hold rather than a bare payload sync would refuse to read. The envelope header is ASCII safe, so
// it survives fakeStorage keeping bodies as strings.
export function wrapped(content: string): string {
  return new TextDecoder().decode(wrapObject(new TextEncoder().encode(content)));
}

import type {
  DeleteResult,
  GetResult,
  ListResult,
  PutResult,
  StorageClient,
} from "../storage/storage.ts";
import type { FileState, Reader, Snapshot } from "../vault/vault.ts";
import type { LocalWriter } from "./execute.ts";

// empty is the zero snapshot: a vault with no files.
export const empty: Snapshot = { files: [] };

// fakeLocalWriter returns a LocalWriter backed by an in-memory map, and the map itself so tests
// can assert on the result.
export function fakeLocalWriter(): { writer: LocalWriter; files: Map<string, string> } {
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

// fakeReader returns a Reader backed by an in-memory map of path to content.
export function fakeReader(files: Record<string, string>): Reader {
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

// file builds a FileState for path with the given hash, using the hash length as a stand-in size.
export function file(path: string, hash: string): FileState {
  return { path, size: hash.length, mtime: 1, hash };
}

// snapshot builds a Snapshot from the given file states.
export function snapshot(...files: FileState[]): Snapshot {
  return { files };
}

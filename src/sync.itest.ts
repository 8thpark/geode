// Integration tests: drive the real sync orchestration (syncOnce) and the real vault/obsidian.ts file
// I/O against a real S3 compatible server (MinIO, via `docker compose`) plus real temp directories
// on disk. Each "device" is a temp vault wired through the real adapter code over a node:fs backed
// Vault, so these exercise multi device convergence and conflict resolution end to end, not with
// in-memory fakes. Requires Docker; run via `npm run test:integration`, not `npm test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type GeodeSettings } from "./settings/settings.ts";
import { createS3Client } from "./storage/storage.ts";
import {
  conflictCopyPath,
  type LocalWriter,
  MANIFEST_KEY,
  type SyncOutcome,
  syncOnce,
} from "./sync.ts";
import { nodeVault } from "./vault/fs.ts";
import {
  createObsidianLocalWriter,
  createObsidianReader,
  createObsidianStore,
} from "./vault/obsidian.ts";
import { type Reader, type Store, takeSnapshot } from "./vault/vault.ts";

const SECRET = "geodedev";

const liveSettings: GeodeSettings = {
  ...DEFAULT_SETTINGS,
  provider: "custom",
  endpoint: "http://localhost:4568",
  region: "us-east-1",
  bucket: "geode-test",
  accessKeyId: "geodedev",
};

const storage = createS3Client(liveSettings, SECRET);

const STATE_PATH = ".obsidian/plugins/geode/state.json";

type Device = {
  root: string;
  reader: Reader;
  writer: LocalWriter;
  stateStore: Store;
};

// newDevice creates a fresh temp vault with the plugin data folder pre-created (as Obsidian would
// have), wired to the real vault/obsidian.ts code over a node:fs backed vault.
function newDevice(): Device {
  const root = mkdtempSync(join(tmpdir(), "geode-device-"));
  mkdirSync(join(root, ".obsidian", "plugins", "geode"), { recursive: true });
  const { vault, adapter } = nodeVault(root);
  return {
    root,
    reader: createObsidianReader(vault),
    writer: createObsidianLocalWriter(adapter),
    stateStore: createObsidianStore(adapter, STATE_PATH),
  };
}

// writeLocal creates or overwrites a file in a device's vault, the way a user editing in Obsidian
// would, so a following sync sees it as a local change. Edits in these tests always change the
// byte length so a same millisecond, same size rewrite can never hide a change from mtime based
// detection.
async function writeLocal(d: Device, path: string, body: string): Promise<void> {
  await d.writer.writeFile(path, new TextEncoder().encode(body));
}

// readLocal returns a device file's contents, or undefined if it isn't there.
async function readLocal(d: Device, path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await d.reader.readFile(path));
  } catch {
    return undefined;
  }
}

// deleteLocal removes a file from a device's vault, the way a user deleting a note in Obsidian
// would, so a following sync sees it as a local deletion.
async function deleteLocal(d: Device, path: string): Promise<void> {
  await d.writer.deleteFile(path);
}

// sync runs one pass for a device, mirroring the plugin's runSync spine: read previous state, run
// syncOnce, persist the new snapshot on success.
async function sync(d: Device, now = Date.now()): Promise<SyncOutcome> {
  const previous = await d.stateStore.read();
  const outcome = await syncOnce(previous, d.reader, d.writer, storage, now);
  if (outcome.ok) {
    await d.stateStore.write(outcome.snapshot);
  }
  return outcome;
}

// resetRemote clears the manifest and every object under prefix, so each scenario starts from a
// clean shared bucket without disturbing the other itest files' keys.
async function resetRemote(prefix: string): Promise<void> {
  await storage.deleteObject(MANIFEST_KEY);
  const listed = await storage.listObjects(prefix);
  for (const object of listed.objects) {
    await storage.deleteObject(object.key);
  }
}

// cleanup removes each device's temp directory.
function cleanup(...devices: Device[]): void {
  for (const d of devices) {
    rmSync(d.root, { recursive: true, force: true });
  }
}

test("sync: two devices converge on each other's changes", async () => {
  await resetRemote("one/");
  const a = newDevice();
  const b = newDevice();
  try {
    await writeLocal(a, "one/a.md", "from A");
    assert.equal((await sync(a)).ok, true);

    assert.equal((await sync(b)).ok, true);
    assert.equal(await readLocal(b, "one/a.md"), "from A");

    await writeLocal(b, "one/b.md", "from B side");
    assert.equal((await sync(b)).ok, true);
    assert.equal((await sync(a)).ok, true);
    assert.equal(await readLocal(a, "one/b.md"), "from B side");

    assert.equal(await readLocal(a, "one/a.md"), "from A");
    assert.equal(await readLocal(b, "one/a.md"), "from A");
    assert.equal(await readLocal(a, "one/b.md"), "from B side");
    assert.equal(await readLocal(b, "one/b.md"), "from B side");
  } finally {
    cleanup(a, b);
  }
});

test("sync: three devices converge through the shared remote", async () => {
  await resetRemote("two/");
  const a = newDevice();
  const b = newDevice();
  const c = newDevice();
  try {
    await writeLocal(a, "two/a.md", "from A");
    assert.equal((await sync(a)).ok, true);

    assert.equal((await sync(b)).ok, true);
    assert.equal((await sync(c)).ok, true);
    assert.equal(await readLocal(b, "two/a.md"), "from A");
    assert.equal(await readLocal(c, "two/a.md"), "from A");

    await writeLocal(c, "two/c.md", "from C side");
    assert.equal((await sync(c)).ok, true);
    assert.equal((await sync(a)).ok, true);
    assert.equal((await sync(b)).ok, true);

    for (const d of [a, b, c]) {
      assert.equal(await readLocal(d, "two/a.md"), "from A");
      assert.equal(await readLocal(d, "two/c.md"), "from C side");
    }
  } finally {
    cleanup(a, b, c);
  }
});

test("sync: a two device conflict pushes the copy so the other device pulls it clean", async () => {
  await resetRemote("three/");
  const a = newDevice();
  const b = newDevice();
  const now = Date.parse("2026-07-14T10:00:00.000Z");
  try {
    await writeLocal(a, "three/note.md", "original text");
    assert.equal((await sync(a)).ok, true);
    assert.equal((await sync(b)).ok, true);
    assert.equal(await readLocal(b, "three/note.md"), "original text");

    await writeLocal(a, "three/note.md", "A edit");
    await writeLocal(b, "three/note.md", "B side edit");

    assert.equal((await sync(a)).ok, true);

    const bOutcome = await sync(b, now);
    assert.equal(bOutcome.ok, true);
    const copyPath = conflictCopyPath("three/note.md", now);
    assert.equal(await readLocal(b, "three/note.md"), "A edit");
    assert.equal(await readLocal(b, copyPath), "B side edit");

    // Regression guard: the conflict copy reached the bucket, so the manifest B uploaded is not
    // referencing a phantom object.
    const remoteCopy = await storage.getObject(copyPath);
    assert.equal(remoteCopy.ok, true);
    assert.equal(new TextDecoder().decode(remoteCopy.body ?? new Uint8Array()), "B side edit");

    // A syncs again and must complete cleanly, pulling the conflict copy rather than erroring on a
    // 404 for an object that never existed. This is exactly what broke before the fix.
    assert.equal((await sync(a)).ok, true);
    assert.equal(await readLocal(a, copyPath), "B side edit");

    // Neither edit was lost anywhere.
    assert.equal(await readLocal(a, "three/note.md"), "A edit");
    assert.equal(await readLocal(b, "three/note.md"), "A edit");
    assert.equal(await readLocal(a, copyPath), "B side edit");
    assert.equal(await readLocal(b, copyPath), "B side edit");
  } finally {
    cleanup(a, b);
  }
});

test("sync: a file deleted independently on both devices converges without a conflict", async () => {
  await resetRemote("four/");
  const a = newDevice();
  const b = newDevice();
  try {
    await writeLocal(a, "four/note.md", "shared text");
    assert.equal((await sync(a)).ok, true);
    assert.equal((await sync(b)).ok, true);
    assert.equal(await readLocal(b, "four/note.md"), "shared text");

    // Both devices delete the same file before either has synced the deletion to the other, the
    // ordinary case of deleting a note on two machines without syncing in between.
    await deleteLocal(a, "four/note.md");
    await deleteLocal(b, "four/note.md");

    assert.equal((await sync(a)).ok, true);

    // B's sync sees the file deleted on both sides since the last sync. Before the fix, planSync
    // misclassified this as a conflict, and executeSyncPlan then tried to read the local bytes of
    // a file that no longer existed, throwing uncaught and leaving the sync stuck mid-flight.
    const bOutcome = await sync(b);
    assert.equal(bOutcome.ok, true);

    assert.equal(await readLocal(a, "four/note.md"), undefined);
    assert.equal(await readLocal(b, "four/note.md"), undefined);

    // No conflict copy was invented for a deletion both sides already agreed on.
    const listed = await storage.listObjects("four/");
    assert.deepEqual(listed.objects, []);
  } finally {
    cleanup(a, b);
  }
});

test("sync: a file deleted on one device and edited on another restores the edit, no phantom read of the deleted file", async () => {
  await resetRemote("five/");
  const a = newDevice();
  const b = newDevice();
  try {
    await writeLocal(a, "five/note.md", "original text");
    assert.equal((await sync(a)).ok, true);
    assert.equal((await sync(b)).ok, true);

    // A deletes its copy; B, unaware of that, edits its own copy before either syncs again.
    await deleteLocal(a, "five/note.md");
    await writeLocal(b, "five/note.md", "B kept editing");
    assert.equal((await sync(b)).ok, true);

    // A's sync sees local deleted, remote modified since the last sync. Before the fix this was
    // classified as a conflict and executeSyncPlan unconditionally tried to read the local bytes
    // of a.md to preserve as a copy — but A has nothing there, so it threw uncaught and A was
    // stuck retrying the same throw forever.
    const aOutcome = await sync(a);
    assert.equal(aOutcome.ok, true);

    // There is nothing to preserve on A's side, so B's edit simply wins and reappears locally.
    assert.equal(await readLocal(a, "five/note.md"), "B kept editing");
    assert.equal(await readLocal(b, "five/note.md"), "B kept editing");
  } finally {
    cleanup(a, b);
  }
});

test("sync: a stale state.json from an older build never deletes the vault on the first sync", async () => {
  await resetRemote("seven/");
  const a = newDevice();
  try {
    // Reproduce an upgrader's poisoned ancestor. The older build wrote state.json on every file
    // event, not only on completed syncs, so a developer who ran it against their own vault has a
    // state.json describing every file despite nothing ever reaching the (still empty) bucket:
    // files on disk, a state.json claiming them, and a remote that has never been written.
    await writeLocal(a, "seven/one.md", "first note");
    await writeLocal(a, "seven/two.md", "second note");
    await a.stateStore.write(await takeSnapshot(a.reader, { files: [] }));

    // Before the fix, syncOnce diffed that ancestor against the empty remote, read every file as
    // remotely deleted, and pullDeleted the whole vault. It must instead treat a first sync (no
    // remote manifest) as having no ancestor and push everything.
    const outcome = await sync(a);
    assert.equal(outcome.ok, true);

    assert.equal(await readLocal(a, "seven/one.md"), "first note");
    assert.equal(await readLocal(a, "seven/two.md"), "second note");

    // Both files reached the bucket rather than being wiped from it.
    const one = await storage.getObject("seven/one.md");
    const two = await storage.getObject("seven/two.md");
    assert.equal(new TextDecoder().decode(one.body ?? new Uint8Array()), "first note");
    assert.equal(new TextDecoder().decode(two.body ?? new Uint8Array()), "second note");

    // A second device now syncs clean and converges, proving the manifest the first sync uploaded
    // is real and the ancestor reset was a one time first sync affordance, not a lasting behaviour.
    const b = newDevice();
    try {
      assert.equal((await sync(b)).ok, true);
      assert.equal(await readLocal(b, "seven/one.md"), "first note");
      assert.equal(await readLocal(b, "seven/two.md"), "second note");
    } finally {
      cleanup(b);
    }
  } finally {
    cleanup(a);
  }
});

test("sync: an edit on one device and a delete on another preserves the edit as a copy, no phantom pull failure", async () => {
  await resetRemote("six/");
  const a = newDevice();
  const b = newDevice();
  try {
    await writeLocal(a, "six/note.md", "original text");
    assert.equal((await sync(a)).ok, true);
    assert.equal((await sync(b)).ok, true);

    // A edits its copy; B, unaware of that, deletes its own copy before either syncs again.
    await writeLocal(a, "six/note.md", "A kept editing");
    await deleteLocal(b, "six/note.md");
    assert.equal((await sync(b)).ok, true);

    // A's sync sees local modified, remote deleted since the last sync. Before the fix this
    // succeeded at preserving A's edit as a copy, then treated the expected empty read at the
    // original path as a sync failure, blocking state.json from ever advancing and repeating on
    // every subsequent sync.
    const now = Date.parse("2026-07-14T10:00:00.000Z");
    const aOutcome = await sync(a, now);
    assert.equal(aOutcome.ok, true);

    const copyPath = conflictCopyPath("six/note.md", now);
    assert.equal(await readLocal(a, "six/note.md"), undefined);
    assert.equal(await readLocal(a, copyPath), "A kept editing");

    assert.equal((await sync(b)).ok, true);
    assert.equal(await readLocal(b, copyPath), "A kept editing");
  } finally {
    cleanup(a, b);
  }
});

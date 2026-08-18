// Integration tests: real syncOnce and real adapter file I/O against MinIO and temp directories,
// so multi device convergence is exercised end to end rather than against fakes. Needs Docker.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type GeodeSettings } from "../settings/settings.ts";
import { unwrapObject } from "../storage/envelope.ts";
import { createS3Client, fetchTransport, type StorageClient } from "../storage/storage.ts";
import { nodeVault } from "../vault/fs.ts";
import {
  createObsidianLocalWriter,
  createObsidianReader,
  createObsidianStore,
} from "../vault/obsidian.ts";
import {
  decodeSnapshot,
  hashBytes,
  type Reader,
  type Store,
  takeSnapshot,
} from "../vault/vault.ts";
import type { LocalWriter } from "./execute.ts";
import { blobKeyFor, conflictCopyPath, MANIFEST_KEY } from "./plan.ts";
import { type SyncOutcome, syncOnce } from "./sync.ts";

const SECRET = "geodedev";

const liveSettings: GeodeSettings = {
  ...DEFAULT_SETTINGS,
  provider: "minio",
  endpoint: "http://localhost:4568",
  // This file owns the bucket outright, since a first sync refuses over blobs it cannot explain
  // and a shared bucket's leftovers would eventually trip that.
  bucket: "geode-sync-test",
  accessKeyId: "geodedev",
};

const storage = createS3Client(liveSettings, SECRET, fetchTransport);

const STATE_PATH = ".obsidian/plugins/geode/state.json";

type Device = {
  root: string;
  reader: Reader;
  writer: LocalWriter;
  stateStore: Store;
};

// newDevice creates a fresh temp vault wired to the real adapter code. settings differs only for
// the prefix scenario, which needs a state store fingerprinted against the target it writes to.
function newDevice(settings: GeodeSettings = liveSettings): Device {
  const root = mkdtempSync(join(tmpdir(), "geode-device-"));
  mkdirSync(join(root, ".obsidian", "plugins", "geode"), { recursive: true });
  const { vault, adapter } = nodeVault(root);
  return {
    root,
    reader: createObsidianReader(vault),
    writer: createObsidianLocalWriter(adapter),
    stateStore: createObsidianStore(adapter, STATE_PATH, settings),
  };
}

// writeLocal edits a file the way someone in Obsidian would. Every edit here changes the byte
// length, so a same millisecond rewrite can never hide a change from stat based detection.
async function writeLocal(d: Device, path: string, body: string): Promise<void> {
  const staged = await d.writer.stageFile(path, new TextEncoder().encode(body), "replace");
  await staged.commit();
}

// readLocal returns a device file's contents, or undefined if it isn't there.
async function readLocal(d: Device, path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await d.reader.readFile(path));
  } catch {
    return undefined;
  }
}

// contentOf returns the payload inside an object's envelope, so an assertion compares content
// rather than framing. A body that is not a geode object throws, since it can only be a test bug.
function contentOf(body: Uint8Array | null): string {
  if (body === null) {
    throw new Error("not a geode object: no body");
  }
  const opened = unwrapObject(body);
  if (!opened.ok) {
    throw new Error(`not a geode object: ${opened.reason}`);
  }

  return new TextDecoder().decode(opened.payload);
}

// hashOf returns the real content hash of text, for reading back the blob a given piece of
// content lives under.
async function hashOf(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text));
}

// deleteLocal removes a file from a device's vault, the way a user deleting a note in Obsidian
// would, so a following sync sees it as a local deletion.
async function deleteLocal(d: Device, path: string): Promise<void> {
  await d.writer.deleteFile(path);
}

// sync runs one pass for a device, mirroring the plugin's spine: read state, run syncOnce,
// persist whatever snapshot comes back.
async function sync(d: Device, now = Date.now(), client = storage): Promise<SyncOutcome> {
  const previous = await d.stateStore.read();
  const outcome = await syncOnce(previous, d.reader, d.writer, client, now);
  if (outcome.ok) {
    await d.stateStore.write(outcome.snapshot);
    return outcome;
  }
  if (outcome.snapshot !== null) {
    await d.stateStore.write(outcome.snapshot);
  }

  return outcome;
}

// resetRemote empties the bucket between scenarios, failing loudly on a bad listing rather than
// letting a stale bucket resurface later as a baffling orphan refusal.
async function resetRemote(): Promise<void> {
  await storage.deleteObject(MANIFEST_KEY);
  const listed = await storage.listObjects();
  assert.ok(listed.ok, `resetRemote: listing failed: ${listed.message}`);
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
  await resetRemote();
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
  await resetRemote();
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
  await resetRemote();
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

    // Regression guard: the conflict copy's blob reached the bucket, so the manifest B uploaded is
    // not referencing content that doesn't exist.
    const remoteCopy = await storage.getObject(blobKeyFor(await hashOf("B side edit")));
    assert.equal(remoteCopy.ok, true);
    assert.equal(contentOf(remoteCopy.body), "B side edit");

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
  await resetRemote();
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
    // a file that no longer existed, throwing uncaught and leaving the sync stuck mid flight.
    const bOutcome = await sync(b);
    assert.equal(bOutcome.ok, true);

    assert.equal(await readLocal(a, "four/note.md"), undefined);
    assert.equal(await readLocal(b, "four/note.md"), undefined);

    // No conflict copy was invented for a deletion both sides already agreed on: the converged
    // manifest describes no files at all.
    const manifestBody = await storage.getObject(MANIFEST_KEY);
    assert.equal(manifestBody.ok, true);
    const decoded = decodeSnapshot(contentOf(manifestBody.body));
    assert.ok(decoded.ok);
    assert.deepEqual(decoded.snapshot.files, []);
  } finally {
    cleanup(a, b);
  }
});

test("sync: a file deleted on one device and edited on another restores the edit, no phantom read of the deleted file", async () => {
  await resetRemote();
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

    // Local deleted, remote modified. A conflict here has no local bytes to preserve, so the
    // deleted side must be carried explicitly rather than discovered by a failed read.
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
  await resetRemote();
  const a = newDevice();
  try {
    // An upgrader's poisoned ancestor: a state.json describing the whole vault while the bucket
    // has never been written. A first sync must drop that ancestor rather than diff against it.
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

    // Both files' blobs reached the bucket rather than being wiped from it.
    const one = await storage.getObject(blobKeyFor(await hashOf("first note")));
    const two = await storage.getObject(blobKeyFor(await hashOf("second note")));
    assert.equal(contentOf(one.body), "first note");
    assert.equal(contentOf(two.body), "second note");

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

test("sync: two devices syncing at overlapping times never silently delete a file", async () => {
  // B's whole pass lands while A sits between reading the manifest and uploading its own, the
  // interleaving overlapping automatic syncs produce. A's upload must lose the compare and swap.
  await resetRemote();
  const a = newDevice();
  const b = newDevice();
  try {
    await writeLocal(a, "eight/base.md", "shared base");
    assert.equal((await sync(a)).ok, true);
    assert.equal((await sync(b)).ok, true);

    await writeLocal(a, "eight/from-a.md", "a's new note");
    await writeLocal(b, "eight/from-b.md", "b's new note here");

    let interleaved = false;
    const racingStorage: StorageClient = {
      ...storage,
      putObject: async (key, body, condition) => {
        if (key === MANIFEST_KEY && !interleaved) {
          interleaved = true;
          assert.equal((await sync(b)).ok, true);
        }

        return storage.putObject(key, body, condition);
      },
    };
    const previous = await a.stateStore.read();
    const outcome = await syncOnce(previous, a.reader, a.writer, racingStorage, Date.now());

    // A lost the race: the pass fails loudly and state.json does not advance.
    assert.equal(outcome.ok, false);

    // A's next ordinary sync reconciles both devices' work; nothing was lost anywhere.
    assert.equal((await sync(a)).ok, true);
    assert.equal((await sync(b)).ok, true);
    assert.equal(await readLocal(a, "eight/from-b.md"), "b's new note here");
    assert.equal(await readLocal(b, "eight/from-a.md"), "a's new note");
    assert.equal(await readLocal(a, "eight/base.md"), "shared base");
    assert.equal(await readLocal(b, "eight/base.md"), "shared base");
  } finally {
    cleanup(a, b);
  }
});

test("sync: a deleted manifest with unexplained blobs reports and proceeds, rather than deadlocking B forever", async () => {
  // The manifest is deleted while a blob survives, and B cannot explain that blob. Refusing would
  // never write a manifest, so every retry hits the same refusal; the pass must proceed and report
  // the stranded content instead.
  await resetRemote();
  const a = newDevice();
  const b = newDevice();
  try {
    await writeLocal(a, "nine/from-a.md", "a's note");
    assert.equal((await sync(a)).ok, true);

    await storage.deleteObject(MANIFEST_KEY);
    await writeLocal(b, "nine/from-b.md", "b's note");

    const outcome = await sync(b);
    assert.ok(!outcome.ok);
    const survivorKey = blobKeyFor(await hashOf("a's note"));
    assert.deepEqual(outcome.failures, [
      { path: survivorKey, message: "in the bucket but not in the local vault" },
    ]);

    // B's own file still pushed and a manifest still landed; A's blob is untouched, unreferenced
    // but not destroyed.
    const kept = await storage.getObject(survivorKey);
    assert.equal(contentOf(kept.body), "a's note");
    assert.equal((await storage.getObject(blobKeyFor(await hashOf("b's note")))).ok, true);
    assert.equal((await storage.getObject(MANIFEST_KEY)).ok, true);

    // B is not stuck: the next sync is ordinary, not a repeat of the same refusal.
    assert.equal((await sync(b)).ok, true);
  } finally {
    cleanup(a, b);
  }
});

test("sync: a deleted manifest over locally diverged content reports and proceeds, rather than guessing a conflict", async () => {
  // The manifest is deleted and B edits the note before its next sync. Nothing now records which
  // path the surviving blob belonged to, so the pass pushes B's edit and reports the original as
  // stranded rather than constructing a conflict it has no path information for.
  await resetRemote();
  const a = newDevice();
  const b = newDevice();
  try {
    await writeLocal(a, "ten/note.md", "from A");
    assert.equal((await sync(a)).ok, true);
    assert.equal((await sync(b)).ok, true);

    await storage.deleteObject(MANIFEST_KEY);
    await writeLocal(b, "ten/note.md", "B's own edit");

    const outcome = await sync(b);
    assert.ok(!outcome.ok);
    const survivorKey = blobKeyFor(await hashOf("from A"));
    assert.deepEqual(outcome.failures, [
      { path: survivorKey, message: "in the bucket but not in the local vault" },
    ]);

    // A's original content is untouched, unreferenced but not destroyed; B's edit still pushed
    // under its own path.
    const kept = await storage.getObject(survivorKey);
    assert.equal(contentOf(kept.body), "from A");
    assert.equal(await readLocal(b, "ten/note.md"), "B's own edit");
    assert.equal((await storage.getObject(MANIFEST_KEY)).ok, true);

    // B is not stuck: the next sync is ordinary, not a repeat of the same refusal.
    assert.equal((await sync(b)).ok, true);
  } finally {
    cleanup(a, b);
  }
});

test("sync: an edit on one device and a delete on another preserves the edit as a copy, no phantom pull failure", async () => {
  await resetRemote();
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

    // Local modified, remote deleted. The rename is the whole local change, so the path being
    // left empty afterwards is the correct final state rather than a failure to report.
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

test("sync: two devices converge inside a bucket prefix", async () => {
  // The whole spine against a client rooted inside the bucket, which is what proves nothing above
  // the storage client knows a prefix exists.
  await resetRemote();
  const prefixed: GeodeSettings = { ...liveSettings, prefix: "vaults/personal" };
  const prefixedStorage = createS3Client(prefixed, SECRET, fetchTransport);
  const a = newDevice(prefixed);
  const b = newDevice(prefixed);
  const now = Date.now();

  try {
    await writeLocal(a, "prefixed/a.md", "from A");
    assert.equal((await sync(a, now, prefixedStorage)).ok, true);

    assert.equal((await sync(b, now, prefixedStorage)).ok, true);
    assert.equal(await readLocal(b, "prefixed/a.md"), "from A");

    await writeLocal(b, "prefixed/b.md", "from B side");
    assert.equal((await sync(b, now, prefixedStorage)).ok, true);
    assert.equal((await sync(a, now, prefixedStorage)).ok, true);
    assert.equal(await readLocal(a, "prefixed/b.md"), "from B side");

    // Read through the unprefixed client to see where the bytes really are.
    assert.equal((await storage.getObject(`vaults/personal/${MANIFEST_KEY}`)).ok, true);
    assert.equal((await storage.getObject(MANIFEST_KEY)).status, "not_found");
    const hash = await hashOf("from A");
    assert.equal((await storage.getObject(`vaults/personal/${blobKeyFor(hash)}`)).ok, true);
  } finally {
    cleanup(a, b);
  }
});

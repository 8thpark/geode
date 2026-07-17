// Integration tests: drive the real sync orchestration (syncOnce) and the real vault-adapter file
// I/O against a real S3 compatible server (MinIO, via `docker compose`) plus real temp directories
// on disk. Each "device" is a temp vault wired through the real adapter code over a node:fs backed
// Vault, so these exercise multi device convergence and conflict resolution end to end, not with
// in-memory fakes. Requires Docker; run via `npm run test:integration`, not `npm test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nodeVault } from "./fs-vault.ts";
import { DEFAULT_SETTINGS, type GeodeSettings } from "./settings.ts";
import { createS3Client } from "./storage.ts";
import {
  conflictCopyPath,
  type LocalWriter,
  MANIFEST_KEY,
  type SyncOutcome,
  syncOnce,
} from "./sync.ts";
import {
  createObsidianLocalWriter,
  createObsidianStateStore,
  createObsidianVaultReader,
} from "./vault-adapter.ts";
import type { StateStore, VaultReader } from "./vault-state.ts";

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
  reader: VaultReader;
  writer: LocalWriter;
  stateStore: StateStore;
};

// newDevice creates a fresh temp vault with the plugin data folder pre-created (as Obsidian would
// have), wired to the real vault-adapter code over a node:fs backed vault.
function newDevice(): Device {
  const root = mkdtempSync(join(tmpdir(), "geode-device-"));
  mkdirSync(join(root, ".obsidian", "plugins", "geode"), { recursive: true });
  const { vault, adapter } = nodeVault(root);
  return {
    root,
    reader: createObsidianVaultReader(vault),
    writer: createObsidianLocalWriter(adapter),
    stateStore: createObsidianStateStore(adapter, STATE_PATH),
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

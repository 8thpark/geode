import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStorage, wrapped } from "../sync/fake.ts";
import { encodeSentinel, MANIFEST_KEY, SENTINEL_KEY } from "../sync/plan.ts";
import { encodeSnapshot, type Snapshot } from "../vault/vault.ts";
import {
  type Counts,
  copyFor,
  countsFor,
  doneLead,
  type Preview,
  previewFor,
  type RemoteRead,
  readRemote,
} from "./onboarding.ts";

// VAULT_ID is the identity a seeded bucket claims; nothing depends on the value beyond two tests
// needing to disagree about it.
const VAULT_ID = "vault-a";

// file returns a manifest entry at path, with the fields a preview never looks at left at their
// zero values.
function file(path: string) {
  return { path, hash: "h", size: 1, mtime: 2, blob: "h" };
}

// seeded returns a storage client holding a manifest and sentinel for paths, the shape a bucket
// has once one device has synced to it.
function seeded(paths: string[]): ReturnType<typeof fakeStorage> {
  const snapshot: Snapshot = { files: paths.map(file) };

  return fakeStorage({
    [MANIFEST_KEY]: wrapped(encodeSnapshot(snapshot)),
    [SENTINEL_KEY]: wrapped(encodeSentinel({ vaultId: VAULT_ID, createdAt: 0 })),
  });
}

test("countsFor: splits two path lists by which side holds them", () => {
  const cases: { name: string; local: string[]; remote: string[]; want: Counts }[] = [
    {
      name: "two empty sides count nothing",
      local: [],
      remote: [],
      want: { download: 0, shared: 0, upload: 0 },
    },
    {
      name: "a path only on disk is an upload",
      local: ["a.md", "b.md"],
      remote: [],
      want: { download: 0, shared: 0, upload: 2 },
    },
    {
      name: "a path only in the bucket is a download",
      local: [],
      remote: ["a.md", "b.md"],
      want: { download: 2, shared: 0, upload: 0 },
    },
    {
      name: "a path on both sides counts once, as shared",
      local: ["a.md", "b.md"],
      remote: ["b.md", "c.md"],
      want: { download: 1, shared: 1, upload: 1 },
    },
    {
      name: "case matters, since two casings are two keys in the bucket",
      local: ["A.md"],
      remote: ["a.md"],
      want: { download: 1, shared: 0, upload: 1 },
    },
  ];

  for (const c of cases) {
    assert.deepEqual(countsFor(c.local, c.remote), c.want, c.name);
  }
});

test("previewFor: each read of the bucket decides what the dialog offers", () => {
  const cases: { name: string; local: string[]; remote: RemoteRead; want: Preview }[] = [
    {
      name: "a fresh bucket is a push of everything local",
      local: ["a.md", "b.md"],
      remote: { kind: "fresh" },
      want: { kind: "push", upload: 2 },
    },
    {
      name: "a fresh bucket and an empty vault is still a push, claiming the bucket",
      local: [],
      remote: { kind: "fresh" },
      want: { kind: "push", upload: 0 },
    },
    {
      name: "an empty vault against a synced bucket is a clean pull",
      local: [],
      remote: { kind: "vault", paths: ["a.md"] },
      want: { kind: "pull", download: 1 },
    },
    {
      name: "files on both sides is the merge, the one case worth a warning",
      local: ["a.md", "b.md"],
      remote: { kind: "vault", paths: ["b.md", "c.md"] },
      want: { kind: "merge", counts: { download: 1, shared: 1, upload: 1 } },
    },
    {
      name: "a permanent refusal is carried through as something to go and fix",
      local: ["a.md"],
      remote: { kind: "blocked", message: "belongs to a different vault" },
      want: { kind: "blocked", message: "belongs to a different vault" },
    },
    {
      name: "a transient failure is carried through as something to try again",
      local: ["a.md"],
      remote: { kind: "unreachable", message: "network error" },
      want: { kind: "unreachable", message: "network error" },
    },
  ];

  for (const c of cases) {
    assert.deepEqual(previewFor(c.local, c.remote), c.want, c.name);
  }
});

test("copyFor: says what will happen, and cautions only where there is something to lose", () => {
  const push = copyFor({ kind: "push", upload: 1 });
  assert.match(push.lead, /^This bucket is empty\. 1 file will be uploaded/);
  assert.deepEqual(push.caution, []);

  const empty = copyFor({ kind: "push", upload: 0 });
  assert.match(empty.lead, /and so is this vault/);
  assert.deepEqual(empty.caution, []);

  const pull = copyFor({ kind: "pull", download: 3 });
  assert.match(pull.lead, /3 files will be downloaded/);
  assert.match(pull.lead, /nothing here is overwritten/);
  assert.deepEqual(pull.caution, []);

  const merge = copyFor({ kind: "merge", counts: { download: 1, shared: 2, upload: 1 } });
  assert.match(merge.lead, /Nothing is deleted/);
  assert.deepEqual(merge.caution, [
    "Back up this vault first if the 2 files on both sides matter.",
  ]);

  const clean = copyFor({ kind: "merge", counts: { download: 1, shared: 0, upload: 1 } });
  assert.deepEqual(clean.caution, [], "nothing overlaps, so there is nothing to back up for");

  const blocked = copyFor({ kind: "blocked", message: "it belongs to another vault" });
  assert.equal(blocked.lead, "Geode won't sync here: it belongs to another vault.");
  assert.equal(blocked.caution.length, 1);

  const unreachable = copyFor({ kind: "unreachable", message: "network error" });
  assert.equal(unreachable.lead, "Could not read the bucket: network error.");
  assert.deepEqual(unreachable.caution, []);
});

test("doneLead: reports what the pass moved, without making a count read as a plural", () => {
  assert.match(doneLead(0), /Nothing needed moving/);
  assert.equal(doneLead(1), "Synced. 1 change applied.");
  assert.equal(doneLead(2), "Synced. 2 changes applied.");
});

test("readRemote: a bucket with no manifest is fresh", async () => {
  const { storage } = fakeStorage();

  assert.deepEqual(await readRemote(storage, undefined), { kind: "fresh" });
});

test("readRemote: a synced bucket reports the paths its manifest names", async () => {
  const { storage } = seeded(["a.md", "notes/b.md"]);

  assert.deepEqual(await readRemote(storage, undefined), {
    kind: "vault",
    paths: ["a.md", "notes/b.md"],
  });
});

test("readRemote: a bucket owned by another vault is blocked before anything is offered", async () => {
  const { storage } = seeded(["a.md"]);

  const read = await readRemote(storage, "vault-b");
  assert.equal(read.kind, "blocked");
});

test("readRemote: content this build cannot read is blocked, not something to retry", async () => {
  const { storage } = fakeStorage({ [MANIFEST_KEY]: "not a geode object" });

  const read = await readRemote(storage, undefined);
  assert.equal(read.kind, "blocked");
});

test("readRemote: a failed read is unreachable, so the dialog offers another go", async () => {
  const { storage } = fakeStorage();
  const failing = {
    ...storage,
    getObject: async () => ({
      ok: false as const,
      status: "network" as const,
      message: "network error",
      body: null,
      etag: null,
    }),
  };

  assert.deepEqual(await readRemote(failing, undefined), {
    kind: "unreachable",
    message: "network error",
  });
});

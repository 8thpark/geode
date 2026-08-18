// Integration tests against a real S3 compatible server (MinIO), for confidence that requests are
// actually well formed. Needs Docker; run via `npm run test:integration`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type GeodeSettings } from "../settings/settings.ts";
import { createS3Client, fetchTransport, testConnection } from "./storage.ts";

const SECRET_ACCESS_KEY = "geodedev";

const liveSettings: GeodeSettings = {
  ...DEFAULT_SETTINGS,
  provider: "minio",
  endpoint: "http://localhost:4568",
  bucket: "geode-test",
  accessKeyId: "geodedev",
};

test("testConnection: succeeds against a real bucket", async () => {
  const result = await testConnection(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
});

test("putObject then getObject round trips the same bytes", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const body = new TextEncoder().encode("hello geode");

  const putResult = await client.putObject("notes/hello.md", body);
  assert.equal(putResult.ok, true);
  assert.equal(putResult.status, "ok");

  const getResult = await client.getObject("notes/hello.md");
  assert.equal(getResult.ok, true);
  assert.equal(getResult.status, "ok");
  assert.deepEqual(getResult.body, body);
});

test("getObject returns the object's etag for a later conditional put", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  await client.putObject("etag-test/note.md", new TextEncoder().encode("v1"));

  const getResult = await client.getObject("etag-test/note.md");
  assert.equal(getResult.ok, true);
  assert.notEqual(getResult.etag, null);
});

test("putObject ifAbsent creates a missing key but is rejected once the key exists", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const key = `conditional-test/absent-${Date.now()}.md`;

  const first = await client.putObject(key, new TextEncoder().encode("v1"), { kind: "ifAbsent" });
  assert.equal(first.ok, true);

  const second = await client.putObject(key, new TextEncoder().encode("v2"), { kind: "ifAbsent" });
  assert.equal(second.ok, false);
  assert.equal(second.status, "conflict");

  await client.deleteObject(key);
});

test("putObject ifMatch succeeds with the current etag and is rejected once it goes stale", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const key = "conditional-test/match.md";
  try {
    await client.putObject(key, new TextEncoder().encode("v1"));

    const getResult = await client.getObject(key);
    assert.equal(getResult.ok, true);
    assert.ok(getResult.etag !== null);
    const etag = getResult.etag;

    const fresh = await client.putObject(key, new TextEncoder().encode("v2 longer"), {
      kind: "ifMatch",
      etag,
    });
    assert.equal(fresh.ok, true);

    // The etag read before the v2 write is now stale, exactly a concurrent writer's position.
    const stale = await client.putObject(key, new TextEncoder().encode("v3"), {
      kind: "ifMatch",
      etag,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.status, "conflict");
  } finally {
    // The key is fixed, so a mid test assertion failure must not leave a leftover object that
    // changes the next run's behaviour.
    await client.deleteObject(key);
  }
});

test("getObject on a missing key fails without a body", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const result = await client.getObject("does/not/exist.md");
  assert.equal(result.ok, false);
  assert.equal(result.status, "not_found");
  assert.equal(result.body, null);
});

test("deleteObject removes an object", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  await client.putObject("notes/to-delete.md", new TextEncoder().encode("bye"));

  const deleteResult = await client.deleteObject("notes/to-delete.md");
  assert.equal(deleteResult.ok, true);
  assert.equal(deleteResult.status, "ok");

  const getResult = await client.getObject("notes/to-delete.md");
  assert.equal(getResult.ok, false);
  assert.equal(getResult.status, "not_found");
});

test("headObject reports ok for an existing key without returning a body", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const key = "head-test/exists.md";
  await client.putObject(key, new TextEncoder().encode("present"));

  const headResult = await client.headObject(key);
  assert.equal(headResult.ok, true);
  assert.equal(headResult.status, "ok");
  assert.notEqual(headResult.etag, null);

  await client.deleteObject(key);
});

test("headObject on a missing key fails with not_found", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);

  const headResult = await client.headObject("head-test/does-not-exist.md");
  assert.equal(headResult.ok, false);
  assert.equal(headResult.status, "not_found");
});

test("headObject round-trips a key with SigV4-sensitive characters", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const key = "head-test/Don't stop! (really).md";
  await client.putObject(key, new TextEncoder().encode("tricky key"));

  const headResult = await client.headObject(key);
  assert.equal(headResult.ok, true);

  await client.deleteObject(key);
});

test("listObjects returns only keys under the given prefix", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  await client.putObject("list-test/a.md", new TextEncoder().encode("a"));
  await client.putObject("list-test/b.md", new TextEncoder().encode("b"));
  await client.putObject("list-test-other/c.md", new TextEncoder().encode("c"));

  const result = await client.listObjects("list-test/");
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  const keys: string[] = [];
  for (const object of result.objects) {
    keys.push(object.key);
  }
  keys.sort();
  assert.deepEqual(keys, ["list-test/a.md", "list-test/b.md"]);
});

test("listObjects with no prefix returns everything", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  await client.putObject("unprefixed.md", new TextEncoder().encode("x"));

  const result = await client.listObjects();
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  let found = false;
  for (const object of result.objects) {
    if (object.key === "unprefixed.md") {
      found = true;
      break;
    }
  }
  assert.ok(found);
});

test("listObjects pages past the 1,000 key response cap", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const prefix = "paging-test/";
  const total = 1001;

  // One PUT per key would serialise 1,001 round trips; bound the fan-out instead so the setup
  // stays quick without hammering MinIO with unlimited concurrent sockets.
  const body = new TextEncoder().encode("p");
  const limit = 32;
  for (let start = 0; start < total; start += limit) {
    const batch: Promise<unknown>[] = [];
    for (let i = start; i < Math.min(start + limit, total); i++) {
      batch.push(client.putObject(`${prefix}${String(i).padStart(4, "0")}.md`, body));
    }
    await Promise.all(batch);
  }

  const result = await client.listObjects(prefix);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.objects.length, total);

  // Leave the bucket as we found it. Same bounded fan-out as the setup so cleanup does not open
  // 1,001 concurrent sockets.
  for (let start = 0; start < total; start += limit) {
    const batch: Promise<unknown>[] = [];
    for (let i = start; i < Math.min(start + limit, total); i++) {
      batch.push(client.deleteObject(`${prefix}${String(i).padStart(4, "0")}.md`));
    }
    await Promise.all(batch);
  }
});

test("putObject/getObject round-trips a key containing a space and ampersand", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const body = new TextEncoder().encode("special chars");

  const putResult = await client.putObject("encode-test/Foo & Bar.md", body);
  assert.equal(putResult.ok, true);

  const getResult = await client.getObject("encode-test/Foo & Bar.md");
  assert.equal(getResult.ok, true);
  assert.deepEqual(getResult.body, body);
});

test("putObject/getObject round-trips a key with SigV4-sensitive characters ! ' ( ) *", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const body = new TextEncoder().encode("sigv4 edge");
  const key = "encode-test/Don't forget! (draft) *.md";

  const putResult = await client.putObject(key, body);
  assert.equal(putResult.ok, true);

  const getResult = await client.getObject(key);
  assert.equal(getResult.ok, true);
  assert.deepEqual(getResult.body, body);

  // The listing must hand back the exact key the vault knows, or sync would treat the object as
  // a phantom remote file and the real note as locally new.
  const listResult = await client.listObjects("encode-test/Don't");
  assert.equal(listResult.ok, true);
  const keys: string[] = [];
  for (const object of listResult.objects) {
    keys.push(object.key);
  }
  assert.deepEqual(keys, [key]);

  const deleteResult = await client.deleteObject(key);
  assert.equal(deleteResult.ok, true);
});

test("putObject/getObject round-trips a key containing a hash and percent", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const body = new TextEncoder().encode("edge cases");

  const putResult = await client.putObject("encode-test/100% #special.md", body);
  assert.equal(putResult.ok, true);

  const getResult = await client.getObject("encode-test/100% #special.md");
  assert.equal(getResult.ok, true);
  assert.deepEqual(getResult.body, body);
});

// prefixedSettings point a client at a folder inside the same shared bucket, written the untidy way
// a user would type it so the round trip proves canonicalization happens at the point of use.
const prefixedSettings: GeodeSettings = {
  ...liveSettings,
  prefix: "/vaults/personal/",
};

test("a prefixed client round-trips against a real server and hides the prefix", async () => {
  const client = createS3Client(prefixedSettings, SECRET_ACCESS_KEY, fetchTransport);
  const root = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const key = "prefix-test/note.md";
  const body = new TextEncoder().encode("inside a folder");

  try {
    assert.equal((await client.putObject(key, body)).ok, true);
    assert.deepEqual((await client.getObject(key)).body, body);
    assert.equal((await client.headObject(key)).ok, true);

    // What the bucket really holds: the object sits under the prefix and nothing lands beside it
    // at the root, so two vaults can share one bucket without ever seeing each other.
    assert.equal((await root.getObject(`vaults/personal/${key}`)).ok, true);
    assert.equal((await root.getObject(key)).status, "not_found");
  } finally {
    await client.deleteObject(key);
  }
});

test("a prefixed client lists keys relative to its own root", async () => {
  const client = createS3Client(prefixedSettings, SECRET_ACCESS_KEY, fetchTransport);
  const body = new TextEncoder().encode("x");

  try {
    await client.putObject("prefix-list/a.md", body);
    await client.putObject("prefix-list/b.md", body);

    const result = await client.listObjects("prefix-list/");
    assert.equal(result.ok, true);
    const keys: string[] = [];
    for (const object of result.objects) {
      keys.push(object.key);
    }
    keys.sort();
    assert.deepEqual(keys, ["prefix-list/a.md", "prefix-list/b.md"]);
  } finally {
    await client.deleteObject("prefix-list/a.md");
    await client.deleteObject("prefix-list/b.md");
  }
});

test("a prefixed client cannot see an object sitting at the bucket root", async () => {
  // The isolation sync depends on when two vaults share a bucket: a listing that leaked a
  // neighbour's key would be read as content this vault cannot explain and fail its first sync.
  const client = createS3Client(prefixedSettings, SECRET_ACCESS_KEY, fetchTransport);
  const root = createS3Client(liveSettings, SECRET_ACCESS_KEY, fetchTransport);
  const key = "prefix-isolation/neighbour.md";

  try {
    await root.putObject(key, new TextEncoder().encode("not mine"));

    assert.equal((await client.getObject(key)).status, "not_found");
    const result = await client.listObjects("prefix-isolation/");
    assert.equal(result.ok, true);
    assert.deepEqual(result.objects, []);
  } finally {
    await root.deleteObject(key);
  }
});

// Integration tests: exercise a real S3 compatible server (MinIO, via `docker compose`) rather
// than mocking fetch or hand-rolling a fake — highest confidence that requests are actually well
// formed. Requires `docker compose up -d` (or `npm run dev:s3` in another terminal) running
// first; not part of `npm test`, run separately via `npm run test:integration`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type GeodeSettings } from "./settings.ts";
import { createS3Client, testConnection } from "./storage.ts";

const SECRET_ACCESS_KEY = "geodedev";

const liveSettings: GeodeSettings = {
  ...DEFAULT_SETTINGS,
  provider: "custom",
  endpoint: "http://localhost:4568",
  region: "us-east-1",
  bucket: "geode-test",
  accessKeyId: "geodedev",
};

test("testConnection: succeeds against a real bucket", async () => {
  const result = await testConnection(liveSettings, SECRET_ACCESS_KEY);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
});

test("putObject then getObject round trips the same bytes", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  const body = new TextEncoder().encode("hello geode");

  const putResult = await client.putObject("notes/hello.md", body);
  assert.equal(putResult.ok, true);
  assert.equal(putResult.status, "ok");

  const getResult = await client.getObject("notes/hello.md");
  assert.equal(getResult.ok, true);
  assert.equal(getResult.status, "ok");
  assert.deepEqual(getResult.body, body);
});

test("getObject on a missing key fails without a body", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  const result = await client.getObject("does/not/exist.md");
  assert.equal(result.ok, false);
  assert.equal(result.status, "not_found");
  assert.equal(result.body, null);
});

test("deleteObject removes an object", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  await client.putObject("notes/to-delete.md", new TextEncoder().encode("bye"));

  const deleteResult = await client.deleteObject("notes/to-delete.md");
  assert.equal(deleteResult.ok, true);
  assert.equal(deleteResult.status, "ok");

  const getResult = await client.getObject("notes/to-delete.md");
  assert.equal(getResult.ok, false);
  assert.equal(getResult.status, "not_found");
});

test("listObjects returns only keys under the given prefix", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
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
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
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
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
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
});

test("putObject/getObject round-trips a key containing a space and ampersand", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  const body = new TextEncoder().encode("special chars");

  const putResult = await client.putObject("encode-test/Foo & Bar.md", body);
  assert.equal(putResult.ok, true);

  const getResult = await client.getObject("encode-test/Foo & Bar.md");
  assert.equal(getResult.ok, true);
  assert.deepEqual(getResult.body, body);
});

test("putObject/getObject round-trips a key containing a hash and percent", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  const body = new TextEncoder().encode("edge cases");

  const putResult = await client.putObject("encode-test/100% #special.md", body);
  assert.equal(putResult.ok, true);

  const getResult = await client.getObject("encode-test/100% #special.md");
  assert.equal(getResult.ok, true);
  assert.deepEqual(getResult.body, body);
});

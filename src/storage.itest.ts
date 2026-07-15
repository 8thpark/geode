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
});

test("putObject then getObject round trips the same bytes", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  const body = new TextEncoder().encode("hello geode");

  const putResult = await client.putObject("notes/hello.md", body);
  assert.equal(putResult.ok, true);

  const getResult = await client.getObject("notes/hello.md");
  assert.equal(getResult.ok, true);
  assert.deepEqual(getResult.body, body);
});

test("getObject on a missing key fails without a body", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  const result = await client.getObject("does/not/exist.md");
  assert.equal(result.ok, false);
  assert.equal(result.body, null);
});

test("deleteObject removes an object", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  await client.putObject("notes/to-delete.md", new TextEncoder().encode("bye"));

  const deleteResult = await client.deleteObject("notes/to-delete.md");
  assert.equal(deleteResult.ok, true);

  const getResult = await client.getObject("notes/to-delete.md");
  assert.equal(getResult.ok, false);
});

test("listObjects returns only keys under the given prefix", async () => {
  const client = createS3Client(liveSettings, SECRET_ACCESS_KEY);
  await client.putObject("list-test/a.md", new TextEncoder().encode("a"));
  await client.putObject("list-test/b.md", new TextEncoder().encode("b"));
  await client.putObject("list-test-other/c.md", new TextEncoder().encode("c"));

  const result = await client.listObjects("list-test/");
  assert.equal(result.ok, true);
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
  let found = false;
  for (const object of result.objects) {
    if (object.key === "unprefixed.md") {
      found = true;
      break;
    }
  }
  assert.ok(found);
});

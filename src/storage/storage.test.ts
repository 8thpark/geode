import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type GeodeSettings } from "../settings/settings.ts";
import {
  probeConditionalWrites,
  type StorageClient,
  type Transport,
  testConnection,
} from "./storage.ts";
import { parseListObjectsXml } from "./xml.ts";

// stubTransport stands in for a real dispatcher in tests that only need testConnection to reach the
// network step; it always fails as if the endpoint were unreachable, so no unit test touches the
// network.
const stubTransport: Transport = async () => {
  throw new Error("unreachable in tests");
};

// honouringPut is a putObject that enforces ifAbsent the way a correct S3 server does: the first
// write to a key lands, a later ifAbsent write to the same key is rejected as a conflict.
function honouringPut(): StorageClient["putObject"] {
  const seen = new Set<string>();
  return async (key, _body, condition) => {
    if (condition !== undefined && condition.kind === "ifAbsent" && seen.has(key)) {
      return { ok: false, status: "conflict", message: "Storage rejected the write (412)" };
    }
    seen.add(key);
    return { ok: true, status: "ok", message: "" };
  };
}

// probeStub returns a StorageClient whose methods succeed with an etag by default, so each test
// overrides only the behaviour it exercises.
function probeStub(over: Partial<StorageClient>): StorageClient {
  const base: StorageClient = {
    putObject: async () => ({ ok: true, status: "ok", message: "" }),
    getObject: async () => ({
      ok: true,
      status: "ok",
      message: "",
      body: new Uint8Array(),
      etag: '"probe"',
    }),
    copyObject: async () => ({ ok: true, status: "ok", message: "" }),
    deleteObject: async () => ({ ok: true, status: "ok", message: "" }),
    listObjects: async () => ({ ok: true, status: "ok", message: "", objects: [] }),
  };
  return { ...base, ...over };
}

const missingFieldCases: {
  name: string;
  settings: GeodeSettings;
  secretAccessKey: string;
  want: string;
}[] = [
  {
    name: "missing bucket",
    settings: { ...DEFAULT_SETTINGS, accessKeyId: "AKIA123" },
    secretAccessKey: "shh",
    want: "Fill in bucket first",
  },
  {
    name: "missing access key ID",
    settings: { ...DEFAULT_SETTINGS, bucket: "my-vault" },
    secretAccessKey: "shh",
    want: "Fill in access key ID first",
  },
  {
    name: "missing secret access key",
    settings: { ...DEFAULT_SETTINGS, bucket: "my-vault", accessKeyId: "AKIA123" },
    secretAccessKey: "",
    want: "Fill in secret access key first",
  },
  {
    name: "missing account ID for R2",
    settings: {
      ...DEFAULT_SETTINGS,
      bucket: "my-vault",
      accessKeyId: "AKIA123",
    },
    secretAccessKey: "shh",
    want: "Fill in account ID first",
  },
  {
    name: "missing endpoint for custom",
    settings: {
      ...DEFAULT_SETTINGS,
      provider: "custom",
      region: "us-east-1",
      bucket: "my-vault",
      accessKeyId: "AKIA123",
    },
    secretAccessKey: "shh",
    want: "Fill in endpoint first",
  },
  {
    name: "missing region for custom",
    settings: {
      ...DEFAULT_SETTINGS,
      provider: "custom",
      endpoint: "https://s3.example.com",
      bucket: "my-vault",
      accessKeyId: "AKIA123",
    },
    secretAccessKey: "shh",
    want: "Fill in region first",
  },
];

for (const { name, settings, secretAccessKey, want } of missingFieldCases) {
  test(`testConnection: ${name}`, async () => {
    const result = await testConnection(settings, secretAccessKey, stubTransport);
    assert.equal(result.ok, false);
    assert.equal(result.status, "auth");
    assert.equal(result.message, want);
  });
}

test("testConnection: R2 with empty endpoint and region passes field check", async () => {
  const settings: GeodeSettings = {
    ...DEFAULT_SETTINGS,
    bucket: "my-vault",
    accessKeyId: "AKIA123",
    accountId: "acc123",
  };

  const result = await testConnection(settings, "shh", stubTransport);

  assert.equal(result.ok, false);
  assert.ok(!result.message.startsWith("Fill in"));
});

test("probeConditionalWrites: passes when the provider honours conditional writes", async () => {
  const client = probeStub({ putObject: honouringPut() });

  const result = await probeConditionalWrites(client);

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
});

test("probeConditionalWrites: fails when the provider silently ignores the condition", async () => {
  // Google Cloud Storage's S3 interop accepts If-None-Match: * and does nothing with it, so the
  // second write clobbers the first instead of conflicting.
  const client = probeStub({
    putObject: async () => ({ ok: true, status: "ok", message: "" }),
  });

  const result = await probeConditionalWrites(client);

  assert.equal(result.ok, false);
  assert.equal(result.status, "client");
  assert.match(result.message, /concurrent edits/);
});

test("probeConditionalWrites: fails when the provider rejects the conditional write", async () => {
  // Backblaze B2, Wasabi, and Garage reject the precondition outright rather than honour it.
  const client = probeStub({
    putObject: async () => ({
      ok: false,
      status: "server",
      message: "Storage rejected the write (501)",
    }),
  });

  const result = await probeConditionalWrites(client);

  assert.equal(result.ok, false);
  assert.equal(result.status, "server");
  assert.equal(result.message, "Storage rejected the write (501)");
});

test("probeConditionalWrites: fails when the provider returns no etag", async () => {
  const client = probeStub({
    putObject: honouringPut(),
    getObject: async () => ({
      ok: true,
      status: "ok",
      message: "",
      body: new Uint8Array(),
      etag: null,
    }),
  });

  const result = await probeConditionalWrites(client);

  assert.equal(result.ok, false);
  assert.equal(result.status, "client");
  assert.match(result.message, /ETag/);
});

test("probeConditionalWrites: deletes its probe object under the reserved prefix", async () => {
  let deleted = "";
  const client = probeStub({
    putObject: honouringPut(),
    deleteObject: async (key) => {
      deleted = key;
      return { ok: true, status: "ok", message: "" };
    },
  });

  await probeConditionalWrites(client);

  assert.ok(deleted.startsWith(".geode/"));
});

test("probeConditionalWrites: a rejecting cleanup does not mask a passing probe", async () => {
  const client = probeStub({
    putObject: honouringPut(),
    deleteObject: async () => {
      throw new Error("network blip during cleanup");
    },
  });

  const result = await probeConditionalWrites(client);

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
});

test("parseListObjectsXml decodes XML entities in object keys", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>notes/Foo &amp; Bar &#40;draft&#41;.md</Key>
    <LastModified>2026-07-13T00:00:00.000Z</LastModified>
    <Size>12</Size>
  </Contents>
  <Contents>
    <Key>notes/2 &lt; 3 &#x1F600;.md</Key>
    <LastModified>2026-07-13T00:01:00.000Z</LastModified>
    <Size>34</Size>
  </Contents>
</ListBucketResult>`;

  assert.deepEqual(parseListObjectsXml(xml), {
    objects: [
      { key: "notes/Foo & Bar (draft).md", size: 12, lastModified: "2026-07-13T00:00:00.000Z" },
      { key: "notes/2 < 3 😀.md", size: 34, lastModified: "2026-07-13T00:01:00.000Z" },
    ],
    nextContinuationToken: undefined,
  });
});

test("parseListObjectsXml surfaces the continuation token when the listing is truncated", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>notes/a.md</Key>
    <LastModified>2026-07-13T00:00:00.000Z</LastModified>
    <Size>1</Size>
  </Contents>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
</ListBucketResult>`;

  const page = parseListObjectsXml(xml);
  assert.equal(page.nextContinuationToken, "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=");
  assert.equal(page.objects.length, 1);
});

test("parseListObjectsXml ignores the token on the final page", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>notes/a.md</Key>
    <LastModified>2026-07-13T00:00:00.000Z</LastModified>
    <Size>1</Size>
  </Contents>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

  assert.equal(parseListObjectsXml(xml).nextContinuationToken, undefined);
});

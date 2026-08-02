import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type GeodeSettings } from "../settings/settings.ts";
import {
  createS3Client,
  type HttpResponse,
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
    headObject: async () => ({ ok: true, status: "ok", message: "", etag: '"probe"' }),
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

// deadlineSettings are just enough config for createS3Client to sign and dispatch; no request in
// these tests ever reaches a network, they only exercise how long the deadline waits.
const deadlineSettings: GeodeSettings = {
  ...DEFAULT_SETTINGS,
  provider: "custom",
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "vault",
  accessKeyId: "AKIA123",
};

// stallingTransport never settles and resolves dispatched the moment it is called, which is right
// after the request is signed and the deadline timer is already scheduled. Awaiting dispatched is
// how a test knows the (mocked) timer exists before it ticks the clock.
function stallingTransport(): { transport: Transport; dispatched: Promise<void> } {
  let signal: () => void = () => {};
  const dispatched = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const transport: Transport = () => {
    signal();
    return new Promise<HttpResponse>(() => {});
  };
  return { transport, dispatched };
}

test("getObject: a large object's read deadline scales past the base budget", async (t) => {
  // A 10 MB read earns 60s base + 10 allowances = 160s. Before the fix it got the bare 60s because
  // a GET carries no request body, so a slow attachment download was cut off part way through.
  const { transport, dispatched } = stallingTransport();
  const client = createS3Client(deadlineSettings, "shh", transport);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let settled = false;
  const read = client.getObject("big.bin", 10_000_000);
  read.then(() => {
    settled = true;
  });
  await dispatched;

  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(settled, false, "a 10 MB read must outlast the 60s base budget");

  t.mock.timers.tick(100_000);
  const result = await read;
  assert.equal(result.ok, false);
  assert.match(result.message, /timed out/);
});

test("getObject: a read with no known size falls back to the base budget", async (t) => {
  const { transport, dispatched } = stallingTransport();
  const client = createS3Client(deadlineSettings, "shh", transport);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let settled = false;
  const read = client.getObject("small.md");
  read.then(() => {
    settled = true;
  });
  await dispatched;

  t.mock.timers.tick(59_999);
  await Promise.resolve();
  assert.equal(settled, false, "the base budget has not elapsed yet");

  t.mock.timers.tick(1);
  const result = await read;
  assert.equal(result.ok, false);
  assert.match(result.message, /timed out/);
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
    ok: true,
    page: {
      objects: [
        { key: "notes/Foo & Bar (draft).md", size: 12, lastModified: "2026-07-13T00:00:00.000Z" },
        { key: "notes/2 < 3 😀.md", size: 34, lastModified: "2026-07-13T00:01:00.000Z" },
      ],
      nextContinuationToken: undefined,
    },
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

  const result = parseListObjectsXml(xml);
  assert.ok(result.ok);
  assert.equal(result.page.nextContinuationToken, "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=");
  assert.equal(result.page.objects.length, 1);
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

  const result = parseListObjectsXml(xml);
  assert.ok(result.ok);
  assert.equal(result.page.nextContinuationToken, undefined);
});

test("parseListObjectsXml treats a bare IsTruncated marker as an empty bucket", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

  assert.deepEqual(parseListObjectsXml(xml), {
    ok: true,
    page: { objects: [], nextContinuationToken: undefined },
  });
});

test("parseListObjectsXml treats a bare KeyCount marker as an empty bucket", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <KeyCount>0</KeyCount>
</ListBucketResult>`;

  assert.deepEqual(parseListObjectsXml(xml), {
    ok: true,
    page: { objects: [], nextContinuationToken: undefined },
  });
});

test("parseListObjectsXml fails loudly on a body with no recognizable listing markers", () => {
  // A provider whose response uses a namespace prefix on <Contents> (or attributes this parser's
  // bare-tag regex doesn't match) would otherwise parse to zero objects, indistinguishable from a
  // genuinely empty bucket. That would let a first sync proceed and silently orphan every file the
  // listing failed to surface (#109), so this shape must be refused rather than guessed at.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <ns:Contents>
    <ns:Key>notes/a.md</ns:Key>
  </ns:Contents>
</ListBucketResult>`;

  assert.deepEqual(parseListObjectsXml(xml), {
    ok: false,
    message: "listing response XML shape is unrecognized; refusing to guess it is empty",
  });
});

test("parseListObjectsXml fails on an attribute-bearing Contents despite IsTruncated", () => {
  // A namespace prefix isn't the only way a provider can dodge the strict <Contents> pattern: an
  // attribute on the opening tag does too, and unlike a wholly unrecognized body, the rest of the
  // response can still look completely ordinary, IsTruncated included. Checking only for
  // IsTruncated's presence would wave this through as an empty bucket and orphan the entry it
  // dropped, so the parser must instead notice that a Contents-shaped tag existed but never made
  // it into the parsed objects.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents encoding-type="url">
    <Key>notes/a.md</Key>
    <LastModified>2026-07-13T00:00:00.000Z</LastModified>
    <Size>1</Size>
  </Contents>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

  assert.deepEqual(parseListObjectsXml(xml), {
    ok: false,
    message: "listing response XML shape is unrecognized; refusing to guess it is empty",
  });
});

test("parseListObjectsXml fails loudly on a blank body", () => {
  // A 200 response with an empty body is never a genuine ListObjectsV2 response, even for an
  // empty bucket: the real thing is always a full XML document carrying at least IsTruncated.
  assert.deepEqual(parseListObjectsXml(""), {
    ok: false,
    message: "listing response XML shape is unrecognized; refusing to guess it is empty",
  });
});

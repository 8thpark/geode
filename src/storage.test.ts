import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type GeodeSettings } from "./settings.ts";
import { parseListObjectsXml, testConnection } from "./storage.ts";

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
];

for (const { name, settings, secretAccessKey, want } of missingFieldCases) {
  test(`testConnection: ${name}`, async () => {
    const result = await testConnection(settings, secretAccessKey);
    assert.equal(result.ok, false);
    assert.equal(result.status, "auth");
    assert.equal(result.message, want);
  });
}

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

  assert.deepEqual(parseListObjectsXml(xml), [
    { key: "notes/Foo & Bar (draft).md", size: 12, lastModified: "2026-07-13T00:00:00.000Z" },
    { key: "notes/2 < 3 😀.md", size: 34, lastModified: "2026-07-13T00:01:00.000Z" },
  ]);
});

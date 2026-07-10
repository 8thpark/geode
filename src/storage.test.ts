import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type GeodeSettings } from "./settings.ts";
import { testConnection } from "./storage.ts";

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
    assert.equal(result.message, want);
  });
}

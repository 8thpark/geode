import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  endpointFor,
  type GeodeSettings,
  normalizeSettings,
} from "./settings.ts";

const normalizeCases: { name: string; input: unknown; want: GeodeSettings }[] = [
  {
    name: "null",
    input: null,
    want: DEFAULT_SETTINGS,
  },
  {
    name: "undefined",
    input: undefined,
    want: DEFAULT_SETTINGS,
  },
  {
    name: "empty object",
    input: {},
    want: DEFAULT_SETTINGS,
  },
  {
    name: "partial legacy object",
    input: { bucket: "my-bucket", accessKeyId: "AKIA123" },
    want: { ...DEFAULT_SETTINGS, bucket: "my-bucket", accessKeyId: "AKIA123" },
  },
  {
    name: "junk types in string fields",
    input: { accountId: 42, endpoint: true, region: [1, 2], bucket: null, accessKeyId: {} },
    want: DEFAULT_SETTINGS,
  },
  {
    name: "junk version is ignored and forced to 1",
    input: { version: "not-a-number" },
    want: DEFAULT_SETTINGS,
  },
  {
    name: "unknown keys dropped",
    input: { bucket: "my-bucket", secretAccessKey: "x" },
    want: { ...DEFAULT_SETTINGS, bucket: "my-bucket" },
  },
  {
    name: "provider s3 coerced to r2",
    input: { provider: "s3" },
    want: DEFAULT_SETTINGS,
  },
  {
    name: "provider 42 coerced to r2",
    input: { provider: 42 },
    want: DEFAULT_SETTINGS,
  },
  {
    name: "provider null coerced to r2",
    input: { provider: null },
    want: DEFAULT_SETTINGS,
  },
  {
    name: "provider custom preserved",
    input: { provider: "custom", endpoint: "https://s3.example.com" },
    want: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://s3.example.com" },
  },
  {
    name: "secretId missing defaults to empty string",
    input: {},
    want: DEFAULT_SETTINGS,
  },
  {
    name: "secretId non-string coerced to empty string",
    input: { secretId: 42 },
    want: DEFAULT_SETTINGS,
  },
  {
    name: "secretId valid string passes through",
    input: { secretId: "geode-my-r2-key" },
    want: { ...DEFAULT_SETTINGS, secretId: "geode-my-r2-key" },
  },
];

for (const { name, input, want } of normalizeCases) {
  test(`normalizeSettings: ${name}`, () => {
    assert.deepStrictEqual(normalizeSettings(input), want);
  });
}

test("normalizeSettings: unknown keys dropped does not leak them onto the result", () => {
  const result = normalizeSettings({ bucket: "my-bucket", secretAccessKey: "x" });
  assert.strictEqual("secretAccessKey" in result, false);
});

const endpointCases: { name: string; input: GeodeSettings; want: string }[] = [
  {
    name: "r2",
    input: { ...DEFAULT_SETTINGS, accountId: "abc123" },
    want: "https://abc123.r2.cloudflarestorage.com",
  },
  {
    name: "custom",
    input: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://s3.example.com" },
    want: "https://s3.example.com",
  },
];

for (const { name, input, want } of endpointCases) {
  test(`endpointFor: ${name}`, () => {
    assert.strictEqual(endpointFor(input), want);
  });
}

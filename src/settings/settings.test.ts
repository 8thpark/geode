import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  draftForDisplay,
  endpointFor,
  type GeodeSettings,
  hasConnectionConfig,
  isAwsRegion,
  normalizeSettings,
  providerOptions,
  regionFor,
  settingsEqual,
} from "./settings.ts";

const normalizeCases: { name: string; input: unknown; want: GeodeSettings }[] = [
  {
    name: "partial legacy object",
    input: { bucket: "my-bucket", accessKeyId: "AKIA123" },
    want: { ...DEFAULT_SETTINGS, bucket: "my-bucket", accessKeyId: "AKIA123" },
  },
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
    name: "provider s3 preserved",
    input: { provider: "s3", region: "eu-west-2" },
    want: { ...DEFAULT_SETTINGS, provider: "s3", region: "eu-west-2" },
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
    input: { secretId: "foo" },
    want: { ...DEFAULT_SETTINGS, secretId: "foo" },
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
    name: "amazon s3",
    input: { ...DEFAULT_SETTINGS, provider: "s3", region: "eu-west-2" },
    want: "https://s3.eu-west-2.amazonaws.com",
  },
  {
    name: "custom",
    input: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://s3.example.com" },
    want: "https://s3.example.com",
  },
  {
    name: "amazon s3 with a region carrying URL authority delimiters yields no endpoint",
    input: { ...DEFAULT_SETTINGS, provider: "s3", region: "x@attacker.example:443#" },
    want: "",
  },
  {
    name: "amazon s3 with a region carrying a path separator yields no endpoint",
    input: { ...DEFAULT_SETTINGS, provider: "s3", region: "us-east-1/../evil" },
    want: "",
  },
  {
    name: "amazon s3 with an empty region yields no endpoint",
    input: { ...DEFAULT_SETTINGS, provider: "s3", region: "" },
    want: "",
  },
];

for (const { name, input, want } of endpointCases) {
  test(`endpointFor: ${name}`, () => {
    assert.strictEqual(endpointFor(input), want);
  });
}

const awsRegionCases: { region: string; want: boolean }[] = [
  { region: "us-east-1", want: true },
  { region: "eu-west-2", want: true },
  { region: "ap-southeast-1", want: true },
  { region: "us-gov-west-1", want: true },
  { region: "", want: false },
  { region: "US-EAST-1", want: false },
  { region: "us-east", want: false },
  { region: "us-east-1 ", want: false },
  { region: "x@attacker.example:443#", want: false },
  { region: "us-east-1@attacker.example", want: false },
  { region: "us-east-1/../evil", want: false },
  { region: "us-east-1\nx", want: false },
];

for (const { region, want } of awsRegionCases) {
  test(`isAwsRegion: ${JSON.stringify(region)} is ${want}`, () => {
    assert.strictEqual(isAwsRegion(region), want);
  });
}

const regionCases: { name: string; input: GeodeSettings; want: string }[] = [
  {
    name: "r2 always signs as auto",
    input: { ...DEFAULT_SETTINGS, region: "us-east-1" },
    want: "auto",
  },
  {
    name: "custom uses the configured region",
    input: { ...DEFAULT_SETTINGS, provider: "custom", region: "eu-west-2" },
    want: "eu-west-2",
  },
];

for (const { name, input, want } of regionCases) {
  test(`regionFor: ${name}`, () => {
    assert.strictEqual(regionFor(input), want);
  });
}

test("providerOptions: production excludes the custom provider", () => {
  assert.deepStrictEqual(providerOptions(false), {
    r2: "Cloudflare R2",
    s3: "Amazon S3",
  });
});

test("providerOptions: local development includes the custom provider", () => {
  assert.deepStrictEqual(providerOptions(true), {
    r2: "Cloudflare R2",
    s3: "Amazon S3",
    custom: "Custom",
  });
});

const settingsEqualCases: { name: string; a: GeodeSettings; b: GeodeSettings; want: boolean }[] = [
  {
    name: "identical values are equal",
    a: DEFAULT_SETTINGS,
    b: { ...DEFAULT_SETTINGS },
    want: true,
  },
  {
    name: "different bucket is not equal",
    a: DEFAULT_SETTINGS,
    b: { ...DEFAULT_SETTINGS, bucket: "my-bucket" },
    want: false,
  },
  {
    name: "different provider is not equal",
    a: DEFAULT_SETTINGS,
    b: { ...DEFAULT_SETTINGS, provider: "custom" },
    want: false,
  },
  {
    name: "reverting a change back to the original value is equal again",
    a: DEFAULT_SETTINGS,
    b: { ...{ ...DEFAULT_SETTINGS, provider: "custom" }, provider: "r2" },
    want: true,
  },
];

for (const { name, a, b, want } of settingsEqualCases) {
  test(`settingsEqual: ${name}`, () => {
    assert.strictEqual(settingsEqual(a, b), want);
  });
}

const hasConnectionConfigCases: { name: string; input: GeodeSettings; want: boolean }[] = [
  {
    name: "r2 with all fields is complete",
    input: {
      ...DEFAULT_SETTINGS,
      accountId: "acc",
      bucket: "b",
      accessKeyId: "a",
      secretId: "s",
    },
    want: true,
  },
  {
    name: "empty settings are incomplete",
    input: DEFAULT_SETTINGS,
    want: false,
  },
  {
    name: "r2 missing account ID is incomplete",
    input: { ...DEFAULT_SETTINGS, bucket: "b", accessKeyId: "a", secretId: "s" },
    want: false,
  },
  {
    name: "s3 missing region is incomplete",
    input: {
      ...DEFAULT_SETTINGS,
      provider: "s3",
      bucket: "b",
      accessKeyId: "a",
      secretId: "s",
    },
    want: false,
  },
  {
    name: "s3 with all fields is complete",
    input: {
      ...DEFAULT_SETTINGS,
      provider: "s3",
      region: "us-east-1",
      bucket: "b",
      accessKeyId: "a",
      secretId: "s",
    },
    want: true,
  },
  {
    name: "s3 with a region that is not an AWS region identifier is incomplete",
    input: {
      ...DEFAULT_SETTINGS,
      provider: "s3",
      region: "x@attacker.example:443#",
      bucket: "b",
      accessKeyId: "a",
      secretId: "s",
    },
    want: false,
  },
  {
    name: "custom missing region is incomplete",
    input: {
      ...DEFAULT_SETTINGS,
      provider: "custom",
      endpoint: "https://s3.example.com",
      bucket: "b",
      accessKeyId: "a",
      secretId: "s",
    },
    want: false,
  },
  {
    name: "custom with all fields is complete",
    input: {
      ...DEFAULT_SETTINGS,
      provider: "custom",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "b",
      accessKeyId: "a",
      secretId: "s",
    },
    want: true,
  },
];

for (const { name, input, want } of hasConnectionConfigCases) {
  test(`hasConnectionConfig: ${name}`, () => {
    assert.strictEqual(hasConnectionConfig(input), want);
  });
}

const draftForDisplayCases: {
  name: string;
  auto: boolean;
  currentDraft: GeodeSettings;
  savedSettings: GeodeSettings;
  want: GeodeSettings;
}[] = [
  {
    name: "auto open re-seeds from saved settings after external update",
    auto: true,
    currentDraft: { ...DEFAULT_SETTINGS, bucket: "stale-bucket" },
    savedSettings: { ...DEFAULT_SETTINGS, bucket: "synced-bucket" },
    want: { ...DEFAULT_SETTINGS, bucket: "synced-bucket" },
  },
  {
    name: "auto open clears a phantom dirty draft against newer saved settings",
    auto: true,
    currentDraft: { ...DEFAULT_SETTINGS, accessKeyId: "OLD" },
    savedSettings: { ...DEFAULT_SETTINGS, accessKeyId: "NEW" },
    want: { ...DEFAULT_SETTINGS, accessKeyId: "NEW" },
  },
  {
    name: "internal re-render keeps the in-progress draft",
    auto: false,
    currentDraft: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://s3.example.com" },
    savedSettings: DEFAULT_SETTINGS,
    want: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://s3.example.com" },
  },
  {
    name: "auto open returns a shallow copy, not the saved settings object itself",
    auto: true,
    currentDraft: DEFAULT_SETTINGS,
    savedSettings: { ...DEFAULT_SETTINGS, bucket: "b" },
    want: { ...DEFAULT_SETTINGS, bucket: "b" },
  },
];

for (const { name, auto, currentDraft, savedSettings, want } of draftForDisplayCases) {
  test(`draftForDisplay: ${name}`, () => {
    const got = draftForDisplay(auto, currentDraft, savedSettings);
    assert.deepStrictEqual(got, want);
  });
}

test("draftForDisplay: auto open returns a new object so later draft edits do not mutate saved settings", () => {
  const saved = { ...DEFAULT_SETTINGS, bucket: "saved" };
  const got = draftForDisplay(true, DEFAULT_SETTINGS, saved);
  assert.notStrictEqual(got, saved);
  got.bucket = "edited";
  assert.strictEqual(saved.bucket, "saved");
});

test("draftForDisplay: internal re-render returns the same draft reference", () => {
  const draft = { ...DEFAULT_SETTINGS, bucket: "in-progress" };
  const got = draftForDisplay(false, draft, DEFAULT_SETTINGS);
  assert.strictEqual(got, draft);
});

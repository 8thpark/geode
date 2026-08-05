import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bucketFor,
  type ConnectionStatus,
  canSave,
  DEFAULT_SETTINGS,
  draftForDisplay,
  endpointFor,
  type GeodeSettings,
  hasConnectionConfig,
  isCurrentConnectionResult,
  normalizePrefix,
  normalizeSettings,
  prefixError,
  regionFor,
  saveDraft,
  settingsEqual,
} from "./settings.ts";

const canSaveCases: {
  name: string;
  dirty: boolean;
  connectionStatus: ConnectionStatus;
  want: boolean;
}[] = [
  {
    name: "dirty draft with no test result is saveable",
    dirty: true,
    connectionStatus: "unknown",
    want: true,
  },
  {
    name: "dirty draft after a successful test is saveable",
    dirty: true,
    connectionStatus: "ok",
    want: true,
  },
  {
    name: "queued save is blocked while a connection test is in flight",
    dirty: true,
    connectionStatus: "checking",
    want: false,
  },
  {
    name: "queued save is blocked when the connection test fails first",
    dirty: true,
    connectionStatus: "error",
    want: false,
  },
  {
    name: "clean draft with no test result is not saveable",
    dirty: false,
    connectionStatus: "unknown",
    want: false,
  },
  {
    name: "clean draft during a connection test is not saveable",
    dirty: false,
    connectionStatus: "checking",
    want: false,
  },
  {
    name: "clean draft after a successful test is not saveable",
    dirty: false,
    connectionStatus: "ok",
    want: false,
  },
  {
    name: "clean draft after a failed test is not saveable",
    dirty: false,
    connectionStatus: "error",
    want: false,
  },
];

for (const { name, dirty, connectionStatus, want } of canSaveCases) {
  test(`canSave: ${name}`, () => {
    assert.strictEqual(canSave(dirty, connectionStatus), want);
  });
}

test("canSave: editing after a failed test restores unknown-state eligibility", () => {
  assert.strictEqual(canSave(true, "checking"), false);
  assert.strictEqual(canSave(true, "error"), false);
  assert.strictEqual(canSave(true, "unknown"), true);
});

test("isCurrentConnectionResult: an edit invalidates an in-flight result", () => {
  const testedSettings = { ...DEFAULT_SETTINGS, bucket: "before-edit" };
  const currentSettings = { ...testedSettings, bucket: "after-edit" };

  assert.strictEqual(isCurrentConnectionResult(1, 1, testedSettings, currentSettings), false);
  assert.strictEqual(canSave(true, "unknown"), true);
});

test("isCurrentConnectionResult: only the latest unchanged draft accepts a result", () => {
  const testedSettings = { ...DEFAULT_SETTINGS, bucket: "unchanged" };

  assert.strictEqual(isCurrentConnectionResult(2, 2, testedSettings, testedSettings), true);
  assert.strictEqual(isCurrentConnectionResult(1, 2, testedSettings, testedSettings), false);
});

for (const connectionStatus of ["checking", "error"] as const) {
  test(`saveDraft: ${connectionStatus} result blocks a queued save`, async () => {
    const savedSettings = { ...DEFAULT_SETTINGS, bucket: "saved" };
    let logCalls = 0;
    let saveCalls = 0;
    const target = {
      logger: {
        info: () => {
          logCalls += 1;
        },
      },
      settings: savedSettings,
      saveSettings: async () => {
        saveCalls += 1;
      },
    };

    await saveDraft(target, { ...savedSettings, bucket: "draft" }, connectionStatus);

    assert.deepStrictEqual(target.settings, savedSettings);
    assert.strictEqual(logCalls, 0);
    assert.strictEqual(saveCalls, 0);
  });
}

for (const connectionStatus of ["unknown", "ok"] as const) {
  test(`saveDraft: ${connectionStatus} state persists a dirty draft`, async () => {
    const savedSettings = { ...DEFAULT_SETTINGS, bucket: "saved" };
    let saveCalls = 0;
    const target = {
      logger: { info: () => {} },
      settings: savedSettings,
      saveSettings: async () => {
        saveCalls += 1;
      },
    };

    await saveDraft(target, { ...savedSettings, bucket: "draft" }, connectionStatus);

    assert.strictEqual(target.settings.bucket, "draft");
    assert.strictEqual(saveCalls, 1);
  });
}

test("saveDraft: clean unknown state does not persist", async () => {
  const savedSettings = { ...DEFAULT_SETTINGS, bucket: "saved" };
  let saveCalls = 0;
  const target = {
    logger: { info: () => {} },
    settings: savedSettings,
    saveSettings: async () => {
      saveCalls += 1;
    },
  };

  await saveDraft(target, { ...savedSettings }, "unknown");

  assert.deepStrictEqual(target.settings, savedSettings);
  assert.strictEqual(saveCalls, 0);
});

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
    input: { secretId: "foo" },
    want: { ...DEFAULT_SETTINGS, secretId: "foo" },
  },
  {
    name: "prefix missing defaults to the bucket root",
    input: {},
    want: DEFAULT_SETTINGS,
  },
  {
    name: "prefix non-string coerced to the bucket root",
    input: { prefix: 42 },
    want: DEFAULT_SETTINGS,
  },
  {
    name: "prefix is stored exactly as typed, not canonicalized",
    input: { prefix: "/vaults/personal/" },
    want: { ...DEFAULT_SETTINGS, prefix: "/vaults/personal/" },
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
    name: "r2 with surrounding whitespace on accountId is trimmed",
    input: { ...DEFAULT_SETTINGS, accountId: "  abc123  " },
    want: "https://abc123.r2.cloudflarestorage.com",
  },
  {
    name: "custom",
    input: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://s3.example.com" },
    want: "https://s3.example.com",
  },
  {
    name: "custom with no scheme is prefixed with https",
    input: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "s3.example.com" },
    want: "https://s3.example.com",
  },
  {
    name: "custom with uppercase scheme is left alone",
    input: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "HTTP://s3.example.com" },
    want: "HTTP://s3.example.com",
  },
  {
    name: "custom with trailing slash is stripped",
    input: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "https://s3.example.com/" },
    want: "https://s3.example.com",
  },
  {
    name: "custom with surrounding whitespace is trimmed",
    input: { ...DEFAULT_SETTINGS, provider: "custom", endpoint: "  https://s3.example.com  " },
    want: "https://s3.example.com",
  },
];

for (const { name, input, want } of endpointCases) {
  test(`endpointFor: ${name}`, () => {
    assert.strictEqual(endpointFor(input), want);
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
  {
    name: "custom with surrounding whitespace on region is trimmed",
    input: { ...DEFAULT_SETTINGS, provider: "custom", region: "  eu-west-2  " },
    want: "eu-west-2",
  },
];

for (const { name, input, want } of regionCases) {
  test(`regionFor: ${name}`, () => {
    assert.strictEqual(regionFor(input), want);
  });
}

const bucketCases: { name: string; input: GeodeSettings; want: string }[] = [
  {
    name: "a plain bucket is left alone",
    input: { ...DEFAULT_SETTINGS, bucket: "my-vault" },
    want: "my-vault",
  },
  {
    name: "surrounding whitespace is trimmed",
    input: { ...DEFAULT_SETTINGS, bucket: "  my-vault  " },
    want: "my-vault",
  },
  {
    name: "a leading space no longer survives into the connection",
    input: { ...DEFAULT_SETTINGS, bucket: " my-vault" },
    want: "my-vault",
  },
];

for (const { name, input, want } of bucketCases) {
  test(`bucketFor: ${name}`, () => {
    assert.strictEqual(bucketFor(input), want);
  });
}

const normalizePrefixCases: { name: string; input: string; want: string }[] = [
  { name: "empty is the bucket root", input: "", want: "" },
  { name: "whitespace only is the bucket root", input: "   ", want: "" },
  { name: "a plain path is left alone", input: "vaults/personal", want: "vaults/personal" },
  { name: "a leading slash is dropped", input: "/vaults/personal", want: "vaults/personal" },
  { name: "a trailing slash is dropped", input: "vaults/personal/", want: "vaults/personal" },
  { name: "surrounding whitespace is dropped", input: "  vaults  ", want: "vaults" },
  { name: "repeated slashes collapse", input: "vaults//personal", want: "vaults/personal" },
  { name: "slashes alone are the bucket root", input: "///", want: "" },
  { name: "a single segment survives", input: "vaults", want: "vaults" },
  { name: "interior spaces are content, not padding", input: "my vaults", want: "my vaults" },
];

for (const { name, input, want } of normalizePrefixCases) {
  test(`normalizePrefix: ${name}`, () => {
    assert.strictEqual(normalizePrefix(input), want);
  });
}

test("normalizePrefix: canonicalizing an already canonical prefix changes nothing", () => {
  // The prefix is canonicalized at every point of use rather than on save, so it runs over its own
  // output constantly; a second pass that moved it would make the key an object lives at depend on
  // how many times the value had been round tripped.
  for (const { input } of normalizePrefixCases) {
    const once = normalizePrefix(input);

    assert.strictEqual(normalizePrefix(once), once, input);
  }
});

const prefixErrorCases: { name: string; input: string; want: string }[] = [
  { name: "empty is fine", input: "", want: "" },
  { name: "a plain path is fine", input: "vaults/personal", want: "" },
  { name: "slashes normalizePrefix absorbs are fine", input: "//vaults//", want: "" },
  { name: "a dot inside a name is fine", input: "vaults/v1.2", want: "" },
  { name: "a leading dot is fine", input: ".vaults", want: "" },
  {
    name: "a backslash is refused",
    input: "vaults\\personal",
    want: "Prefix separates folders with /, not \\",
  },
  {
    name: "a newline is refused",
    input: "vaults\npersonal",
    want: "Prefix can't contain control characters",
  },
  {
    name: "a tab is refused",
    input: "vaults\tpersonal",
    want: "Prefix can't contain control characters",
  },
  {
    name: "a relative parent segment is refused",
    input: "vaults/../personal",
    want: "Prefix can't use . or .. as a folder",
  },
  {
    name: "a relative current segment is refused",
    input: "vaults/./personal",
    want: "Prefix can't use . or .. as a folder",
  },
  {
    name: "a lone parent segment is refused",
    input: "..",
    want: "Prefix can't use . or .. as a folder",
  },
];

for (const { name, input, want } of prefixErrorCases) {
  test(`prefixError: ${name}`, () => {
    assert.strictEqual(prefixError(input), want);
  });
}

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
    name: "different prefix is not equal",
    a: DEFAULT_SETTINGS,
    b: { ...DEFAULT_SETTINGS, prefix: "vaults/personal" },
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

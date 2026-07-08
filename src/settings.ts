// GeodeSettings is the persisted shape of a Geode plugin's user configuration.
export type GeodeSettings = {
  version: number;
  provider: "r2" | "custom";
  accountId: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretId: string;
};

// DEFAULT_SETTINGS is the complete zero value used before any user configuration is loaded.
export const DEFAULT_SETTINGS: GeodeSettings = {
  version: 1,
  provider: "r2",
  accountId: "",
  endpoint: "",
  region: "",
  bucket: "",
  accessKeyId: "",
  secretId: "",
};

// stringOr returns v if it is a string, otherwise fallback.
function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  return fallback;
}

// providerOr returns "custom" if v is "custom", otherwise "r2".
function providerOr(v: unknown): "r2" | "custom" {
  if (v === "custom") return "custom";
  return "r2";
}

// normalizeSettings returns a complete GeodeSettings from whatever loadData produced,
// filling gaps with defaults.
export function normalizeSettings(raw: unknown): GeodeSettings {
  let source: Record<string, unknown> = {};
  if (raw !== null && typeof raw === "object") {
    source = raw as Record<string, unknown>;
  }

  return {
    // Current schema is version 1; future migrations branch on source.version here.
    version: 1,
    provider: providerOr(source.provider),
    accountId: stringOr(source.accountId, DEFAULT_SETTINGS.accountId),
    endpoint: stringOr(source.endpoint, DEFAULT_SETTINGS.endpoint),
    region: stringOr(source.region, DEFAULT_SETTINGS.region),
    bucket: stringOr(source.bucket, DEFAULT_SETTINGS.bucket),
    accessKeyId: stringOr(source.accessKeyId, DEFAULT_SETTINGS.accessKeyId),
    secretId: stringOr(source.secretId, DEFAULT_SETTINGS.secretId),
  };
}

// endpointFor returns the storage endpoint URL to use for the given settings.
export function endpointFor(settings: GeodeSettings): string {
  if (settings.provider === "r2") {
    return `https://${settings.accountId}.r2.cloudflarestorage.com`;
  }
  return settings.endpoint;
}

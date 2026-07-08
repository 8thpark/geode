export interface GeodeSettings {
  version: number;
  provider: "r2" | "custom";
  accountId: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretId: string;
}

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

export function normalizeSettings(raw: unknown): GeodeSettings {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  return {
    // Current schema is version 1; future migrations branch on source.version here.
    version: 1,
    provider: source.provider === "custom" ? "custom" : "r2",
    accountId: typeof source.accountId === "string" ? source.accountId : DEFAULT_SETTINGS.accountId,
    endpoint: typeof source.endpoint === "string" ? source.endpoint : DEFAULT_SETTINGS.endpoint,
    region: typeof source.region === "string" ? source.region : DEFAULT_SETTINGS.region,
    bucket: typeof source.bucket === "string" ? source.bucket : DEFAULT_SETTINGS.bucket,
    accessKeyId:
      typeof source.accessKeyId === "string" ? source.accessKeyId : DEFAULT_SETTINGS.accessKeyId,
    secretId: typeof source.secretId === "string" ? source.secretId : DEFAULT_SETTINGS.secretId,
  };
}

export function endpointFor(settings: GeodeSettings): string {
  return settings.provider === "r2"
    ? `https://${settings.accountId}.r2.cloudflarestorage.com`
    : settings.endpoint;
}

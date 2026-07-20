// GeodeSettings is the persisted shape of a Geode plugin's user configuration.
export type GeodeSettings = {
  version: number;
  provider: "r2" | "custom";
  accountId: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  // secretId is a SecretStorage reference name, not the secret value itself. Obsidian's
  // SecretComponent picker lets a user pick or create a secret under any name of their choosing;
  // it does not support forcing new entries onto a fixed ID, so we have to remember whichever
  // one they picked.
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
  if (typeof v === "string") {
    return v;
  }
  return fallback;
}

// providerOr returns "custom" if v is "custom", otherwise "r2".
export function providerOr(v: unknown): "r2" | "custom" {
  if (v === "custom") {
    return "custom";
  }
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

// regionFor returns the signing region to use for the given settings. R2 always signs with
// "auto" regardless of what a user might type, so custom is the only provider that needs one.
export function regionFor(settings: GeodeSettings): string {
  if (settings.provider === "r2") {
    return "auto";
  }

  return settings.region;
}

// settingsEqual reports whether two settings values are identical field for field. Used to
// derive whether a draft has unsaved changes by comparing it to the last saved settings, rather
// than tracking a dirty flag that can't self-correct when an edit is reverted by hand.
export function settingsEqual(a: GeodeSettings, b: GeodeSettings): boolean {
  return (
    a.provider === b.provider &&
    a.accountId === b.accountId &&
    a.endpoint === b.endpoint &&
    a.region === b.region &&
    a.bucket === b.bucket &&
    a.accessKeyId === b.accessKeyId &&
    a.secretId === b.secretId
  );
}

// hasConnectionConfig reports whether settings have enough filled in to attempt a connection.
export function hasConnectionConfig(settings: GeodeSettings): boolean {
  if (settings.bucket === "" || settings.accessKeyId === "" || settings.secretId === "") {
    return false;
  }
  if (settings.provider === "r2") {
    return settings.accountId !== "";
  }
  return settings.endpoint !== "" && settings.region !== "";
}

// draftForDisplay returns the draft a settings tab should show for a given render.
// When auto is true (Obsidian is opening the tab), the draft is re-seeded from saved
// settings so an external data.json update cannot leave a stale draft and phantom
// "Unsaved changes". When auto is false (an internal re-render such as a provider
// switch), the in-progress draft is kept.
export function draftForDisplay(
  auto: boolean,
  currentDraft: GeodeSettings,
  savedSettings: GeodeSettings,
): GeodeSettings {
  if (auto) {
    return { ...savedSettings };
  }
  return currentDraft;
}

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

// Provider identifies a supported S3 compatible storage configuration.
export type Provider = "r2" | "s3" | "custom";

// GeodeSettings is the persisted shape of a Geode plugin's user configuration.
export type GeodeSettings = {
  version: number;
  provider: Provider;
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

// endpointFor returns the storage endpoint URL to use for the given settings.
// The Amazon S3 endpoint interpolates the region into the URL authority, so a region carrying
// authority delimiters (`x@attacker.example:443#`) would silently redirect signed vault requests
// to another host. An unrecognised region yields "" rather than a host we never meant to talk to.
export function endpointFor(settings: GeodeSettings): string {
  if (settings.provider === "r2") {
    return `https://${settings.accountId}.r2.cloudflarestorage.com`;
  }
  if (settings.provider === "s3") {
    if (!isAwsRegion(settings.region)) {
      return "";
    }
    return `https://s3.${settings.region}.amazonaws.com`;
  }

  return settings.endpoint;
}

// hasConnectionConfig reports whether settings have enough filled in to attempt a connection.
export function hasConnectionConfig(settings: GeodeSettings): boolean {
  if (settings.bucket === "" || settings.accessKeyId === "" || settings.secretId === "") {
    return false;
  }
  if (settings.provider === "r2") {
    return settings.accountId !== "";
  }
  if (settings.provider === "s3") {
    return isAwsRegion(settings.region);
  }
  return settings.endpoint !== "" && settings.region !== "";
}

// isAwsRegion reports whether region looks like an AWS region identifier ("us-east-1",
// "eu-west-2", "us-gov-west-1"). Only the restricted alphabet matters for safety: it admits no
// character that can terminate or redirect a URL authority.
export function isAwsRegion(region: string): boolean {
  return /^[a-z]{2}(-[a-z]+){1,2}-\d{1,2}$/.test(region);
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

// providerOr returns a known provider, defaulting unknown values to "r2".
export function providerOr(v: unknown): Provider {
  if (v === "s3" || v === "custom") {
    return v;
  }
  return "r2";
}

// providerOptions returns user-facing providers, including Custom only for local development.
export function providerOptions(
  localDev: boolean,
): Record<Provider, string> | Record<"r2" | "s3", string> {
  if (localDev) {
    return { r2: "Cloudflare R2", s3: "Amazon S3", custom: "Custom" };
  }

  return { r2: "Cloudflare R2", s3: "Amazon S3" };
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

// stringOr returns v if it is a string, otherwise fallback.
function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") {
    return v;
  }
  return fallback;
}

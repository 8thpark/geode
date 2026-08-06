// DEFAULT_SETTINGS is the complete zero value used before any user configuration is loaded.
export const DEFAULT_SETTINGS: GeodeSettings = {
  version: 1,
  provider: "r2",
  accountId: "",
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  accessKeyId: "",
  secretId: "",
};

// ConnectionStatus is the current in-memory state of a Test Connection check.
export type ConnectionStatus = "unknown" | "checking" | "ok" | "error";

// GeodeSettings is the persisted shape of a Geode plugin's user configuration.
export type GeodeSettings = {
  version: number;
  provider: "r2" | "custom";
  accountId: string;
  endpoint: string;
  region: string;
  bucket: string;
  // prefix is the folder inside the bucket the vault lives under, stored exactly as typed and
  // canonicalized at the point of use rather than on save.
  prefix: string;
  accessKeyId: string;
  // secretId is a SecretStorage reference name, not the secret value itself; Obsidian's picker
  // won't force a new entry onto a fixed ID, so we remember whichever name was picked.
  secretId: string;
};

// SaveTarget is the narrow persistence surface needed to save a settings draft.
export type SaveTarget = {
  logger: {
    info(message: string): void;
  };
  settings: GeodeSettings;
  saveSettings(): Promise<void>;
};

// canSave reports whether the current draft may be persisted.
export function canSave(dirty: boolean, connectionStatus: ConnectionStatus): boolean {
  if (!dirty) {
    return false;
  }

  return connectionStatus === "unknown" || connectionStatus === "ok";
}

// draftForDisplay returns the draft to show for a render: re-seeded from saved settings when auto
// (Obsidian opening the tab), kept as is otherwise.
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

// normalizeEndpoint ensures the endpoint has an explicit scheme and no trailing slash.
export function normalizeEndpoint(endpoint: string): string {
  let normalized = endpoint.trim();
  if (!normalized) {
    return "";
  }

  // Require an explicit scheme to prevent generic network errors
  const hasScheme =
    normalized.toLowerCase().startsWith("http://") ||
    normalized.toLowerCase().startsWith("https://");
  if (!hasScheme) {
    normalized = `https://${normalized}`;
  }

  // Strip trailing slashes to prevent double-slash SigV4 canonical path issues
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

// endpointFor returns the storage endpoint URL to use for the given settings.
export function endpointFor(settings: GeodeSettings): string {
  if (settings.provider === "r2") {
    return `https://${settings.accountId}.r2.cloudflarestorage.com`;
  }

  return normalizeEndpoint(settings.endpoint);
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

// isCurrentConnectionResult reports whether a completed test still describes the current draft.
export function isCurrentConnectionResult(
  checkId: number,
  currentCheckId: number,
  testedSettings: GeodeSettings,
  currentSettings: GeodeSettings,
): boolean {
  if (checkId !== currentCheckId) {
    return false;
  }

  return settingsEqual(testedSettings, currentSettings);
}

// normalizePrefix returns the canonical bucket key prefix: whitespace trimmed and empty segments
// dropped, so equivalent slash variants all address the same place.
export function normalizePrefix(raw: string): string {
  const segments: string[] = [];
  for (const segment of raw.trim().split("/")) {
    if (segment === "") {
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
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
    prefix: stringOr(source.prefix, DEFAULT_SETTINGS.prefix),
    accessKeyId: stringOr(source.accessKeyId, DEFAULT_SETTINGS.accessKeyId),
    secretId: stringOr(source.secretId, DEFAULT_SETTINGS.secretId),
  };
}

// prefixError returns why raw cannot be used as a bucket prefix, or "" when it can, so a typo is
// caught while typing rather than as a baffling provider error later.
export function prefixError(raw: string): string {
  const prefix = normalizePrefix(raw);
  if (prefix === "") {
    return "";
  }
  if (prefix.includes("\\")) {
    return "Prefix separates folders with /, not \\";
  }
  if (hasControlCharacter(prefix)) {
    return "Prefix can't contain control characters";
  }

  for (const segment of prefix.split("/")) {
    if (segment === "." || segment === "..") {
      return "Prefix can't use . or .. as a folder";
    }
  }

  return "";
}

// providerOr returns "custom" if v is "custom", otherwise "r2".
export function providerOr(v: unknown): "r2" | "custom" {
  if (v === "custom") {
    return "custom";
  }
  return "r2";
}

// regionFor returns the signing region for settings; R2 always signs with "auto", so only a custom
// provider needs one specified.
export function regionFor(settings: GeodeSettings): string {
  if (settings.provider === "r2") {
    return "auto";
  }

  return settings.region;
}

// saveDraft persists a copy of draft when the current connection state allows it.
export async function saveDraft(
  target: SaveTarget,
  draft: GeodeSettings,
  connectionStatus: ConnectionStatus,
): Promise<void> {
  if (!canSave(!settingsEqual(draft, target.settings), connectionStatus)) {
    return;
  }

  target.logger.info(`saving settings (provider=${draft.provider})`);
  target.settings = { ...draft };
  await target.saveSettings();
}

// settingsEqual reports whether two settings values are identical field for field, letting dirty
// state be derived by comparison rather than tracked as a flag that can't self-correct.
export function settingsEqual(a: GeodeSettings, b: GeodeSettings): boolean {
  return (
    a.provider === b.provider &&
    a.accountId === b.accountId &&
    a.endpoint === b.endpoint &&
    a.region === b.region &&
    a.bucket === b.bucket &&
    a.prefix === b.prefix &&
    a.accessKeyId === b.accessKeyId &&
    a.secretId === b.secretId
  );
}

// hasControlCharacter reports whether value holds any C0 or DEL character, none of which can be
// carried through a request URL as itself.
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

// stringOr returns v if it is a string, otherwise fallback.
function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") {
    return v;
  }
  return fallback;
}

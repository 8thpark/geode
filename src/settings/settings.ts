// DEFAULT_SETTINGS is the complete zero value used before any user configuration is loaded.
// deviceId is empty here and minted on first load rather than defaulted, since a real one needs
// randomness this module deliberately doesn't reach for.
export const DEFAULT_SETTINGS: GeodeSettings = {
  version: 1,
  provider: "r2",
  accountId: "",
  endpoint: "",
  region: "",
  bucket: "",
  accessKeyId: "",
  secretId: "",
  deviceId: "",
};

// DEVICE_SUFFIX_ALPHABET is Crockford's base32 alphabet, lowercased, and missing i, l, o and u so
// a suffix read off a filename can't be transcribed wrong. One case throughout, here and in the
// platform label, is what stops two generated device IDs differing only by case, which would be a
// path collision decodeSnapshot refuses outright (#94). Lowercase specifically because a conflict
// copy's whole added suffix is lowercase (see conflictCopyPath).
const DEVICE_SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

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
  accessKeyId: string;
  // secretId is a SecretStorage reference name, not the secret value itself. Obsidian's
  // SecretComponent picker lets a user pick or create a secret name of their choosing;
  // it does not support forcing new entries onto a fixed ID, so we have to remember whichever
  // one they picked.
  secretId: string;
  // deviceId names this device in conflict copy filenames and log lines (#103), so a three device
  // vault says which machine an edit came from rather than leaving it to be guessed from a
  // timestamp. Minted once on first load and never rewritten. It lives here, in data.json,
  // deliberately rather than in state.json: state.json resets on a settings fingerprint change and
  // on corruption, and unlike vaultId there is no remote copy to re-derive a device's identity
  // from, so a reset would silently rename every conflict copy this device writes from then on.
  deviceId: string;
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

// deviceIdFrom returns the identifier naming this device in conflict copies and logs: a platform
// label a human can recognise, and a random suffix that separates two devices of the same kind.
// Both halves are generated rather than typed, so the result is always safe as a path segment
// (#132) and can never collide with another device's only by case (#94), neither of which holds
// for a name a user could set.
export function deviceIdFrom(label: string, suffix: string): string {
  if (label === "") {
    return suffix;
  }
  if (suffix === "") {
    return label;
  }

  return `${label}-${suffix}`;
}

// deviceSuffixFrom encodes bytes as Crockford base32, five bits per character, for the random half
// of a device ID. Five bytes in gives exactly eight characters out with no padding or remainder.
export function deviceSuffixFrom(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += DEVICE_SUFFIX_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += DEVICE_SUFFIX_ALPHABET[(value << (5 - bits)) & 31];
  }

  return out;
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

// endpointFor returns the storage endpoint URL to use for the given settings.
export function endpointFor(settings: GeodeSettings): string {
  if (settings.provider === "r2") {
    return `https://${settings.accountId}.r2.cloudflarestorage.com`;
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
    // Left empty when absent rather than minted here: this is pure, and an upgrader's existing
    // data.json has no deviceId. The plugin mints one on load and persists it (see main.ts).
    deviceId: stringOr(source.deviceId, DEFAULT_SETTINGS.deviceId),
  };
}

// providerOr returns "custom" if v is "custom", otherwise "r2".
export function providerOr(v: unknown): "r2" | "custom" {
  if (v === "custom") {
    return "custom";
  }
  return "r2";
}

// regionFor returns the signing region to use for the given settings. R2 always signs with
// "auto" regardless of what a user might type, so custom is the only provider that needs one.
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

// settingsEqual reports whether two settings values match across every field a user can edit. Used
// to derive whether a draft has unsaved changes by comparing it to the last saved settings, rather
// than tracking a dirty flag that can't self-correct when an edit is reverted by hand. deviceId is
// excluded deliberately: nothing in the tab can change it, a draft always carries the saved one
// forward, and counting it would only ever be a comparison that cannot fail.
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

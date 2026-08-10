// DEVICE_ID_KEY holds this device's identity in vault scoped localStorage rather than in any file
// under .obsidian/, which people sync through iCloud, Dropbox or git.
export const DEVICE_ID_KEY = "geode-device-id";

// DEVICE_SUFFIX_ALPHABET is Crockford's base32, lowercased and missing i, l, o and u, so a suffix
// read off a filename cannot be transcribed wrong.
const DEVICE_SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

// deviceIdFrom returns the identifier naming this device: a recognisable platform label and a
// random suffix, both generated rather than typed so neither can be an unsafe path segment. See
// docs/technical_device.md.
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

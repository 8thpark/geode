// DEVICE_ID_KEY is where this device's identity is kept: Obsidian's vault scoped localStorage,
// deliberately not data.json or state.json (#103). Both of those live under
// .obsidian/plugins/geode/, and plenty of people sync .obsidian/ through iCloud, Dropbox, git or
// another plugin, which would hand one device's identity to every other device that reads the
// synced copy. Devices sharing an ID is worse than having none: conflict copies get attributed to
// the wrong machine, and two machines can then generate the identical conflict path for one note.
// localStorage never travels with the vault, so an identity stored here stays local by
// construction rather than by asking users not to sync a file.
//
// The cost is that clearing app data mints a fresh ID for that device. That is a cosmetic reset,
// conflict copies already written keep the name they were given, and it is the right trade against
// two devices silently answering to the same name.
export const DEVICE_ID_KEY = "geode-device-id";

// DEVICE_SUFFIX_ALPHABET is Crockford's base32 alphabet, lowercased, and missing i, l, o and u so
// a suffix read off a filename can't be transcribed wrong. One case throughout, here and in the
// platform label, is what stops two generated device IDs differing only by case, which would be a
// path collision decodeSnapshot refuses outright (#94). Lowercase specifically because a conflict
// copy's whole added suffix is lowercase (see conflictCopyPath).
const DEVICE_SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

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

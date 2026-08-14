// ENVELOPE_VERSION describes the header layout, not the payload, so it moves for a framing change
// where the suite byte moves for a payload change. See docs/technical_storage.md.
export const ENVELOPE_VERSION = 1;

// HEADER_BYTES is the fixed width of the header wrapObject writes: four magic bytes, one version
// byte, one suite byte. Fixed rather than length prefixed on purpose; the payload runs to the end
// of the object, and S3 already tells us where that is.
const HEADER_BYTES = 6;

// MAGIC is the four byte tag every geode object starts with, so a foreign body is recognised as
// one rather than surfacing as a confusing failure three layers up.
const MAGIC = [0x47, 0x45, 0x4f, 0x44];

// SUITE_PLAINTEXT is the suite byte for a payload stored exactly as handed over, and the only one
// this build writes or reads.
const SUITE_PLAINTEXT = 0x00;

// DecodedObject is the payload inside an envelope, or why this build cannot read it: "corrupt"
// for bytes that are no geode object at all, unsupported for ones a newer build would understand.
export type DecodedObject =
  | { ok: true; payload: Uint8Array }
  | { ok: false; reason: "corrupt" | "unsupportedSuite" | "unsupportedVersion" };

// unwrapObject returns the payload inside an object's envelope, never falling back to reading a
// headerless body as a bare payload. The payload is a view over the caller's bytes, not a copy,
// since copying every blob to strip six bytes would double the peak memory of every pull.
export function unwrapObject(body: Uint8Array): DecodedObject {
  if (body.length < HEADER_BYTES) {
    return { ok: false, reason: "corrupt" };
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (body[i] !== MAGIC[i]) {
      return { ok: false, reason: "corrupt" };
    }
  }
  if (body[MAGIC.length] !== ENVELOPE_VERSION) {
    return { ok: false, reason: "unsupportedVersion" };
  }
  if (body[MAGIC.length + 1] !== SUITE_PLAINTEXT) {
    return { ok: false, reason: "unsupportedSuite" };
  }

  return { ok: true, payload: body.subarray(HEADER_BYTES) };
}

// wrapObject returns the envelope header followed by payload. Every object geode owns goes
// through here, so the bucket is uniformly self describing.
export function wrapObject(payload: Uint8Array): Uint8Array {
  const body = new Uint8Array(HEADER_BYTES + payload.length);
  body.set(MAGIC, 0);
  body[MAGIC.length] = ENVELOPE_VERSION;
  body[MAGIC.length + 1] = SUITE_PLAINTEXT;
  body.set(payload, HEADER_BYTES);

  return body;
}

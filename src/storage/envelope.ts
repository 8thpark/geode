// ENVELOPE_VERSION is the version stamped into the header of every object geode writes to the
// bucket, and the only version this build will read back (#184). It describes the header layout
// itself, not what the payload is: a new field, a different header size, or a different way of
// framing the payload moves this number, while a new way of protecting the payload moves the suite
// byte instead. The two change for different reasons and at different times, so they are separate
// bytes rather than one number that has to mean both.
//
// It is deliberately not SNAPSHOT_VERSION. That version describes the shape of the JSON inside the
// manifest, which is a different question from how the bytes around it are framed: a manifest that
// gains a field must not invalidate every blob in the bucket, and a change to the framing must not
// pretend the manifest's shape moved. The posture is the same though, and that is what #184 asked
// to reuse: a version this build does not know is refused as "needs a different build of geode",
// never read as far as possible, never silently repaired.
export const ENVELOPE_VERSION = 1;

// HEADER_BYTES is the fixed width of the header wrapObject writes: four magic bytes, one version
// byte, one suite byte. Fixed rather than length prefixed on purpose; the payload runs to the end
// of the object, and S3 already tells us where that is.
const HEADER_BYTES = 6;

// MAGIC is the four byte tag ("GEOD") every geode object starts with, so a body that is not one is
// recognised as foreign rather than parsed as whatever the caller was hoping for. It costs four
// bytes per object and buys the difference between "this bucket holds something we did not write"
// and a confusing failure three layers up.
const MAGIC = [0x47, 0x45, 0x4f, 0x44];

// SUITE_PLAINTEXT is the suite byte for a payload stored exactly as it was handed over: no
// encryption, no compression, no framing of its own. It is the only suite this build writes or
// reads, and reserving the byte now is the whole point of the envelope. Encryption arrives at
// 0.3.0 as a second suite value, met by objects that already say which one they are, rather than
// as a discriminator bolted onto a format that never had room for one; see docs/object-format.md.
const SUITE_PLAINTEXT = 0x00;

// DecodedObject is the result of opening an object's envelope: the payload inside it, or why this
// build cannot read it. "corrupt" means the bytes are not a geode object at all (truncated, or
// never had a header); the two unsupported reasons mean they are, and a newer build would know
// what to do with them.
export type DecodedObject =
  | { ok: true; payload: Uint8Array }
  | { ok: false; reason: "corrupt" | "unsupportedSuite" | "unsupportedVersion" };

// unwrapObject reads the envelope off a bucket object and returns the payload inside it. Every
// object geode writes carries one, so a body without a valid header is never unwrapped "leniently"
// as a bare payload: doing so would make an unversioned object indistinguishable from a version 1
// one the moment a version 2 exists, which is exactly the ambiguity the header removes.
//
// The payload is a view over the caller's bytes rather than a copy. A blob can be a whole
// attachment, and copying every one of them to strip six bytes would double the peak memory of
// every pull for nothing; the body is read once and dropped, so nothing later mutates what the
// view sees.
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

// wrapObject returns the bytes to store for payload: the envelope header followed by the payload
// itself. Every object geode owns goes through here, blobs and the manifest and the sentinel
// alike, so the bucket is uniformly self describing and a reader never has to know which kind of
// object it is holding before it can tell whether it can read it at all.
export function wrapObject(payload: Uint8Array): Uint8Array {
  const body = new Uint8Array(HEADER_BYTES + payload.length);
  body.set(MAGIC, 0);
  body[MAGIC.length] = ENVELOPE_VERSION;
  body[MAGIC.length + 1] = SUITE_PLAINTEXT;
  body.set(payload, HEADER_BYTES);

  return body;
}

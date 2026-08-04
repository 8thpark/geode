import assert from "node:assert/strict";
import { test } from "node:test";
import { type DecodedObject, ENVELOPE_VERSION, unwrapObject, wrapObject } from "./envelope.ts";

// bodyOf builds a raw bucket body from a header and a payload, for the cases a well formed
// wrapObject call cannot produce: a foreign object, a version this build doesn't write, a suite it
// doesn't know.
function bodyOf(header: number[], payload: string): Uint8Array {
  const bytes = new TextEncoder().encode(payload);
  const body = new Uint8Array(header.length + bytes.length);
  body.set(header, 0);
  body.set(bytes, header.length);

  return body;
}

test("wrapObject: the header is the magic, the version, and the suite, then the payload", () => {
  const body = wrapObject(new TextEncoder().encode("hello"));

  assert.deepEqual([...body.slice(0, 4)], [0x47, 0x45, 0x4f, 0x44]);
  assert.equal(body[4], ENVELOPE_VERSION);
  assert.equal(body[5], 0x00);
  assert.equal(new TextDecoder().decode(body.slice(6)), "hello");
});

test("wrapObject: round-trips through unwrapObject, payload byte for byte", () => {
  const cases: string[] = ["", "hello", '{"version":3,"files":[]}', "café 😀", "a".repeat(10_000)];

  for (const payload of cases) {
    const bytes = new TextEncoder().encode(payload);

    const opened = unwrapObject(wrapObject(bytes));

    assert.ok(opened.ok, payload.slice(0, 20));
    assert.deepEqual(opened.ok && [...opened.payload], [...bytes], payload.slice(0, 20));
  }
});

test("unwrapObject: an unknown version or suite needs a newer build, anything else is corrupt", () => {
  const cases: { name: string; body: Uint8Array; want: DecodedObject }[] = [
    {
      // The bytes a build before the envelope existed would have written, and the bytes any other
      // tool would: read leniently as a bare payload, they would be indistinguishable from a
      // version 1 object the moment a version 2 exists.
      name: "a payload with no envelope at all",
      body: new TextEncoder().encode("just some bytes"),
      want: { ok: false, reason: "corrupt" },
    },
    {
      name: "a body too short to hold a header",
      body: bodyOf([0x47, 0x45, 0x4f], ""),
      want: { ok: false, reason: "corrupt" },
    },
    {
      name: "a body whose magic doesn't match",
      body: bodyOf([0x47, 0x45, 0x4f, 0x45, 0x01, 0x00], "hello"),
      want: { ok: false, reason: "corrupt" },
    },
    {
      // A newer geode wrote this bucket. The fix is updating the plugin, never starting over, so
      // the reason must be distinguishable from damage.
      name: "an envelope version from a newer build",
      body: bodyOf([0x47, 0x45, 0x4f, 0x44, 0x02, 0x00], "hello"),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      // The reservation this whole envelope exists for (#184): the vault is encrypted and this
      // build has no idea how to read it, which it must say rather than hand ciphertext on as
      // though it were content.
      name: "a suite this build does not know",
      body: bodyOf([0x47, 0x45, 0x4f, 0x44, 0x01, 0x01], "ciphertext"),
      want: { ok: false, reason: "unsupportedSuite" },
    },
    {
      name: "an empty body",
      body: new Uint8Array(0),
      want: { ok: false, reason: "corrupt" },
    },
    {
      name: "a header with nothing after it",
      body: bodyOf([0x47, 0x45, 0x4f, 0x44, 0x01, 0x00], ""),
      want: { ok: true, payload: new Uint8Array(0) },
    },
  ];

  for (const { name, body, want } of cases) {
    assert.deepEqual(unwrapObject(body), want, name);
  }
});

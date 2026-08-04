import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictCopyPath } from "../sync/plan.ts";
import { isSafePath } from "../vault/vault.ts";
import { DEVICE_ID_KEY, deviceIdFrom, deviceSuffixFrom } from "./device.ts";

test("deviceSuffixFrom: five bytes encode to eight base32 characters (#103)", () => {
  // 40 bits split into eight 5-bit groups holding 0 through 7 in order, so the expected output
  // reads straight off the front of the alphabet.
  const suffix = deviceSuffixFrom(new Uint8Array([0x00, 0x44, 0x32, 0x14, 0xc7]));

  assert.equal(suffix, "01234567");
});

test("deviceSuffixFrom: the alphabet is lowercase and skips the ambiguous letters (#103)", () => {
  // One case throughout is what makes two device IDs unable to collide by case alone, which
  // decodeSnapshot refuses outright (#94); lowercase specifically because the whole suffix a
  // conflict copy carries is lowercase. i, l, o and u are absent so a suffix read off a filename
  // can't be transcribed back wrong.
  const every = deviceSuffixFrom(new Uint8Array([255, 255, 255, 255, 255]));

  assert.equal(every, "zzzzzzzz");
  for (const byte of [0, 64, 128, 192, 255]) {
    const suffix = deviceSuffixFrom(new Uint8Array([byte, byte, byte, byte, byte]));

    assert.match(suffix, /^[0-9a-hjkmnp-tv-z]{8}$/, `byte ${byte}`);
    assert.equal(suffix, suffix.toLowerCase(), `byte ${byte}`);
  }
});

test("deviceSuffixFrom: distinct randomness gives distinct suffixes", () => {
  // The suffix is the only thing separating two devices carrying the same platform label, so two
  // different draws must not land on the same eight characters.
  const a = deviceSuffixFrom(new Uint8Array([1, 2, 3, 4, 5]));
  const b = deviceSuffixFrom(new Uint8Array([1, 2, 3, 4, 6]));

  assert.notEqual(a, b);
});

test("deviceIdFrom: a label and suffix join with a hyphen", () => {
  assert.equal(deviceIdFrom("mac", "k3pl7qna"), "mac-k3pl7qna");
});

test("deviceIdFrom: an empty half degrades to the other rather than leaving a stray hyphen", () => {
  assert.equal(deviceIdFrom("", "k3pl7qna"), "k3pl7qna");
  assert.equal(deviceIdFrom("mac", ""), "mac");
});

test("deviceIdFrom: every generated ID is safe in a conflict copy path (#103)", () => {
  // The ID lands in a filename written to disk, so it has to clear the same rules a pulled
  // manifest entry does (#132) and must never introduce uppercase that could let two devices
  // collide by case alone (#94).
  const labels = ["mac", "ios", "android", "windows", "linux", "device"];
  const suffixes = ["01234567", "zzzzzzzz", "k3pl7qna", "00000000"];

  for (const label of labels) {
    for (const suffix of suffixes) {
      const deviceId = deviceIdFrom(label, suffix);
      const copy = conflictCopyPath(
        "notes/todo.md",
        Date.parse("2026-07-14T14:37:22.123Z"),
        deviceId,
      );

      assert.equal(deviceId, deviceId.toLowerCase(), deviceId);
      assert.equal(isSafePath(copy), true, copy);
      assert.equal(copy.includes(" "), false, copy);
    }
  }
});

test("DEVICE_ID_KEY: is a stable, namespaced localStorage key", () => {
  // Vault scoped localStorage is shared with Obsidian and every other plugin, so the key has to
  // stay namespaced, and it has to stay stable: changing it silently remints every device's
  // identity and renames every conflict copy written from then on.
  assert.equal(DEVICE_ID_KEY, "geode-device-id");
});

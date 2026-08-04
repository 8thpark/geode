import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafePath, SNAPSHOT_VERSION } from "../vault/vault.ts";
import { empty, file, snapshot } from "./fake.ts";
import {
  blobKeyFor,
  conflictCopyPath,
  type DecodedSentinel,
  decodeSentinel,
  encodeSentinel,
  MANIFEST_KEY,
  manifestAfterSync,
  planSync,
  RESERVED_PREFIX,
  resolveVaultIdentity,
  type Sentinel,
} from "./plan.ts";

test("planSync: a path only changed locally is pushed", () => {
  const previous = empty;
  const local = snapshot(file("a.md", "h1"));
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "push", path: "a.md" }]);
});

test("planSync: a local deletion pushes the delete", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = empty;
  const remote = snapshot(file("a.md", "h1"));

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "pushDelete", path: "a.md" }]);
});

test("planSync: a path only changed remotely is pulled", () => {
  const previous = empty;
  const local = empty;
  const remote = snapshot(file("a.md", "h1"));

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "pull", path: "a.md" }]);
});

test("planSync: a remote deletion pulls the delete", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h1"));
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), [{ kind: "pullDelete", path: "a.md" }]);
});

test("planSync: both sides changed to identical content needs no action", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h2"));
  const remote = snapshot(file("a.md", "h2"));

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("planSync: both sides changed to different content is a conflict", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h2"));
  const remote = snapshot(file("a.md", "h3"));

  assert.deepEqual(planSync(previous, local, remote), [
    { kind: "conflict", path: "a.md", deletedSide: "none" },
  ]);
});

test("planSync: deleted locally but modified remotely is a conflict with nothing local to preserve", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = empty;
  const remote = snapshot(file("a.md", "h2"));

  assert.deepEqual(planSync(previous, local, remote), [
    { kind: "conflict", path: "a.md", deletedSide: "local" },
  ]);
});

test("planSync: modified locally but deleted remotely is a conflict with nothing remote to pull", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = snapshot(file("a.md", "h2"));
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), [
    { kind: "conflict", path: "a.md", deletedSide: "remote" },
  ]);
});

test("planSync: deleted independently on both sides needs no reconciliation", () => {
  const previous = snapshot(file("a.md", "h1"));
  const local = empty;
  const remote = empty;

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("planSync: the manifest's own path is never turned into an action", () => {
  const previous = empty;
  const local = snapshot(file(MANIFEST_KEY, "h1"));
  const remote = snapshot(file(MANIFEST_KEY, "h2"));

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("planSync: a blob key under the reserved prefix is never turned into an action", () => {
  const previous = empty;
  const local = snapshot(file(blobKeyFor("h1"), "h1"));
  const remote = snapshot(file(blobKeyFor("h2"), "h2"));

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("blobKeyFor: keys content under the reserved blob prefix by its own hash", () => {
  assert.equal(blobKeyFor("deadbeef"), ".geode/blobs/deadbeef");
});

test("planSync: any key under the reserved prefix is excluded (#101)", () => {
  // isReservedPath matches on the whole prefix, not just the manifest and blob keys this build
  // happens to know about today, so a bookkeeping object it has never heard of (a future lock
  // file, say) is excluded the same way, rather than needing its own carve out the day it's
  // introduced.
  const previous = empty;
  const local = snapshot(file(`${RESERVED_PREFIX}locks/device-1`, "h1"));
  const remote = snapshot(file(`${RESERVED_PREFIX}locks/device-1`, "h2"));

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("manifestAfterSync: a push records the pushed file's entry", () => {
  const remote = snapshot(file("a.md", "h1"), file("b.md", "h3"));
  const pushed = [file("a.md", "h2")];

  const result = manifestAfterSync(remote, [{ kind: "push", path: "a.md" }], pushed);

  assert.deepEqual(result, snapshot(file("a.md", "h2"), file("b.md", "h3")));
});

test("manifestAfterSync: a push whose bytes drifted past the snapshot still records what was actually uploaded", () => {
  // The snapshot saw h1, but the file changed again before the push read it, so h2 is what
  // actually reached the bucket. The manifest must never fall back to the stale snapshot hash
  // here, or every other device's verifyFetch rejects h2's real bytes until this device syncs
  // again, indefinitely if it never does.
  const remote = snapshot(file("a.md", "h1"));
  const pushed = [file("a.md", "h2")];

  const result = manifestAfterSync(remote, [{ kind: "push", path: "a.md" }], pushed);

  assert.deepEqual(result, snapshot(file("a.md", "h2")));
});

test("manifestAfterSync: a pushDelete removes the entry", () => {
  const remote = snapshot(file("a.md", "h1"), file("b.md", "h3"));

  const result = manifestAfterSync(remote, [{ kind: "pushDelete", path: "a.md" }], []);

  assert.deepEqual(result, snapshot(file("b.md", "h3")));
});

test("manifestAfterSync: a failed pushDelete leaves the entry standing", () => {
  // A pushDelete that never completed (the trash copy or the delete itself failed) must not be
  // taken as evidence the object is gone: it may still be sitting there untouched.
  const remote = snapshot(file("a.md", "h1"));

  const result = manifestAfterSync(remote, [], []);

  assert.deepEqual(result, remote);
});

test("manifestAfterSync: pull and pullDelete leave the bucket, and so the manifest, untouched", () => {
  const remote = snapshot(file("a.md", "h1"));

  const result = manifestAfterSync(
    remote,
    [
      { kind: "pull", path: "a.md" },
      { kind: "pullDelete", path: "b.md" },
    ],
    [],
  );

  assert.deepEqual(result, remote);
});

test("manifestAfterSync: a content conflict keeps the remote entry and adds the pushed copy", () => {
  const now = Date.parse("2026-07-14T10:00:00.000Z");
  const remote = snapshot(file("a.md", "h3"));
  const copyPath = conflictCopyPath("a.md", now);
  const pushed = [{ ...file("a.md", "h2"), path: copyPath }];

  const result = manifestAfterSync(
    remote,
    [{ kind: "conflict", path: "a.md", deletedSide: "none" }],
    pushed,
  );

  assert.deepEqual(result, snapshot(file("a.md", "h3"), { ...file("a.md", "h2"), path: copyPath }));
});

test("manifestAfterSync: a conflict's pushed copy is recorded even when the action itself is absent from completed", () => {
  // Reproduces the gap from #177: a conflict's copy push can succeed while the rest of the action
  // (the pull, its integrity check, or the local write) later fails, so the action never appears
  // in completed. The copy still landed in the bucket, and pushed must be enough on its own to
  // land it in the manifest, or the object sits there forever, invisible to every other device.
  const now = Date.parse("2026-07-14T10:00:00.000Z");
  const remote = snapshot(file("a.md", "h1"));
  const copyPath = conflictCopyPath("a.md", now);
  const pushed = [{ ...file("a.md", "h2"), path: copyPath }];

  const result = manifestAfterSync(remote, [], pushed);

  assert.deepEqual(result, snapshot(file("a.md", "h1"), { ...file("a.md", "h2"), path: copyPath }));
});

test("manifestAfterSync: a remote deletion conflict records only the pushed copy", () => {
  const now = Date.parse("2026-07-14T10:00:00.000Z");
  const copyPath = conflictCopyPath("a.md", now);
  const pushed = [{ ...file("a.md", "h2"), path: copyPath }];

  const result = manifestAfterSync(
    empty,
    [{ kind: "conflict", path: "a.md", deletedSide: "remote" }],
    pushed,
  );

  assert.deepEqual(result, snapshot({ ...file("a.md", "h2"), path: copyPath }));
});

test("manifestAfterSync: a local deletion conflict pushes nothing, the remote entry stands", () => {
  const remote = snapshot(file("a.md", "h2"));

  const result = manifestAfterSync(
    remote,
    [{ kind: "conflict", path: "a.md", deletedSide: "local" }],
    [],
  );

  assert.deepEqual(result, remote);
});

test("conflictCopyPath: keeps the extension", () => {
  assert.equal(
    conflictCopyPath("notes/todo.md", Date.parse("2026-07-14T14:37:22.123Z")),
    "notes/todo_conflict_20260714-143722-123.md",
  );
});

test("conflictCopyPath: a file with no extension", () => {
  assert.equal(
    conflictCopyPath("notes/todo", Date.parse("2026-07-14T14:37:22.123Z")),
    "notes/todo_conflict_20260714-143722-123",
  );
});

test("conflictCopyPath: a dot in a folder name isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath("my.notes/todo", Date.parse("2026-07-14T14:37:22.123Z")),
    "my.notes/todo_conflict_20260714-143722-123",
  );
});

test("conflictCopyPath: a leading dot in the filename isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath("notes/.gitignore", Date.parse("2026-07-14T14:37:22.123Z")),
    "notes/.gitignore_conflict_20260714-143722-123",
  );
});

test("conflictCopyPath: a dotfile at the vault root isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath(".editorconfig", Date.parse("2026-07-14T14:37:22.123Z")),
    ".editorconfig_conflict_20260714-143722-123",
  );
});

test("conflictCopyPath: the device sits before the timestamp, extension kept (#103)", () => {
  assert.equal(
    conflictCopyPath("notes/todo.md", Date.parse("2026-07-14T14:37:22.123Z"), "mac-k3pl7qna"),
    "notes/todo_conflict_mac-k3pl7qna_20260714-143722-123.md",
  );
});

test("conflictCopyPath: the device also lands on a name with no extension (#103)", () => {
  assert.equal(
    conflictCopyPath("notes/todo", Date.parse("2026-07-14T14:37:22.123Z"), "ios-bbbbbbbb"),
    "notes/todo_conflict_ios-bbbbbbbb_20260714-143722-123",
  );
});

test("conflictCopyPath: an empty device is omitted, never left as a stray delimiter (#103)", () => {
  // A pass can run before a device ID has been minted; the name it produces must still be clean.
  assert.equal(
    conflictCopyPath("notes/todo.md", Date.parse("2026-07-14T14:37:22.123Z"), ""),
    "notes/todo_conflict_20260714-143722-123.md",
  );
});

test("conflictCopyPath: the name carries no spaces and no uppercase it added itself (#103)", () => {
  // The whole added suffix is lowercase and space free by construction: lowercase is what stops
  // two devices colliding by case alone (#94), and no spaces is what keeps the name quotable in a
  // shell and clean in a URL. Only the note's own name may contribute uppercase.
  const copy = conflictCopyPath("notes/Todo.md", Date.parse("2026-07-14T14:37:22.123Z"), "mac-abc");

  assert.equal(copy, "notes/Todo_conflict_mac-abc_20260714-143722-123.md");
  assert.equal(copy.includes(" "), false);
  assert.equal(copy.slice("notes/Todo".length), "_conflict_mac-abc_20260714-143722-123.md");
});

test("conflictCopyPath: two passes in the same second get different copies (#103)", () => {
  // A plan carries at most one action per path, so two conflicts for one path can only come from
  // two passes; nothing stops a failed pass being retried immediately, and automatic sync makes
  // back to back passes ordinary. At second precision both would name the same copy and the second
  // rename would overwrite or strand the edit the first preserved. Milliseconds are what stop the
  // one function whose job is preserving edits from silently destroying one.
  const first = conflictCopyPath("a.md", Date.parse("2026-07-14T14:37:22.123Z"), "mac-abc");
  const second = conflictCopyPath("a.md", Date.parse("2026-07-14T14:37:22.456Z"), "mac-abc");

  assert.equal(first, "a_conflict_mac-abc_20260714-143722-123.md");
  assert.equal(second, "a_conflict_mac-abc_20260714-143722-456.md");
  assert.notEqual(first, second);
});

test("conflictCopyPath: two devices never name the same copy at the same instant (#103)", () => {
  const mine = conflictCopyPath("a.md", Date.parse("2026-07-14T14:37:22.123Z"), "mac-abc");
  const theirs = conflictCopyPath("a.md", Date.parse("2026-07-14T14:37:22.123Z"), "ios-xyz");

  assert.notEqual(mine, theirs);
});

test("conflictCopyPath: the suffix parses back from the right (#103)", () => {
  // Underscore separates fields and hyphen lives inside them, so a note whose own name contains
  // underscores still leaves exactly three fields on the end to recover device and time from.
  const copy = conflictCopyPath(
    "my_notes/my_todo.md",
    Date.parse("2026-07-14T14:37:22.123Z"),
    "mac-abc",
  );

  assert.equal(copy, "my_notes/my_todo_conflict_mac-abc_20260714-143722-123.md");
  const fields = copy.slice(0, copy.lastIndexOf(".")).split("_");
  assert.deepEqual(fields.slice(-3), ["conflict", "mac-abc", "20260714-143722-123"]);
});

test("conflictCopyPath: a generated device ID survives the path safety rules (#103)", () => {
  // The copy is written to disk, so its name has to clear the same checks a pulled manifest entry
  // does (#132) and must not be able to collide with another device's only by case (#94).
  const generated = ["mac-k3pl7qna", "ios-bbbbbbbb", "windows-0123456z", "device-zzzzzzzz"];

  for (const deviceId of generated) {
    const copy = conflictCopyPath(
      "notes/todo.md",
      Date.parse("2026-07-14T10:00:00.000Z"),
      deviceId,
    );

    assert.equal(isSafePath(copy), true, deviceId);
  }
});

test("encodeSentinel: the wire format carries the version marker and round-trips", () => {
  const sentinel: Sentinel = { vaultId: "abc-123", createdAt: 1000 };

  const raw = encodeSentinel(sentinel);

  assert.equal((JSON.parse(raw) as { version: number }).version, SNAPSHOT_VERSION);
  assert.deepEqual(decodeSentinel(raw), { ok: true, sentinel });
});

test("decodeSentinel: version, shape, and field type are all validated", () => {
  const cases: { name: string; raw: string; want: DecodedSentinel }[] = [
    {
      name: "a well formed sentinel",
      raw: JSON.stringify({ version: 3, vaultId: "abc-123", createdAt: 1000 }),
      want: { ok: true, sentinel: { vaultId: "abc-123", createdAt: 1000 } },
    },
    { name: "bytes that aren't JSON", raw: "not json", want: { ok: false, reason: "corrupt" } },
    {
      name: "no version field",
      raw: JSON.stringify({ vaultId: "abc-123", createdAt: 1000 }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      name: "a version from a newer build",
      raw: JSON.stringify({ version: 4, vaultId: "abc-123", createdAt: 1000 }),
      want: { ok: false, reason: "unsupportedVersion" },
    },
    {
      name: "an empty vaultId",
      raw: JSON.stringify({ version: 3, vaultId: "", createdAt: 1000 }),
      want: { ok: false, reason: "corrupt" },
    },
    {
      name: "a vaultId that isn't a string",
      raw: JSON.stringify({ version: 3, vaultId: 42, createdAt: 1000 }),
      want: { ok: false, reason: "corrupt" },
    },
    {
      name: "a createdAt that isn't a number",
      raw: JSON.stringify({ version: 3, vaultId: "abc-123", createdAt: "yesterday" }),
      want: { ok: false, reason: "corrupt" },
    },
  ];

  for (const { name, raw, want } of cases) {
    assert.deepEqual(decodeSentinel(raw), want, name);
  }
});

test("resolveVaultIdentity: a genuinely new bucket mints a fresh vaultId", () => {
  const result = resolveVaultIdentity(true, null, undefined, () => "minted-id");

  assert.deepEqual(result, { ok: true, vaultId: "minted-id" });
});

test("resolveVaultIdentity: a wiped looking bucket refuses a device with history (#183)", () => {
  const result = resolveVaultIdentity(true, null, "known-id", () => "minted-id");

  assert.equal(result.ok, false);
});

test("resolveVaultIdentity: a manifest without a sentinel self heals (#183)", () => {
  const mintedForAnUpgrader = resolveVaultIdentity(false, null, undefined, () => "minted-id");
  const adoptedForARetry = resolveVaultIdentity(false, null, "known-id", () => "minted-id");

  assert.deepEqual(mintedForAnUpgrader, { ok: true, vaultId: "minted-id" });
  assert.deepEqual(adoptedForARetry, { ok: true, vaultId: "known-id" });
});

test("resolveVaultIdentity: once a sentinel exists, a vaultId mismatch refuses (#109)", () => {
  // A sentinel without a manifest is the #109 scenario (its manifest deleted, blobs surviving), and
  // refusing it whenever the manifest is briefly missing, even for a device with no history to
  // protect or one whose history genuinely agrees, would silently reinstate the exact permanent
  // deadlock #109 fixed. So whether firstSync is true or false must never change the answer here,
  // only whether localVaultId, if this device has one, actually disagrees with the sentinel's.
  const sentinel: Sentinel = { vaultId: "known-id", createdAt: 1000 };

  for (const firstSync of [true, false]) {
    const freshDevice = resolveVaultIdentity(firstSync, sentinel, undefined, () => "minted-id");
    const agreeingHistory = resolveVaultIdentity(
      firstSync,
      sentinel,
      "known-id",
      () => "minted-id",
    );
    const disagreeingHistory = resolveVaultIdentity(firstSync, sentinel, "other-id", () => "id");

    assert.deepEqual(freshDevice, { ok: true, vaultId: "known-id" }, `firstSync=${firstSync}`);
    assert.deepEqual(agreeingHistory, { ok: true, vaultId: "known-id" }, `firstSync=${firstSync}`);
    assert.equal(disagreeingHistory.ok, false, `firstSync=${firstSync}`);
  }
});

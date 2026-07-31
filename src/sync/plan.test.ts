import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, file, snapshot } from "./fake.ts";
import {
  conflictCopyPath,
  MANIFEST_KEY,
  manifestAfterSync,
  planSync,
  trashKeyFor,
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

test("planSync: a trashed copy under the reserved prefix is never turned into an action", () => {
  const previous = empty;
  const local = snapshot(file(".geode/trash/2020-01-01/a.md", "h1"));
  const remote = snapshot(file(".geode/trash/2020-01-01/b.md", "h2"));

  assert.deepEqual(planSync(previous, local, remote), []);
});

test("trashKeyFor: parks the path under the reserved trash prefix behind a timestamp folder", () => {
  assert.equal(
    trashKeyFor("notes/a.md", Date.UTC(2026, 0, 2, 3, 4, 5)),
    ".geode/trash/2026-01-02T03-04-05-000Z/notes/a.md",
  );
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
    conflictCopyPath("notes/todo.md", Date.parse("2026-07-14T10:00:00.000Z")),
    "notes/todo (conflicted copy 2026-07-14T10-00-00-000Z).md",
  );
});

test("conflictCopyPath: a file with no extension", () => {
  assert.equal(
    conflictCopyPath("notes/todo", Date.parse("2026-07-14T10:00:00.000Z")),
    "notes/todo (conflicted copy 2026-07-14T10-00-00-000Z)",
  );
});

test("conflictCopyPath: a dot in a folder name isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath("my.notes/todo", Date.parse("2026-07-14T10:00:00.000Z")),
    "my.notes/todo (conflicted copy 2026-07-14T10-00-00-000Z)",
  );
});

test("conflictCopyPath: a leading dot in the filename isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath("notes/.gitignore", Date.parse("2026-07-14T10:00:00.000Z")),
    "notes/.gitignore (conflicted copy 2026-07-14T10-00-00-000Z)",
  );
});

test("conflictCopyPath: a dotfile at the vault root isn't mistaken for an extension", () => {
  assert.equal(
    conflictCopyPath(".editorconfig", Date.parse("2026-07-14T10:00:00.000Z")),
    ".editorconfig (conflicted copy 2026-07-14T10-00-00-000Z)",
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, file, snapshot } from "./fake.ts";
import { conflictCopyPath, MANIFEST_KEY, planSync } from "./plan.ts";

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

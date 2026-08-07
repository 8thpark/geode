import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, file, snapshot } from "./fake.ts";
import {
  DESTRUCTIVE_CEILING,
  DESTRUCTIVE_FLOOR,
  destructiveLabel,
  type MassChange,
  massChangeApproved,
  massChangeCopy,
  massChangeFor,
  massChangeHalts,
  massChangeThreshold,
} from "./guard.ts";
import type { SyncAction } from "./plan.ts";

// change builds a MassChange from counts alone, for the cases that never look at paths beyond
// how many there are.
function change(counts: Partial<MassChange>): MassChange {
  const built: MassChange = {
    localDeletes: 0,
    localOverwrites: 0,
    paths: [],
    remoteDeletes: 0,
    tracked: 0,
    ...counts,
  };
  const total = built.localDeletes + built.localOverwrites + built.remoteDeletes;
  if (built.paths.length === 0) {
    for (let i = 0; i < total; i++) {
      built.paths.push({ kind: "localDelete", path: `note-${i}.md` });
    }
  }

  return built;
}

// deletes builds count pullDelete actions, the plan a wiped remote produces.
function deletes(count: number): SyncAction[] {
  const actions: SyncAction[] = [];
  for (let i = 0; i < count; i++) {
    actions.push({ kind: "pullDelete", path: `note-${i}.md` });
  }

  return actions;
}

test("massChangeFor: a local delete, a local overwrite, and a remote delete all count", () => {
  const local = snapshot(file("here.md", "h1"));
  const actions: SyncAction[] = [
    { kind: "pullDelete", path: "gone.md" },
    { kind: "pull", path: "here.md" },
    { kind: "pushDelete", path: "remote.md" },
  ];

  assert.deepEqual(massChangeFor(actions, local, 3), {
    localDeletes: 1,
    localOverwrites: 1,
    paths: [
      { kind: "localDelete", path: "gone.md" },
      { kind: "localOverwrite", path: "here.md" },
      { kind: "remoteDelete", path: "remote.md" },
    ],
    remoteDeletes: 1,
    tracked: 3,
  });
});

test("massChangeFor: a pull onto a path with no local file is an addition, not an overwrite", () => {
  const actions: SyncAction[] = [{ kind: "pull", path: "new.md" }];

  assert.deepEqual(massChangeFor(actions, empty, 0).paths, []);
});

test("massChangeFor: pushes and conflict copies destroy nothing", () => {
  const local = snapshot(file("a.md", "h1"), file("b.md", "h2"));
  const actions: SyncAction[] = [
    { kind: "push", path: "a.md" },
    { kind: "conflict", path: "b.md", deletedSide: "none" },
    { kind: "conflict", path: "c.md", deletedSide: "local" },
    { kind: "conflict", path: "d.md", deletedSide: "remote" },
  ];

  assert.deepEqual(massChangeFor(actions, local, 2).paths, []);
});

test("massChangeThreshold: a share of the vault between the floor and the ceiling", () => {
  const cases: { tracked: number; want: number }[] = [
    { tracked: 0, want: DESTRUCTIVE_FLOOR },
    { tracked: 10, want: DESTRUCTIVE_FLOOR },
    { tracked: 49, want: DESTRUCTIVE_FLOOR },
    { tracked: 50, want: DESTRUCTIVE_FLOOR },
    { tracked: 100, want: 20 },
    { tracked: 250, want: DESTRUCTIVE_CEILING },
    { tracked: 1_000, want: DESTRUCTIVE_CEILING },
    { tracked: 100_000, want: DESTRUCTIVE_CEILING },
  ];

  for (const c of cases) {
    assert.equal(massChangeThreshold(c.tracked), c.want, `tracked ${c.tracked}`);
  }
});

test("massChangeHalts: the share decides in a vault small enough for it to bite first", () => {
  assert.equal(massChangeHalts(change({ localDeletes: 20, tracked: 100 })), false);
  assert.equal(massChangeHalts(change({ localDeletes: 21, tracked: 100 })), true);
});

test("massChangeHalts: the ceiling decides once a share of the vault is the larger number", () => {
  assert.equal(massChangeHalts(change({ localDeletes: 50, tracked: 10_000 })), false);
  assert.equal(massChangeHalts(change({ localDeletes: 51, tracked: 10_000 })), true);
});

test("massChangeHalts: the floor spares a handful of files in a small vault", () => {
  assert.equal(massChangeHalts(change({ localDeletes: 10, tracked: 20 })), false);
  assert.equal(massChangeHalts(change({ localDeletes: 11, tracked: 20 })), true);
});

test("massChangeHalts: a first sync uploading a whole vault never trips", () => {
  const local = snapshot(...manyFiles(5_000));
  const actions: SyncAction[] = [];
  for (const entry of local.files) {
    actions.push({ kind: "push", path: entry.path });
  }

  assert.equal(massChangeHalts(massChangeFor(actions, local, 0)), false);
});

test("massChangeHalts: a new device pulling a whole vault into an empty one never trips", () => {
  const actions: SyncAction[] = [];
  for (let i = 0; i < 5_000; i++) {
    actions.push({ kind: "pull", path: `note-${i}.md` });
  }

  assert.equal(massChangeHalts(massChangeFor(actions, empty, 0)), false);
});

test("massChangeHalts: a wiped remote trips in a vault of any size above the floor", () => {
  const local = snapshot(...manyFiles(11));

  assert.equal(massChangeHalts(massChangeFor(deletes(11), local, 11)), true);
});

test("massChangeCopy: names every side the pass would touch", () => {
  const copy = massChangeCopy(
    change({ localDeletes: 214, localOverwrites: 37, remoteDeletes: 3, tracked: 900 }),
    false,
  );

  assert.equal(
    copy.lead,
    "Syncing now would delete 214 files from this vault, replace 37 files here with the version " +
      "from your bucket, and remove 3 files from your bucket. That is more of this vault than " +
      "Geode will change without asking.",
  );
});

test("massChangeCopy: a single side reads as one clause", () => {
  const copy = massChangeCopy(change({ localDeletes: 1, tracked: 4 }), false);

  assert.equal(
    copy.lead,
    "Syncing now would delete 1 file from this vault. That is more of this vault than Geode will " +
      "change without asking.",
  );
});

test("massChangeCopy: two sides read as one clause joined by and", () => {
  const copy = massChangeCopy(change({ localDeletes: 2, remoteDeletes: 4, tracked: 40 }), false);

  assert.equal(
    copy.lead,
    "Syncing now would delete 2 files from this vault and remove 4 files from your bucket. That " +
      "is more of this vault than Geode will change without asking.",
  );
});

test("massChangeCopy: the note says what is recoverable, per side", () => {
  const both = massChangeCopy(change({ localDeletes: 2, localOverwrites: 2, tracked: 20 }), false);
  const overwrites = massChangeCopy(change({ localOverwrites: 2, tracked: 20 }), false);
  const deleted = massChangeCopy(change({ localDeletes: 2, tracked: 20 }), false);
  const remote = massChangeCopy(change({ remoteDeletes: 2, tracked: 20 }), false);

  assert.equal(
    both.note,
    "Deleted files go to your trash, but replaced files do not: the version in this vault is lost.",
  );
  assert.equal(
    overwrites.note,
    "A replaced file does not go to your trash: the version in this vault is lost.",
  );
  assert.equal(
    deleted.note,
    "Deleted files go to your trash, so this is recoverable if it turns out to be wrong.",
  );
  assert.equal(
    remote.note,
    "Nothing in this vault is touched; this only changes what your bucket holds.",
  );
});

test("massChangeCopy: the halt is stated, since a cancelled prompt stops automatic sync", () => {
  const copy = massChangeCopy(change({ localDeletes: 11, tracked: 20 }), false);

  assert.equal(
    copy.halted,
    "Nothing has changed yet, and automatic sync stays off until you answer this.",
  );
});

test("massChangeApproved: an answer covers the plan it was shown, whatever order it comes back in", () => {
  const shown = change({
    localDeletes: 0,
    paths: [
      { kind: "localDelete", path: "a.md" },
      { kind: "localOverwrite", path: "b.md" },
      { kind: "remoteDelete", path: "c.md" },
    ],
  });
  const reordered = change({
    paths: [
      { kind: "remoteDelete", path: "c.md" },
      { kind: "localDelete", path: "a.md" },
      { kind: "localOverwrite", path: "b.md" },
    ],
  });

  assert.equal(massChangeApproved(shown, reordered), true);
});

test("massChangeApproved: nothing is approved without an answer", () => {
  assert.equal(massChangeApproved(null, change({ localDeletes: 11, tracked: 20 })), false);
});

test("massChangeApproved: a plan that is not the one shown is not covered by the answer", () => {
  const shown = change({
    paths: [
      { kind: "localDelete", path: "a.md" },
      { kind: "localDelete", path: "b.md" },
    ],
  });
  // One path swapped, one path added, and one path facing a different fate: each is a plan nobody
  // has actually seen, so none of them may run on the answer given to the one above.
  const swapped = change({
    paths: [
      { kind: "localDelete", path: "a.md" },
      { kind: "localDelete", path: "c.md" },
    ],
  });
  const extra = change({
    paths: [
      { kind: "localDelete", path: "a.md" },
      { kind: "localDelete", path: "b.md" },
      { kind: "localDelete", path: "c.md" },
    ],
  });
  const rekinded = change({
    paths: [
      { kind: "localDelete", path: "a.md" },
      { kind: "localOverwrite", path: "b.md" },
    ],
  });

  assert.equal(massChangeApproved(shown, swapped), false);
  assert.equal(massChangeApproved(shown, extra), false);
  assert.equal(massChangeApproved(shown, rekinded), false);
});

test("massChangeCopy: a second asking says so, since the same dialog twice reads as a bug", () => {
  const copy = massChangeCopy(change({ localDeletes: 12, tracked: 20 }), true);

  assert.equal(
    copy.lead,
    "Something changed since you confirmed, so this is not the sync you agreed to. It would now " +
      "delete 12 files from this vault.",
  );
});

test("destructiveLabel: every kind has a verb", () => {
  assert.equal(destructiveLabel("localDelete"), "delete");
  assert.equal(destructiveLabel("localOverwrite"), "replace");
  assert.equal(destructiveLabel("remoteDelete"), "remove from bucket");
});

// manyFiles builds count file states, for the size cases that only care about how many there are.
function manyFiles(count: number) {
  const files = [];
  for (let i = 0; i < count; i++) {
    files.push(file(`note-${i}.md`, `h${i}`));
  }

  return files;
}

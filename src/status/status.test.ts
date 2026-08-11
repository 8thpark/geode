import assert from "node:assert/strict";
import { test } from "node:test";
import { agoLabel, DEFAULT_STATUS, type Status, type View, view } from "./status.ts";

// NOW is the clock every case below is read against, a round number so the ages in each row are
// arithmetic anyone can check by eye.
const NOW = 1_000_000_000;

// status returns a resting status with everything at its zero value except what a case moves, so
// each row proves which rule answered rather than which field happened to be set.
function status(over: Partial<Status> = {}): Status {
  return { ...DEFAULT_STATUS, ...over };
}

test("view: every state says the same thing in the bar and the tooltip", () => {
  const cases: { name: string; status: Status; want: View }[] = [
    {
      name: "a vault that has never synced says so rather than showing a time it does not have",
      status: status(),
      want: {
        icon: "cloud",
        label: "Not synced yet",
        tooltip: "Geode: not synced yet; click to sync",
      },
    },
    {
      name: "a pass that landed seconds ago reads as now, not as a rounded down zero",
      status: status({ lastSyncedAt: NOW - 30_000 }),
      want: {
        icon: "cloud",
        label: "Synced just now",
        tooltip: "Geode: last synced just now; click to sync",
      },
    },
    {
      name: "an idle vault carries the age of its last pass, which is the whole point of it",
      status: status({ lastSyncedAt: NOW - 2 * 60_000 }),
      want: {
        icon: "cloud",
        label: "Synced 2m ago",
        tooltip: "Geode: last synced 2m ago; click to sync",
      },
    },
    {
      name: "a pass with no plan yet says it is looking, since a first sync spends minutes here",
      status: status({ kind: "syncing" }),
      want: {
        icon: "refresh-cw",
        label: "Checking...",
        tooltip: "Geode: checking for changes",
      },
    },
    {
      name: "a pass with a plan counts it down, which is what a spinner cannot say",
      status: status({ kind: "syncing", progress: { done: 12, total: 340 } }),
      want: {
        icon: "refresh-cw",
        label: "Syncing 12/340",
        tooltip: "Geode: syncing, 12 of 340 changes applied",
      },
    },
    {
      name: "a plan of nothing never claims to be 0/0, it is still looking",
      status: status({ kind: "syncing", progress: { done: 0, total: 0 } }),
      want: {
        icon: "refresh-cw",
        label: "Checking...",
        tooltip: "Geode: checking for changes",
      },
    },
    {
      name: "a failure leads with the failure and still says when the vault was last current",
      status: status({ kind: "error", detail: "2 file(s) failed to sync", lastSyncedAt: NOW }),
      want: {
        icon: "cloud-alert",
        label: "Sync failed",
        tooltip: "Geode: 2 file(s) failed to sync, last synced just now",
      },
    },
    {
      name: "a failure before the first pass has nothing to add, so it adds nothing",
      status: status({ kind: "error", detail: "storage isn't configured yet" }),
      want: {
        icon: "cloud-alert",
        label: "Sync failed",
        tooltip: "Geode: storage isn't configured yet",
      },
    },
    {
      name: "a failure nothing anticipated still reads as a sentence",
      status: status({ kind: "error" }),
      want: {
        icon: "cloud-alert",
        label: "Sync failed",
        tooltip: "Geode: sync failed",
      },
    },
    {
      name: "a paused device says so, and says the click still works",
      status: status({ kind: "paused", lastSyncedAt: NOW - 3 * 3_600_000 }),
      want: {
        icon: "cloud-off",
        label: "Sync paused",
        tooltip: "Geode: automatic sync paused, last synced 3h ago; click to sync once",
      },
    },
  ];

  for (const testCase of cases) {
    assert.deepEqual(view(testCase.status, NOW), testCase.want, testCase.name);
  }
});

test("agoLabel: each unit holds up to the boundary of the next one", () => {
  const cases: { name: string; elapsed: number; want: string }[] = [
    { name: "the same instant", elapsed: 0, want: "just now" },
    { name: "one second short of a minute", elapsed: 59_999, want: "just now" },
    { name: "exactly a minute", elapsed: 60_000, want: "1m ago" },
    { name: "part minutes round down rather than up", elapsed: 119_000, want: "1m ago" },
    { name: "one second short of an hour", elapsed: 3_599_000, want: "59m ago" },
    { name: "exactly an hour", elapsed: 3_600_000, want: "1h ago" },
    { name: "one second short of a day", elapsed: 86_399_000, want: "23h ago" },
    { name: "exactly a day", elapsed: 86_400_000, want: "1d ago" },
    { name: "a long weekend away", elapsed: 4 * 86_400_000, want: "4d ago" },
  ];

  for (const testCase of cases) {
    assert.equal(agoLabel(NOW - testCase.elapsed, NOW), testCase.want, testCase.name);
  }
});

test("agoLabel: a clock that moved backwards reads as now rather than as a negative age", () => {
  assert.equal(agoLabel(NOW + 60_000, NOW), "just now");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PASS,
  type Occasion,
  type Pass,
  PROBLEM_MS,
  ROUTINE_MS,
  STICKY,
  type Toast,
  toastFor,
} from "./notify.ts";

// pass returns a finished pass with everything at its zero value except what a case moves, so each
// row proves which rule answered rather than which field happened to be set.
function pass(over: Partial<Pass> = {}): Occasion {
  return { kind: "pass", pass: { ...DEFAULT_PASS, ...over } };
}

test("toastFor: every occasion that earns a toast gets one, and the order between them holds", () => {
  const cases: { name: string; occasion: Occasion; want: Toast | null }[] = [
    {
      name: "a halt is the one notice that waits until it is dismissed",
      occasion: pass({ message: "secret access key not found", stopped: true }),
      want: {
        durationMs: STICKY,
        text: "Geode has stopped syncing: secret access key not found",
      },
    },
    {
      name: "a mass change outranks the halt it arrives as, since a dialog is already asking",
      occasion: pass({ blocked: true, message: "confirm it first", stopped: true }),
      want: {
        durationMs: PROBLEM_MS,
        text: "Geode is waiting for you to confirm a large change; nothing has synced",
      },
    },
    {
      name: "an ordinary failure reports itself and goes away on its own",
      occasion: pass({ message: "2 file(s) failed to sync" }),
      want: { durationMs: PROBLEM_MS, text: "Geode: 2 file(s) failed to sync" },
    },
    {
      name: "a failure someone asked for reads the same as one nobody did",
      occasion: pass({ manual: true, message: "storage isn't configured yet" }),
      want: { durationMs: PROBLEM_MS, text: "Geode: storage isn't configured yet" },
    },
    {
      name: "a conflict outranks the changes it arrived with, being the half nobody would guess",
      occasion: pass({ changes: 4, conflicts: 1, ok: true }),
      want: {
        durationMs: PROBLEM_MS,
        text: "Geode found a conflict in 1 file; your copy was kept beside the remote one",
      },
    },
    {
      name: "more than one conflict counts them",
      occasion: pass({ changes: 9, conflicts: 3, ok: true }),
      want: {
        durationMs: PROBLEM_MS,
        text: "Geode found a conflict in 3 files; your copy was kept beside the remote one",
      },
    },
    {
      name: "a pass that applied changes says how many",
      occasion: pass({ changes: 1, ok: true }),
      want: { durationMs: ROUTINE_MS, text: "Geode: synced, 1 change applied" },
    },
    {
      name: "an automatic pass that applied changes is worth saying too",
      occasion: pass({ changes: 12, ok: true }),
      want: { durationMs: ROUTINE_MS, text: "Geode: synced, 12 changes applied" },
    },
    {
      name: "a pass someone asked for answers even when there was nothing to do",
      occasion: pass({ manual: true, ok: true }),
      want: { durationMs: ROUTINE_MS, text: "Geode: already up to date" },
    },
    {
      name: "the first quiet pass after a failure says the failure is over",
      occasion: pass({ ok: true, recovered: true }),
      want: { durationMs: ROUTINE_MS, text: "Geode: syncing again" },
    },
    {
      name: "an idle automatic pass is the one thing that stays silent",
      occasion: pass({ ok: true }),
      want: null,
    },
    {
      name: "pausing on this device says so, since the status bar is not the only place to look",
      occasion: { kind: "paused" },
      want: { durationMs: ROUTINE_MS, text: "Geode: automatic sync paused on this device" },
    },
    {
      name: "resuming says so as well",
      occasion: { kind: "resumed" },
      want: { durationMs: ROUTINE_MS, text: "Geode: automatic sync resumed on this device" },
    },
    {
      name: "saving settings confirms the save rather than leaving the form to imply it",
      occasion: { kind: "settingsSaved" },
      want: { durationMs: ROUTINE_MS, text: "Geode: settings saved" },
    },
  ];

  for (const item of cases) {
    assert.deepEqual(toastFor(item.occasion), item.want, item.name);
  }
});

test("toastFor: the zero value is a failed pass with nothing to say for itself", () => {
  // A pass that ended in a way nothing anticipated still reaches the user, since the alternative
  // is a status bar icon changing colour and no explanation anywhere.
  assert.deepEqual(toastFor(pass()), { durationMs: PROBLEM_MS, text: "Geode: sync failed" });
});

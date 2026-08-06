import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DEFAULT_STATE,
  type Due,
  due,
  FOCUS_MIN_GAP_MS,
  LOCAL_MAX_WAIT_MS,
  LOCAL_QUIET_MS,
  noteFocus,
  notePassFinished,
  notePassStarted,
  noteResumed,
  noteVaultChange,
  POLL_INTERVAL_MS,
  type State,
} from "./schedule.ts";

// NOW is the clock reading every case measures back from. Nothing depends on the value beyond it
// being large enough that subtracting any delay below stays comfortably positive.
const NOW = 10_000_000;

// idle returns a scheduler that finished a pass at NOW and holds focus it gained before that pass,
// so neither the poll nor the focus rule is armed. Almost every case starts here and moves exactly
// one thing, since a case that arms two rules at once proves nothing about which one answered.
function idle(over: Partial<State> = {}): State {
  return { ...DEFAULT_STATE, lastPassAt: NOW, focusedAt: NOW - FOCUS_MIN_GAP_MS, ...over };
}

// pending returns the two fields a vault change sets, for a case that needs local work waiting
// without caring how it got there.
function pending(since: number, last: number): Partial<State> {
  return { pendingSince: since, lastEventAt: last };
}

test("due: each rule fires on its own terms, and the order between them holds", () => {
  const cases: { name: string; state: State; want: Due }[] = [
    {
      name: "nothing has ever synced, so the first tick is the startup catch up",
      state: DEFAULT_STATE,
      want: { due: true, trigger: "startup" },
    },
    {
      name: "a pass already in flight outranks every reason to start another",
      state: idle({ syncing: true, ...pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS) }),
      want: { due: false },
    },
    {
      name: "a halt outranks every reason to start one, including the startup catch up",
      state: idle({ stopped: true, lastPassAt: 0 }),
      want: { due: false },
    },
    {
      name: "local changes push once the vault has been quiet long enough",
      state: idle(pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS)),
      want: { due: true, trigger: "local" },
    },
    {
      name: "local changes wait while the vault is still busy",
      state: idle(pending(NOW - 1_000, NOW - 1_000)),
      want: { due: false },
    },
    {
      name: "typing that never goes quiet still pushes at the ceiling",
      state: idle(pending(NOW - LOCAL_MAX_WAIT_MS, NOW)),
      want: { due: true, trigger: "local" },
    },
    {
      name: "local changes push even while the window is unfocused, since files move without it",
      state: idle({ focusedAt: 0, ...pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS) }),
      want: { due: true, trigger: "local" },
    },
    {
      name: "an unfocused window never polls, however long it has been",
      state: idle({ focusedAt: 0, lastPassAt: NOW - POLL_INTERVAL_MS }),
      want: { due: false },
    },
    {
      name: "a focused window polls once the interval has passed",
      state: idle({ lastPassAt: NOW - POLL_INTERVAL_MS, focusedAt: NOW - POLL_INTERVAL_MS - 1 }),
      want: { due: true, trigger: "poll" },
    },
    {
      name: "regaining focus after a long absence syncs without waiting for the poll",
      state: idle({ lastPassAt: NOW - FOCUS_MIN_GAP_MS, focusedAt: NOW }),
      want: { due: true, trigger: "focus" },
    },
    {
      name: "alt tabbing back within the gap is not a sync trigger",
      state: idle({ lastPassAt: NOW - 1_000, focusedAt: NOW }),
      want: { due: false },
    },
    {
      name: "a backoff outranks local work, so a failing vault is not retried every quiet period",
      state: idle({
        failures: 1,
        lastPassAt: NOW - BACKOFF_BASE_MS + 1,
        ...pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS),
      }),
      want: { due: false },
    },
    {
      name: "the retry runs the moment the backoff expires",
      state: idle({
        failures: 1,
        lastPassAt: NOW - BACKOFF_BASE_MS,
        ...pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS),
      }),
      want: { due: true, trigger: "local" },
    },
    {
      name: "three consecutive failures wait four times the base delay, not one",
      state: idle({
        failures: 3,
        lastPassAt: NOW - BACKOFF_BASE_MS * 4 + 1,
        ...pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS),
      }),
      want: { due: false },
    },
    {
      name: "and run once that longer delay expires",
      state: idle({
        failures: 3,
        lastPassAt: NOW - BACKOFF_BASE_MS * 4,
        ...pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS),
      }),
      want: { due: true, trigger: "local" },
    },
    {
      name: "a long offline stretch stops doubling at the cap rather than growing forever",
      state: idle({
        failures: 20,
        lastPassAt: NOW - BACKOFF_MAX_MS,
        ...pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS),
      }),
      want: { due: true, trigger: "local" },
    },
  ];

  for (const c of cases) {
    assert.deepEqual(due(c.state, NOW), c.want, c.name);
  }
});

test("noteVaultChange: the first change starts the ceiling, every change resets the quiet period", () => {
  const first = noteVaultChange(DEFAULT_STATE, 100);
  assert.equal(first.pendingSince, 100);
  assert.equal(first.lastEventAt, 100);

  // The ceiling is measured from the oldest pending change, so a second edit must not push it
  // forward; only the quiet period restarts. Otherwise continuous typing would reset both clocks
  // together and nothing would ever be pushed.
  const second = noteVaultChange(first, 900);
  assert.equal(second.pendingSince, 100);
  assert.equal(second.lastEventAt, 900);
});

test("notePassStarted: pending work is cleared, because the pass about to run covers it", () => {
  const started = notePassStarted(noteVaultChange(DEFAULT_STATE, 100));

  assert.equal(started.syncing, true);
  assert.equal(started.pendingSince, 0);
  assert.equal(started.lastEventAt, 0);
});

test("notePassStarted: an edit landing mid pass is still pending once the pass finishes", () => {
  // The pass snapshots the vault at its own start, so an edit arriving after that is not covered
  // by it and has to survive into the next one. Clearing pending at the end of a pass rather than
  // the start is exactly how that edit would get lost.
  let state = notePassStarted(noteVaultChange(DEFAULT_STATE, 100));
  state = noteVaultChange(state, 200);
  state = notePassFinished(state, "ok", 300);

  assert.equal(state.pendingSince, 200);
  assert.deepEqual(due(state, 200 + LOCAL_QUIET_MS), { due: true, trigger: "local" });
});

test("notePassFinished: a success wipes the slate, a failure counts, a terminal failure halts", () => {
  const failed = notePassFinished(notePassFinished(DEFAULT_STATE, "retry", 100), "retry", 200);
  assert.equal(failed.failures, 2);
  assert.equal(failed.stopped, false);
  // lastPassAt advances on a failure too: it is what the backoff is measured from, so a pass that
  // failed still has to have happened at a time.
  assert.equal(failed.lastPassAt, 200);

  const recovered = notePassFinished(failed, "ok", 300);
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.syncing, false);

  const halted = notePassFinished(failed, "stop", 300);
  assert.equal(halted.stopped, true);
  assert.deepEqual(due(halted, 300 + BACKOFF_MAX_MS * 10), { due: false });
});

test("noteResumed: clears a halt and the accumulated backoff, and nothing else does", () => {
  let state = notePassFinished(DEFAULT_STATE, "stop", 100);
  // A halt survives anything that is not a deliberate resume, so a stopped scheduler cannot drift
  // back into retrying credentials that are still wrong.
  state = noteVaultChange(state, 200);
  state = noteFocus(state, true, 300);
  assert.equal(state.stopped, true);

  const resumed = noteResumed(state);
  assert.equal(resumed.stopped, false);
  assert.equal(resumed.failures, 0);
});

test("noteFocus: losing focus clears the timestamp rather than setting a second flag", () => {
  const focused = noteFocus(DEFAULT_STATE, true, 100);
  assert.equal(focused.focusedAt, 100);

  const blurred = noteFocus(focused, false, 200);
  assert.equal(blurred.focusedAt, 0);
});

test("a burst of edits collapses into one pass, and the vault then goes quiet", () => {
  // The scenario the quiet period exists for: forty keystrokes' worth of vault events a hundred
  // milliseconds apart, which must produce exactly one pass rather than forty.
  let state = { ...DEFAULT_STATE, lastPassAt: NOW, focusedAt: NOW - FOCUS_MIN_GAP_MS };
  let at = NOW;
  let passes = 0;
  for (let i = 0; i < 40; i++) {
    at = at + 100;
    state = noteVaultChange(state, at);
    const decision = due(state, at);
    if (decision.due) {
      passes++;
      state = notePassFinished(notePassStarted(state), "ok", at);
    }
  }

  // Still nothing, since the vault has not been quiet for long enough at any point in the burst.
  assert.equal(passes, 0);

  // The typing stops, and one pass follows.
  at = at + LOCAL_QUIET_MS;
  assert.deepEqual(due(state, at), { due: true, trigger: "local" });
  state = notePassFinished(notePassStarted(state), "ok", at);

  // And nothing follows that one, until the poll interval comes round.
  assert.deepEqual(due(state, at + 1_000), { due: false });
  assert.deepEqual(due(state, at + POLL_INTERVAL_MS), { due: true, trigger: "poll" });
});

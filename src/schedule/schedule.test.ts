import assert from "node:assert/strict";
import { test } from "node:test";
import {
  armed,
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
  noteReconnected,
  noteResumed,
  noteVaultChange,
  POLL_INTERVAL_MS,
  RACE_RETRY_MS,
  type State,
} from "./schedule.ts";

// NOW is the clock reading every case measures back from. Nothing depends on the value beyond it
// being large enough that subtracting any delay below stays comfortably positive.
const NOW = 10_000_000;

// idle returns a scheduler state with every automatic rule disarmed, so a test can move exactly
// one thing and prove which rule answered.
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
      name: "coming back after a long absence syncs without waiting for the poll",
      state: idle({
        lastPassAt: NOW - FOCUS_MIN_GAP_MS,
        blurredAt: NOW - FOCUS_MIN_GAP_MS,
        focusedAt: NOW,
      }),
      want: { due: true, trigger: "focus" },
    },
    {
      // The absence has to be short, not the pass: five unbroken minutes leaves a five minute old
      // pass but no absence at all.
      name: "a two second switch to another app is not an absence, however old the last pass is",
      state: idle({
        lastPassAt: NOW - POLL_INTERVAL_MS + 1,
        blurredAt: NOW - 2_000,
        focusedAt: NOW,
      }),
      want: { due: false },
    },
    {
      name: "a window that has never been away has no absence to come back from",
      state: idle({ lastPassAt: NOW - POLL_INTERVAL_MS + 1, blurredAt: 0, focusedAt: NOW }),
      want: { due: false },
    },
    {
      name: "a pending retry outranks local work, so a failing vault is not tried every quiet period",
      state: idle({ retryAfter: NOW + 1, ...pending(NOW - LOCAL_QUIET_MS, NOW - LOCAL_QUIET_MS) }),
      want: { due: false },
    },
    {
      name: "the retry runs the moment its delay expires",
      state: idle({ retryAfter: NOW }),
      want: { due: true, trigger: "retry" },
    },
    {
      // The case this rule exists for: an unfocused failed push has no poll or focus event to fall
      // back on, so it needs its own retry.
      name: "a failed pass retries even with the window unfocused and nothing pending",
      state: idle({ retryAfter: NOW, focusedAt: 0 }),
      want: { due: true, trigger: "retry" },
    },
  ];

  for (const c of cases) {
    assert.deepEqual(due(c.state, NOW), c.want, c.name);
  }
});

test("armed: automatic sync runs only once configured, synced once already, and not paused", () => {
  const ready = { configured: true, paused: false, syncedBefore: true };

  assert.equal(armed(ready), true);
  assert.equal(armed({ ...ready, paused: true }), false);
  // A bucket's first pass mints its identity and has no ancestor to fall back on, so it stays
  // something a user asks for rather than something that happens to them.
  assert.equal(armed({ ...ready, syncedBefore: false }), false);
  assert.equal(armed({ ...ready, configured: false }), false);
});

test("noteVaultChange: the first change starts the ceiling, every change resets the quiet period", () => {
  const first = noteVaultChange(DEFAULT_STATE, 100);
  assert.equal(first.pendingSince, 100);
  assert.equal(first.lastEventAt, 100);

  // The ceiling is measured from the oldest change, so a second edit must not push it forward,
  // only the quiet period restarts.
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
  // The pass snapshots the vault at its own start, so an edit arriving after that must survive
  // into the next pass rather than being cleared with it.
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
  // lastPassAt advances on a failure too, since the poll and focus rules measure from it: a pass
  // that failed still has to have happened at a time.
  assert.equal(failed.lastPassAt, 200);

  const recovered = notePassFinished(failed, "ok", 300);
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.retryAfter, 0);
  assert.equal(recovered.syncing, false);

  const halted = notePassFinished(failed, "stop", 300);
  assert.equal(halted.stopped, true);
  // A halt is not a slow retry; nothing is waiting, and no amount of time changes the answer.
  assert.equal(halted.retryAfter, 0);
  assert.deepEqual(due(halted, 300 + BACKOFF_MAX_MS * 10), { due: false });
});

test("notePassFinished: the retry delay doubles with each consecutive failure, up to the cap", () => {
  let state = notePassFinished(DEFAULT_STATE, "retry", 1_000);
  assert.equal(state.retryAfter, 1_000 + BACKOFF_BASE_MS);

  state = notePassFinished(state, "retry", 2_000);
  assert.equal(state.retryAfter, 2_000 + BACKOFF_BASE_MS * 2);

  state = notePassFinished(state, "retry", 3_000);
  assert.equal(state.retryAfter, 3_000 + BACKOFF_BASE_MS * 4);

  // A long stretch offline stops doubling rather than growing into a delay nothing would ever
  // reach, so a laptop reopened after lunch still catches up on its own.
  let long = DEFAULT_STATE;
  for (let i = 0; i < 20; i++) {
    long = notePassFinished(long, "retry", 0);
  }
  assert.equal(long.retryAfter, BACKOFF_MAX_MS);
});

test("notePassFinished: losing a race retries soon and never counts towards giving up", () => {
  // Losing a race is ordinary once sync runs on a timer, and the loser has lost nothing, so
  // counting it would escalate a healthy vault into a half hour backoff for no reason.
  let state = DEFAULT_STATE;
  for (let i = 0; i < 10; i++) {
    state = notePassFinished(state, "raced", 1_000);
  }

  assert.equal(state.failures, 0);
  assert.equal(state.retryAfter, 1_000 + RACE_RETRY_MS);
  assert.deepEqual(due(state, 1_000 + RACE_RETRY_MS), { due: true, trigger: "retry" });
});

test("notePassFinished: a race breaks a failure streak, since it proves the round trip works", () => {
  // A raced pass reached the provider, read the manifest, and moved the files: proof the round
  // trip works, so it resets the streak instead of merely holding it.
  let state = notePassFinished(DEFAULT_STATE, "retry", 1_000);
  assert.equal(state.failures, 1);

  state = notePassFinished(state, "raced", 2_000);
  assert.equal(state.failures, 0);

  state = notePassFinished(state, "retry", 3_000);
  assert.equal(state.failures, 1);
  assert.equal(state.retryAfter, 3_000 + BACKOFF_BASE_MS);
});

test("noteReconnected: ends a backoff early, keeping the streak that sized it", () => {
  let state = notePassFinished(notePassFinished(DEFAULT_STATE, "retry", 100), "retry", 200);
  assert.equal(state.retryAfter, 200 + BACKOFF_BASE_MS * 2);

  state = noteReconnected(state, 300);
  assert.deepEqual(due(state, 300), { due: true, trigger: "retry" });
  // The streak survives, so a reconnect that fixed nothing cannot flap the retry delay back down to
  // the base every time an interface returns.
  assert.equal(state.failures, 2);

  state = notePassFinished(state, "retry", 300);
  assert.equal(state.retryAfter, 300 + BACKOFF_BASE_MS * 4);
});

test("noteReconnected: with nothing waiting, there is nothing to bring forward", () => {
  // A retry already due is not pushed back to the moment the network returned, and a state with no
  // retry pending is not handed one it never earned.
  const overdue = notePassFinished(DEFAULT_STATE, "retry", 100);
  assert.deepEqual(noteReconnected(overdue, overdue.retryAfter + 1), overdue);
  assert.deepEqual(noteReconnected(DEFAULT_STATE, 100), DEFAULT_STATE);
});

test("noteReconnected: a halt survives, since a network returning fixes nothing it stopped for", () => {
  // Rejected credentials and a bucket belonging to another vault are exactly as wrong after a
  // reconnect, so resuming here would re-fail on every flap for as long as the vault is open.
  const halted = notePassFinished(DEFAULT_STATE, "stop", 100);

  assert.deepEqual(noteReconnected(halted, 200), halted);
  assert.deepEqual(due(noteReconnected(halted, 200), 100 + BACKOFF_MAX_MS * 10), { due: false });
});

test("noteResumed: clears a halt and any pending retry, and nothing else does", () => {
  let state = notePassFinished(DEFAULT_STATE, "stop", 100);
  // A halt survives anything that is not a deliberate resume, so a stopped scheduler cannot drift
  // back into retrying credentials that are still wrong.
  state = noteVaultChange(state, 200);
  state = noteFocus(state, true, 300);
  assert.equal(state.stopped, true);

  const resumed = noteResumed(state);
  assert.equal(resumed.stopped, false);
  assert.equal(resumed.failures, 0);
  assert.equal(resumed.retryAfter, 0);
});

test("noteFocus: losing focus records when, so the absence can be measured on the way back", () => {
  const focused = noteFocus(DEFAULT_STATE, true, 100);
  assert.equal(focused.focusedAt, 100);

  const blurred = noteFocus(focused, false, 200);
  assert.equal(blurred.focusedAt, 0);
  assert.equal(blurred.blurredAt, 200);

  const back = noteFocus(blurred, true, 200 + FOCUS_MIN_GAP_MS);
  assert.deepEqual(due({ ...back, lastPassAt: 1 }, back.focusedAt), {
    due: true,
    trigger: "focus",
  });
});

test("a failed push retries on its own, having already cleared the work it was covering", () => {
  // End to end: an edit on an unfocused window pushes and fails, and nothing else is ever going to
  // fire it again, so the retry has to come from the failure itself.
  let state = { ...DEFAULT_STATE, lastPassAt: NOW - POLL_INTERVAL_MS, focusedAt: 0 };
  state = noteVaultChange(state, NOW);

  const at = NOW + LOCAL_QUIET_MS;
  assert.deepEqual(due(state, at), { due: true, trigger: "local" });

  state = notePassFinished(notePassStarted(state), "retry", at);
  assert.equal(state.pendingSince, 0);

  assert.deepEqual(due(state, at + BACKOFF_BASE_MS - 1), { due: false });
  assert.deepEqual(due(state, at + BACKOFF_BASE_MS), { due: true, trigger: "retry" });
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

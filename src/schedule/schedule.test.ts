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
  noteResumed,
  noteVaultChange,
  POLL_INTERVAL_MS,
  RACE_RETRY_MS,
  type State,
} from "./schedule.ts";

// NOW is the clock reading every case measures back from. Nothing depends on the value beyond it
// being large enough that subtracting any delay below stays comfortably positive.
const NOW = 10_000_000;

// idle returns a scheduler that finished a pass at NOW and holds focus it gained before that pass,
// having never been away, so none of the poll, focus, or retry rules is armed. Almost every case
// starts here and moves exactly one thing, since a case that arms two rules at once proves nothing
// about which one answered.
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
      // The absence is what has to be short here, not the pass. A window someone has been working
      // in for five unbroken minutes has a five minute old pass and no absence at all, so
      // measuring the gap from the pass would make every two second switch to another app a sync.
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
      // The failure this rule exists for. A push that fails has already had its pending work
      // cleared by notePassStarted, and an unfocused window has neither a poll nor a focus event
      // to fall back on, so without a retry of its own the edits would sit there unsynced.
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
  // Two devices syncing at overlapping times is ordinary once sync runs on a timer rather than a
  // click, and the loser has lost nothing: its work is intact and the manifest it needs to
  // reconcile against is now sitting there fresh. Counting these would let an entirely healthy
  // two device vault escalate itself into a half hour backoff.
  let state = DEFAULT_STATE;
  for (let i = 0; i < 10; i++) {
    state = notePassFinished(state, "raced", 1_000);
  }

  assert.equal(state.failures, 0);
  assert.equal(state.retryAfter, 1_000 + RACE_RETRY_MS);
  assert.deepEqual(due(state, 1_000 + RACE_RETRY_MS), { due: true, trigger: "retry" });
});

test("notePassFinished: a race breaks a failure streak, since it proves the round trip works", () => {
  // A raced pass reached the provider, read the manifest, moved the files, and lost only the final
  // compare-and-swap, so the network and the credentials are demonstrably fine. Merely holding the
  // count instead of clearing it would charge the next unrelated blip a doubled delay for a streak
  // that a working round trip had already broken, and a long enough interleaving of blips and
  // races would reach the half hour cap without ever failing twice in a row.
  let state = notePassFinished(DEFAULT_STATE, "retry", 1_000);
  assert.equal(state.failures, 1);

  state = notePassFinished(state, "raced", 2_000);
  assert.equal(state.failures, 0);

  state = notePassFinished(state, "retry", 3_000);
  assert.equal(state.failures, 1);
  assert.equal(state.retryAfter, 3_000 + BACKOFF_BASE_MS);
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
  // End to end over the rule above: an edit on an unfocused window pushes, the push fails, and
  // nothing else is ever going to fire. No poll, because the window is unfocused. No focus event,
  // because nobody has touched it. No further edit, because the user has walked away. The retry
  // has to come from the failure itself or the work sits there.
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

// Deciding when to sync, kept apart from doing it. Every rule here is a policy question with a
// defensible answer rather than a number someone should have to configure (#93), and every one of
// them is a pure comparison against a clock the caller passes in, so the whole policy is table
// testable without a timer, a fake clock, or Obsidian.
//
// The shape is deliberately dull: the plugin ticks this every TICK_MS and asks one question, "is a
// pass due, and why". There is no timer per trigger, no rescheduling, and nothing to interpret; a
// tick that finds nothing due does a handful of subtractions and returns. The cost of that
// simplicity is that every delay below is accurate only to within one tick, which no user can
// perceive and no correctness argument rests on.

// BACKOFF_BASE_MS is how long to wait after a single failed pass. Deliberately longer than
// POLL_INTERVAL_MS is short: the first retry after a failure is the one most likely to fail for
// the same reason, so there is nothing to gain by rushing it.
export const BACKOFF_BASE_MS = 120_000;

// BACKOFF_MAX_MS caps the doubling. Half an hour is long enough that a genuinely broken setup
// stops generating requests, short enough that a laptop reopened after lunch catches up on its own
// rather than waiting for someone to notice and click.
export const BACKOFF_MAX_MS = 1_800_000;

// FOCUS_MIN_GAP_MS is how long a window must have been away before regaining focus counts as a
// reason to sync. Without a floor, alt tabbing would be a sync trigger.
export const FOCUS_MIN_GAP_MS = 60_000;

// LOCAL_MAX_WAIT_MS is the longest pending local changes may wait for quiet. An unbroken hour of
// typing never goes quiet, and without this ceiling it would never push either.
export const LOCAL_MAX_WAIT_MS = 30_000;

// LOCAL_QUIET_MS is how long the vault must be still before pending local changes are pushed.
// Obsidian's own autosave debounce is around two seconds (see flushOpenEditors in
// vault/obsidian.ts), so this sits just past it: a burst of typing collapses into one pass rather
// than one per keystroke, and the file is already on disk by the time the pass reads it.
export const LOCAL_QUIET_MS = 5_000;

// PAUSE_KEY is where a paused sync is remembered: Obsidian's vault scoped localStorage, for the
// same reason DEVICE_ID_KEY lives there rather than in data.json. Pause is a statement about this
// machine ("not while I'm tethered"), and settings travel to every device that reads a synced
// .obsidian/ folder, so storing it there would silently pause the desktop because someone paused
// the laptop. Persisted rather than held for the session, because a pause that quietly expires on
// restart breaks the only promise the control makes.
export const PAUSE_KEY = "geode-sync-paused";

// POLL_INTERVAL_MS is how often a focused window asks whether another device has synced. Polling
// is the only way to find out: no S3 compatible provider can notify a plugin. Five minutes is the
// conservative opening value, since every poll is currently a full pass; it drops once a pass can
// rule itself out with a single HEAD on the manifest (#93, step 5).
export const POLL_INTERVAL_MS = 300_000;

// TICK_MS is how often the plugin asks due() for a decision. Small enough that every delay here is
// accurate to the second or so, cheap enough to be irrelevant: a tick with nothing to do is a
// handful of integer comparisons.
export const TICK_MS = 5_000;

// DEFAULT_STATE is the complete zero value: nothing pending, nothing failed, nothing synced yet,
// and a window assumed unfocused until the plugin says otherwise.
export const DEFAULT_STATE: State = {
  failures: 0,
  focusedAt: 0,
  lastEventAt: 0,
  lastPassAt: 0,
  pendingSince: 0,
  stopped: false,
  syncing: false,
};

// Due is the answer to "should a pass start right now": either no, or yes and what to call it.
export type Due = { due: false } | { due: true; trigger: Trigger };

// PassResult is how a finished pass bears on when the next one runs, which is all the scheduler
// needs to know about it. "ok" clears any backoff, "retry" backs off and tries again, and "stop"
// halts automatic passes entirely, for a failure no amount of retrying can fix (credentials, an
// unusable configuration, a bucket written in a format this build cannot read). Retrying one of
// those every few minutes for a week is not resilience, it is a machine that has stopped
// listening; noteResumed is how a halt ends.
export type PassResult = "ok" | "retry" | "stop";

// State is everything the scheduler needs to make its decision. Every field is a millisecond
// timestamp or a flag, so the whole thing is comparable, copyable, and inspectable in a log line.
// Zero means "never" throughout, which is safe because no real clock reading is ever zero.
export type State = {
  // failures counts consecutive failed passes, and resets to zero on any success.
  failures: number;
  // focusedAt is when the window last gained focus, and zero for as long as it does not have it,
  // so one field answers both "is it focused" and "since when".
  focusedAt: number;
  // lastEventAt is when the most recent vault change arrived, the clock the quiet period runs off.
  lastEventAt: number;
  // lastPassAt is when the last pass finished, zero if none ever has.
  lastPassAt: number;
  // pendingSince is when the oldest unsynced vault change arrived, zero when there are none, and
  // the clock the ceiling on waiting for quiet runs off.
  pendingSince: number;
  // stopped is set by a failure retrying cannot fix, and cleared only by noteResumed.
  stopped: boolean;
  // syncing is true while a pass is in flight, so a tick never starts a second one.
  syncing: boolean;
};

// Trigger names why a pass ran, for the log and for the caller's own branching. due() returns the
// automatic ones; "manual" is the caller's own name for a pass a user asked for, which bypasses
// every rule here, including a halt.
export type Trigger = "startup" | "local" | "poll" | "focus" | "manual";

// due reports whether a pass should start at now, and which trigger asked for it. The order of the
// checks is the priority order: local work outranks polling because pushing an edit we already
// know about beats asking a question whose answer is almost always no, and it sits above the focus
// gate because a file can change while the window is in the background.
export function due(state: State, now: number): Due {
  if (state.syncing || state.stopped) {
    return { due: false };
  }
  if (state.failures > 0 && now - state.lastPassAt < backoffFor(state.failures)) {
    return { due: false };
  }
  // Nothing has ever synced in this session, so catch up on whatever the other devices did while
  // this one was closed. This is the startup sync: it needs no timer of its own, since the first
  // tick after the plugin arms the scheduler is already the right moment.
  if (state.lastPassAt === 0) {
    return { due: true, trigger: "startup" };
  }
  if (localSettled(state, now)) {
    return { due: true, trigger: "local" };
  }
  // An unfocused window polls for nothing. Coming back to a machine is itself a trigger, so the
  // gap is closed in one pass the moment someone looks, rather than by spending a request every
  // few minutes on a screen nobody is reading.
  if (state.focusedAt === 0) {
    return { due: false };
  }
  if (state.focusedAt > state.lastPassAt && now - state.lastPassAt >= FOCUS_MIN_GAP_MS) {
    return { due: true, trigger: "focus" };
  }
  if (now - state.lastPassAt >= POLL_INTERVAL_MS) {
    return { due: true, trigger: "poll" };
  }

  return { due: false };
}

// noteFocus records the window gaining or losing focus. Losing it clears focusedAt rather than
// setting a second flag, so "not focused" and "focused at no particular time" cannot disagree.
export function noteFocus(state: State, focused: boolean, now: number): State {
  if (!focused) {
    return { ...state, focusedAt: 0 };
  }

  return { ...state, focusedAt: now };
}

// notePassFinished records a pass ending, whatever it ended as. lastPassAt advances on failure
// too: it is what the backoff is measured from, so a pass that failed still has to have happened
// at a time. Counting consecutive failures rather than total is what lets one success wipe the
// slate, so a flaky train journey costs one slow retry rather than a permanently slow client.
export function notePassFinished(state: State, result: PassResult, now: number): State {
  if (result === "ok") {
    return { ...state, syncing: false, lastPassAt: now, failures: 0 };
  }
  if (result === "stop") {
    return {
      ...state,
      syncing: false,
      lastPassAt: now,
      failures: state.failures + 1,
      stopped: true,
    };
  }

  return { ...state, syncing: false, lastPassAt: now, failures: state.failures + 1 };
}

// notePassStarted records a pass beginning, and clears the pending local work it is about to
// cover. Clearing here rather than on success is deliberate: the pass takes its own fresh snapshot
// of the vault, so every edit made before this moment is already its responsibility, and an edit
// landing mid pass sets pendingSince again from zero and so is still pending afterwards. A pass
// that then fails does not lose that work either; the changes are still on disk, and the next pass
// re-plans them from the ancestor that never advanced.
export function notePassStarted(state: State): State {
  return { ...state, syncing: true, pendingSince: 0, lastEventAt: 0 };
}

// noteResumed clears a halt and any accumulated backoff, the response to something changing that
// could plausibly fix whatever failed: settings saved, the network coming back, or a user asking
// by hand. Nothing else clears stopped, which is the point of it.
export function noteResumed(state: State): State {
  return { ...state, failures: 0, stopped: false };
}

// noteVaultChange records a local file appearing, changing, moving, or going away. The first one
// starts the clock the ceiling runs off; every one of them resets the clock the quiet period runs
// off.
export function noteVaultChange(state: State, now: number): State {
  if (state.pendingSince !== 0) {
    return { ...state, lastEventAt: now };
  }

  return { ...state, pendingSince: now, lastEventAt: now };
}

// backoffFor returns how long to wait after count consecutive failures: the base delay doubled
// once per failure beyond the first, capped. Doubled in a loop rather than by exponentiation so a
// long lived offline session cannot overflow the delay into something meaningless.
function backoffFor(count: number): number {
  let delay = BACKOFF_BASE_MS;
  for (let i = 1; i < count; i++) {
    delay = delay * 2;
    if (delay >= BACKOFF_MAX_MS) {
      return BACKOFF_MAX_MS;
    }
  }

  return delay;
}

// localSettled reports whether pending local changes have waited long enough to push: either the
// vault has been quiet for LOCAL_QUIET_MS, or the oldest pending change has waited
// LOCAL_MAX_WAIT_MS without the vault ever going quiet.
function localSettled(state: State, now: number): boolean {
  if (state.pendingSince === 0) {
    return false;
  }
  if (now - state.lastEventAt >= LOCAL_QUIET_MS) {
    return true;
  }

  return now - state.pendingSince >= LOCAL_MAX_WAIT_MS;
}

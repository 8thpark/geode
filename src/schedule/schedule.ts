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

// DEFAULT_STATE is the complete zero value: nothing pending, nothing failed, nothing synced yet,
// and a window assumed unfocused until the plugin says otherwise.
export const DEFAULT_STATE: State = {
  blurredAt: 0,
  failures: 0,
  focusedAt: 0,
  lastEventAt: 0,
  lastPassAt: 0,
  pendingSince: 0,
  retryAfter: 0,
  stopped: false,
  syncing: false,
};

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

// RACE_RETRY_MS is how long to wait after losing the manifest compare-and-swap to another device.
// Short, and nothing like a backoff, because nothing went wrong: the other device finished first,
// this one's work is untouched, and the manifest it needed to reconcile against is now sitting
// there fresh. Waiting out a two minute backoff would be waiting for nothing to change.
export const RACE_RETRY_MS = 10_000;

// TICK_MS is how often the plugin asks due() for a decision. Small enough that every delay here is
// accurate to the second or so, cheap enough to be irrelevant: a tick with nothing to do is a
// handful of integer comparisons.
export const TICK_MS = 5_000;

// Due is the answer to "should a pass start right now": either no, or yes and what to call it.
export type Due = { due: false } | { due: true; trigger: Trigger };

// PassResult is how a finished pass bears on when the next one runs, which is all the scheduler
// needs to know about it. "ok" clears everything. "raced" lost the manifest compare-and-swap to
// another device, and comes back quickly without counting as a failure at all. "retry" backs off
// and tries again. "stop" halts automatic passes entirely, for a failure no amount of retrying can
// fix (credentials, an unusable configuration, a bucket written in a format this build cannot
// read); retrying one of those every few minutes for a week is not resilience, it is a machine
// that has stopped listening, and noteResumed is how a halt ends.
export type PassResult = "ok" | "raced" | "retry" | "stop";

// Readiness is everything outside the scheduler that decides whether automatic sync may run at
// all, which is a different question from whether a pass is due. Passed in as plain answers rather
// than read from settings here, so this module stays free of every other package.
export type Readiness = {
  // configured is whether storage is filled in and usable.
  configured: boolean;
  // paused is whether the user switched automatic sync off on this device.
  paused: boolean;
  // syncedBefore is whether a sync has ever completed against the configured bucket.
  syncedBefore: boolean;
};

// State is everything the scheduler needs to make its decision. Every field is a millisecond
// timestamp or a flag, so the whole thing is comparable, copyable, and inspectable in a log line.
// Zero means "never" throughout, which is safe because no real clock reading is ever zero.
export type State = {
  // blurredAt is when the window last lost focus, and zero if it never has. It is what makes the
  // length of an absence knowable: without it the only measure to hand is the age of the last
  // pass, and an hour of unbroken work in a focused window would read as an hour spent away.
  blurredAt: number;
  // failures counts consecutive failed passes, and resets to zero on any success. It exists only
  // to decide how loudly to complain (#182 escalates at the third in a row); when to try again is
  // retryAfter's job, so that one counter is never asked two questions at once.
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
  // retryAfter is when a pass that did not succeed may be tried again, and zero when there is
  // nothing waiting to be retried. Written where the failure is recorded rather than derived here
  // from a counter, so a delay that varies by reason (ten seconds for a lost race, a doubling
  // backoff for a real failure) is one timestamp to compare against instead of arithmetic every
  // caller has to reproduce.
  retryAfter: number;
  // stopped is set by a failure retrying cannot fix, and cleared only by noteResumed.
  stopped: boolean;
  // syncing is true while a pass is in flight, so a tick never starts a second one.
  syncing: boolean;
};

// Trigger names why a pass ran, for the log and for the caller's own branching. due() returns the
// automatic ones; "manual" is the caller's own name for a pass a user asked for, which bypasses
// every rule here, including a halt.
export type Trigger = "startup" | "local" | "poll" | "focus" | "retry" | "manual";

// armed reports whether automatic sync may run at all on this device. Kept here rather than in the
// plugin so the answer is one testable expression rather than a stack of early returns on a class,
// and taken as plain booleans so this module never learns what a setting is.
export function armed(readiness: Readiness): boolean {
  if (readiness.paused) {
    return false;
  }
  if (!readiness.syncedBefore) {
    return false;
  }

  return readiness.configured;
}

// due reports whether a pass should start at now, and which trigger asked for it. The order of the
// checks is the priority order: local work outranks polling because pushing an edit we already
// know about beats asking a question whose answer is almost always no, and it sits above the focus
// gate because a file can change while the window is in the background.
export function due(state: State, now: number): Due {
  if (state.syncing || state.stopped) {
    return { due: false };
  }
  // A pass that did not succeed is its own reason to run again, ahead of every other rule and
  // regardless of focus. Without this it would have to hope some other trigger came along:
  // notePassStarted clears the pending local work the pass was covering, so a push that fails on an
  // unfocused window has nothing left to fire it, and the edits would sit there until the user
  // happened to click back into Obsidian. Silence with unsynced work behind it is the one outcome
  // this whole design exists to avoid.
  if (state.retryAfter !== 0) {
    if (now < state.retryAfter) {
      return { due: false };
    }

    return { due: true, trigger: "retry" };
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
  if (returnedFromAway(state)) {
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
    return { ...state, focusedAt: 0, blurredAt: now };
  }

  return { ...state, focusedAt: now };
}

// notePassFinished records a pass ending, whatever it ended as, and decides there and then when
// the next attempt may run. lastPassAt advances on a failure too, since a pass that failed still
// has to have happened at a time for the poll and focus rules to measure from. Counting
// consecutive failures rather than total is what lets one success wipe the slate, so a flaky train
// journey costs one slow retry rather than a permanently slow client.
export function notePassFinished(state: State, result: PassResult, now: number): State {
  const finished = { ...state, syncing: false, lastPassAt: now };
  if (result === "ok") {
    return { ...finished, failures: 0, retryAfter: 0 };
  }
  // Losing the race is not this device failing, and must never count towards giving up. Two
  // devices syncing at overlapping times is ordinary once sync is automatic rather than clicked,
  // nothing is lost by it, and the loser's next pass reconciles both sides. Counting it would let
  // an ordinary two device vault escalate itself into a half hour backoff over passes where
  // everything worked exactly as designed.
  if (result === "raced") {
    return { ...finished, retryAfter: now + RACE_RETRY_MS };
  }
  const failures = state.failures + 1;
  if (result === "stop") {
    return { ...finished, failures, retryAfter: 0, stopped: true };
  }

  return { ...finished, failures, retryAfter: now + backoffFor(failures) };
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
  return { ...state, failures: 0, retryAfter: 0, stopped: false };
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

// returnedFromAway reports whether the window has come back from an absence long enough to be
// worth a sync, and has not already synced since coming back. The absence is measured from when
// focus was actually lost, never from the age of the last pass: an hour of unbroken work in a
// focused window is not an absence, and measuring it that way would turn every two second switch
// to another app into a full pass. A window that has never been away has no absence to measure.
function returnedFromAway(state: State): boolean {
  if (state.focusedAt <= state.lastPassAt) {
    return false;
  }
  if (state.blurredAt === 0) {
    return false;
  }

  return state.focusedAt - state.blurredAt >= FOCUS_MIN_GAP_MS;
}

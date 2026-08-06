// Deciding when to sync, kept apart from doing it: every rule below is a pure comparison against a
// clock the caller passes in, so the policy is table testable without a timer or Obsidian.

// BACKOFF_BASE_MS is the delay after a single failed pass; the first retry is the likeliest to fail
// the same way, so there's nothing to gain by rushing it.
export const BACKOFF_BASE_MS = 120_000;

// BACKOFF_MAX_MS caps the doubling: long enough to stop hammering, short enough to catch up after
// lunch.
export const BACKOFF_MAX_MS = 1_800_000;

// DEFAULT_STATE is the complete zero value: nothing pending, nothing failed, nothing synced yet.
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
// reason to sync; without a floor, alt tabbing would trigger one.
export const FOCUS_MIN_GAP_MS = 60_000;

// LOCAL_MAX_WAIT_MS is the longest pending local changes may wait for quiet; an unbroken hour of
// typing never goes quiet on its own.
export const LOCAL_MAX_WAIT_MS = 30_000;

// LOCAL_QUIET_MS is how long the vault must be still before pending local changes push; just past
// Obsidian's own autosave debounce.
export const LOCAL_QUIET_MS = 5_000;

// PAUSE_KEY is where the automatic sync pause is remembered: vault scoped localStorage, not
// data.json, since pausing is a statement about this device rather than something every device
// should inherit.
export const PAUSE_KEY = "geode-sync-paused";

// POLL_INTERVAL_MS is how often a focused window polls for remote changes; conservative since
// every poll is currently a full pass.
export const POLL_INTERVAL_MS = 300_000;

// RACE_RETRY_MS is the wait after losing the manifest compare and swap; nothing went wrong, so
// there's nothing to back off from.
export const RACE_RETRY_MS = 10_000;

// TICK_MS is how often the plugin asks due() for a decision; cheap enough to be irrelevant, small
// enough to keep delays honest.
export const TICK_MS = 5_000;

// Due is the answer to "should a pass start right now": either no, or yes and what to call it.
export type Due = { due: false } | { due: true; trigger: Trigger };

// PassResult is how a finished pass bears on the next one: ok clears the slate, raced retries
// without counting as failure, retry backs off, stop halts automatic passes until noteResumed.
export type PassResult = "ok" | "raced" | "retry" | "stop";

// Readiness is everything outside the scheduler that decides whether automatic sync may run,
// passed in as plain booleans so this module never has to import settings.
export type Readiness = {
  // configured is whether storage is filled in and usable.
  configured: boolean;
  // paused is whether the user switched automatic sync off on this device.
  paused: boolean;
  // syncedBefore is whether a sync has ever completed against the configured bucket.
  syncedBefore: boolean;
};

// State is everything the scheduler needs to decide: a millisecond timestamp or flag per field, so
// the whole thing is comparable, copyable, and loggable. Zero means "never" throughout.
export type State = {
  // blurredAt is when the window last lost focus, zero if it never has; absence is measured from
  // here, not from the last pass.
  blurredAt: number;
  // failures counts consecutive failed passes and resets on success; retryAfter alone decides when
  // to retry, so this counter is never asked two questions at once.
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
  // retryAfter is when a failed pass may retry, zero when nothing is waiting; written at the point
  // of failure so callers compare one timestamp instead of recomputing a delay themselves.
  retryAfter: number;
  // stopped is set by a failure retrying cannot fix, and cleared only by noteResumed.
  stopped: boolean;
  // syncing is true while a pass is in flight, so a tick never starts a second one.
  syncing: boolean;
};

// Trigger names why a pass ran. due() returns the automatic ones; "manual" is the caller's name for
// a pass someone asked for, which bypasses every rule here, including a halt.
export type Trigger = "startup" | "local" | "poll" | "focus" | "retry" | "manual";

// armed reports whether automatic sync may run on this device, as one testable expression rather
// than a stack of early returns spread across the plugin class.
export function armed(readiness: Readiness): boolean {
  if (readiness.paused) {
    return false;
  }
  if (!readiness.syncedBefore) {
    return false;
  }

  return readiness.configured;
}

// due reports whether a pass should start at now and which trigger asked for it; the checks below
// run in priority order.
export function due(state: State, now: number): Due {
  if (state.syncing || state.stopped) {
    return { due: false };
  }
  // A failed pass is its own reason to run again, ahead of every other rule: notePassStarted has
  // already cleared the local work it was covering, so nothing else would fire it again.
  if (state.retryAfter !== 0) {
    if (now < state.retryAfter) {
      return { due: false };
    }

    return { due: true, trigger: "retry" };
  }
  // Nothing has synced yet this session, so the first tick is the startup catch up; it needs no
  // timer of its own.
  if (state.lastPassAt === 0) {
    return { due: true, trigger: "startup" };
  }
  if (localSettled(state, now)) {
    return { due: true, trigger: "local" };
  }
  // An unfocused window never polls; coming back is itself a trigger, so the gap closes in one
  // pass the moment someone looks.
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

// notePassFinished records a pass ending and decides when the next attempt may run. lastPassAt
// advances on a failure too, since the poll and focus rules measure from it regardless of outcome.
export function notePassFinished(state: State, result: PassResult, now: number): State {
  const finished = { ...state, syncing: false, lastPassAt: now };
  if (result === "ok") {
    return { ...finished, failures: 0, retryAfter: 0 };
  }
  // Losing the race isn't this device failing, so it resets the streak instead of counting against
  // it.
  if (result === "raced") {
    return { ...finished, failures: 0, retryAfter: now + RACE_RETRY_MS };
  }
  const failures = state.failures + 1;
  if (result === "stop") {
    return { ...finished, failures, retryAfter: 0, stopped: true };
  }

  return { ...finished, failures, retryAfter: now + backoffFor(failures) };
}

// notePassStarted records a pass beginning and clears the pending local work it's about to cover,
// since the pass snapshots the vault fresh and an edit landing mid pass sets pendingSince again.
export function notePassStarted(state: State): State {
  return { ...state, syncing: true, pendingSince: 0, lastEventAt: 0 };
}

// noteResumed clears a halt and any backoff; nothing else clears stopped, which is the point of it.
export function noteResumed(state: State): State {
  return { ...state, failures: 0, retryAfter: 0, stopped: false };
}

// noteVaultChange records a local file appearing, changing, moving, or going away: the first sets
// pendingSince, every one resets lastEventAt.
export function noteVaultChange(state: State, now: number): State {
  if (state.pendingSince !== 0) {
    return { ...state, lastEventAt: now };
  }

  return { ...state, pendingSince: now, lastEventAt: now };
}

// backoffFor returns how long to wait after count consecutive failures: BACKOFF_BASE_MS doubled
// once per failure beyond the first, capped at BACKOFF_MAX_MS, looped rather than exponentiated so
// a long offline stretch can't overflow into something meaningless.
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

// localSettled reports whether pending local changes have waited long enough to push.
function localSettled(state: State, now: number): boolean {
  if (state.pendingSince === 0) {
    return false;
  }
  if (now - state.lastEventAt >= LOCAL_QUIET_MS) {
    return true;
  }

  return now - state.pendingSince >= LOCAL_MAX_WAIT_MS;
}

// returnedFromAway reports whether the window returned from an absence worth syncing over,
// measured from when focus was actually lost rather than the age of the last pass.
function returnedFromAway(state: State): boolean {
  if (state.focusedAt <= state.lastPassAt) {
    return false;
  }
  if (state.blurredAt === 0) {
    return false;
  }

  return state.focusedAt - state.blurredAt >= FOCUS_MIN_GAP_MS;
}

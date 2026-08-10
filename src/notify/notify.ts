// Deciding what geode says out loud, kept apart from saying it: every occasion below is one row of
// a table, so the wording and the silences are pinned by a test rather than scattered across the
// plugin class. The case for each row is in docs/technical_plugin.md.

// DEFAULT_PASS is the complete zero value: a pass that failed, said nothing, and changed nothing.
export const DEFAULT_PASS: Pass = {
  blocked: false,
  changes: 0,
  conflicts: 0,
  manual: false,
  message: "",
  ok: false,
  recovered: false,
  stopped: false,
};

// PROBLEM_MS is how long a toast about something wrong stays up: twice Obsidian's default, since
// reading a failure once rarely tells you what to do about it.
export const PROBLEM_MS = 10_000;

// ROUTINE_MS is how long a toast about ordinary progress stays up, matching Obsidian's own default
// so geode's routine toasts behave like every other plugin's.
export const ROUTINE_MS = 5_000;

// STICKY is the duration Obsidian reads as "stay on screen until the user dismisses it", and is
// spent on the one occasion where nothing will happen again until a person acts.
export const STICKY = 0;

// Occasion is everything that can earn a toast. Anything not on this list is silent by
// construction, which is the point of routing every notice through one function.
export type Occasion =
  | { kind: "pass"; pass: Pass }
  | { kind: "paused" }
  | { kind: "resumed" }
  | { kind: "settingsSaved" };

// Pass is what one finished sync pass tells the table, including the two things only the caller
// knows: whether anyone asked for it, and whether it followed a failure.
export type Pass = {
  // blocked is whether the pass stopped to ask about a mass change, which a dialog is already
  // asking about on screen.
  blocked: boolean;
  // changes is how many actions the pass applied.
  changes: number;
  // conflicts is how many local files it moved aside as conflict copies.
  conflicts: number;
  // manual is whether someone asked for this pass rather than the scheduler.
  manual: boolean;
  // message is why the pass failed, empty when it did not.
  message: string;
  ok: boolean;
  // recovered is whether this pass followed at least one failed one.
  recovered: boolean;
  // stopped is whether automatic sync has halted until a person acts.
  stopped: boolean;
};

// Toast is one notice to put on screen, already worded and timed.
export type Toast = { durationMs: number; text: string };

// toastFor returns the notice occasion earns, or null when it earns silence.
export function toastFor(occasion: Occasion): Toast | null {
  if (occasion.kind === "pass") {
    return passToast(occasion.pass);
  }
  if (occasion.kind === "paused") {
    return { durationMs: ROUTINE_MS, text: "Geode: automatic sync paused on this device" };
  }
  if (occasion.kind === "resumed") {
    return { durationMs: ROUTINE_MS, text: "Geode: automatic sync resumed on this device" };
  }

  return { durationMs: ROUTINE_MS, text: "Geode: settings saved" };
}

// changes returns count with the right noun.
function changes(count: number): string {
  if (count === 1) {
    return "1 change";
  }

  return `${count} changes`;
}

// files returns count with the right noun.
function files(count: number): string {
  if (count === 1) {
    return "1 file";
  }

  return `${count} files`;
}

// passToast returns what a finished pass earns, worst news first: a halt outranks a failure, and a
// conflict outranks the change count it arrived with.
function passToast(pass: Pass): Toast | null {
  if (!pass.ok) {
    // The mass change dialog is already on screen saying all of this at length, so the toast is
    // here for the person who dismissed it and would otherwise watch sync quietly stay dead.
    if (pass.blocked) {
      return {
        durationMs: PROBLEM_MS,
        text: "Geode is waiting for you to confirm a large change; nothing has synced",
      };
    }
    if (pass.stopped) {
      return { durationMs: STICKY, text: `Geode has stopped syncing: ${pass.message}` };
    }
    // A pass can fail in a way nothing anticipated, and a toast reading "Geode: " helps nobody.
    if (pass.message === "") {
      return { durationMs: PROBLEM_MS, text: "Geode: sync failed" };
    }

    return { durationMs: PROBLEM_MS, text: `Geode: ${pass.message}` };
  }
  if (pass.conflicts > 0) {
    return {
      durationMs: PROBLEM_MS,
      text:
        `Geode found a conflict in ${files(pass.conflicts)}; your copy was kept beside ` +
        "the remote one",
    };
  }
  if (pass.changes > 0) {
    return { durationMs: ROUTINE_MS, text: `Geode: synced, ${changes(pass.changes)} applied` };
  }
  if (pass.manual) {
    return { durationMs: ROUTINE_MS, text: "Geode: already up to date" };
  }
  // An automatic pass that finds nothing is the whole product working, and there is one every few
  // minutes forever, so it is the one thing left that says nothing at all.
  if (pass.recovered) {
    return { durationMs: ROUTINE_MS, text: "Geode: syncing again" };
  }

  return null;
}

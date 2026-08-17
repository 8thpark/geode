// Deciding what the status bar says, kept apart from putting it on screen: every state below is one
// row of a table, so the wording is pinned by a test rather than assembled inside the plugin class.
// The case for each row is in docs/technical_plugin.md.

// DEFAULT_STATUS is the complete zero value: resting, nothing wrong, never synced, nothing in
// flight.
export const DEFAULT_STATUS: Status = {
  detail: "",
  kind: "idle",
  lastSyncedAt: 0,
  progress: null,
};

// LAST_SYNCED_KEY is where the time of the last completed pass is kept: vault scoped localStorage,
// not data.json, since when this device last synced is a fact about this device rather than
// something every device should inherit.
export const LAST_SYNCED_KEY = "geode-last-synced-at";

// DAY_MS, HOUR_MS, and MINUTE_MS are the three thresholds a relative time steps through; a fourth
// unit would mean weeks, and "synced 2w ago" is a sentence nobody should read from a sync tool.
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// Kind is what the status bar is currently reflecting: the two resting states, the one in flight,
// and the one that needs answering.
export type Kind = "error" | "idle" | "paused" | "syncing";

// Progress is how far through its plan a running pass has got, counted in actions.
export type Progress = { done: number; total: number };

// Status is everything the status bar reflects, held as data so the plugin never has to remember
// which of several fields it last wrote.
export type Status = {
  // detail is why the last pass failed, empty when nothing did.
  detail: string;
  kind: Kind;
  // lastSyncedAt is when a pass last completed, zero if none ever has on this device.
  lastSyncedAt: number;
  // progress is null until a pass knows what it is about to do, which is most of a long first sync.
  progress: Progress | null;
};

// View is one rendered status bar item: the icon, the text beside it, and the hover text.
export type View = { icon: string; label: string; tooltip: string };

// agoLabel returns how long ago then was in the coarsest unit that still answers the question, and
// treats a future timestamp as now, since a clock that moved backwards is not worth a case.
export function agoLabel(then: number, now: number): string {
  const elapsed = now - then;
  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }

  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

// lastSyncedFrom returns the time held in a stored value, reading anything that is not a positive
// number as never, so an absent or damaged one says "not synced yet" rather than lying about a
// date.
export function lastSyncedFrom(stored: unknown): number {
  if (typeof stored === "number" && stored > 0) {
    return stored;
  }

  return 0;
}

// noteKind moves the status bar to kind, dropping any count with it: a count belongs to the pass
// that reported it, and one left behind would describe a pass that has already ended.
export function noteKind(status: Status, kind: Kind, detail: string): Status {
  return { ...status, detail, kind, progress: null };
}

// noteProgress records how far through its plan the running pass has got.
export function noteProgress(status: Status, done: number, total: number): Status {
  return { ...status, progress: { done, total } };
}

// noteSynced records a pass completing, which is the one event the resting label is about.
export function noteSynced(status: Status, at: number): Status {
  return { ...status, lastSyncedAt: at };
}

// noteUnsynced forgets when this device last synced, for a vault repointed at a bucket it has never
// synced: the old time is then about somewhere else, and a confident wrong answer is the worst one.
export function noteUnsynced(status: Status): Status {
  return { ...status, lastSyncedAt: 0 };
}

// view returns what the status bar shows for status at now.
export function view(status: Status, now: number): View {
  return {
    icon: iconFor(status.kind),
    label: labelFor(status, now),
    tooltip: tooltipFor(status, now),
  };
}

// iconFor returns the status bar icon for kind.
function iconFor(kind: Kind): string {
  if (kind === "syncing") {
    return "refresh-cw";
  }
  if (kind === "error") {
    return "cloud-alert";
  }
  if (kind === "paused") {
    return "cloud-off";
  }

  return "cloud";
}

// labelFor returns the text beside the icon, which is the whole of what someone reads without
// hovering, and on a phone the whole of what they can read at all.
function labelFor(status: Status, now: number): string {
  if (status.kind === "syncing") {
    if (status.progress === null || status.progress.total === 0) {
      return "Checking...";
    }

    return `Syncing ${status.progress.done}/${status.progress.total}`;
  }
  if (status.kind === "error") {
    return "Sync failed";
  }
  if (status.kind === "paused") {
    return "Sync paused";
  }
  if (status.lastSyncedAt === 0) {
    return "Not synced yet";
  }

  return `Synced ${agoLabel(status.lastSyncedAt, now)}`;
}

// sinceClause returns the trailing ", last synced ..." a state carries when the news it leads with
// is something other than the time, and nothing at all before the first pass has ever landed.
function sinceClause(status: Status, now: number): string {
  if (status.lastSyncedAt === 0) {
    return "";
  }

  return `, last synced ${agoLabel(status.lastSyncedAt, now)}`;
}

// tooltipFor returns the hover text, which says the same thing as the label plus the part that does
// not fit: the failure, or how a click behaves in this state.
function tooltipFor(status: Status, now: number): string {
  if (status.kind === "syncing") {
    if (status.progress === null || status.progress.total === 0) {
      return "Geode: checking for changes";
    }
    const { done, total } = status.progress;

    return `Geode: syncing, ${done} of ${total} changes applied`;
  }
  if (status.kind === "error") {
    // A pass can fail in a way nothing anticipated, and a tooltip reading "Geode: " helps nobody.
    if (status.detail === "") {
      return `Geode: sync failed${sinceClause(status, now)}`;
    }

    return `Geode: ${status.detail}${sinceClause(status, now)}`;
  }
  if (status.kind === "paused") {
    return `Geode: automatic sync paused${sinceClause(status, now)}; click to sync once`;
  }
  if (status.lastSyncedAt === 0) {
    return "Geode: not synced yet; click to sync";
  }

  return `Geode: last synced ${agoLabel(status.lastSyncedAt, now)}; click to sync`;
}

import { byPath, type Snapshot } from "../vault/vault.ts";
import type { SyncAction } from "./plan.ts";

// DESTRUCTIVE_CEILING is the most files one pass may destroy without asking, whatever the size of
// the vault: past this the ratio alone would wave through thousands.
export const DESTRUCTIVE_CEILING = 50;

// DESTRUCTIVE_FLOOR is the point below which a pass never asks, since a prompt over a handful of
// deleted notes is noise, and a guard people learn to dismiss guards nothing.
export const DESTRUCTIVE_FLOOR = 10;

// DESTRUCTIVE_RATIO is the share of tracked files one pass may destroy before it stops to ask; see
// docs/technical_sync.md for why a share alone is not enough.
export const DESTRUCTIVE_RATIO = 0.2;

// DestructiveKind is what a pass would do to one file that cannot simply be undone by syncing
// again.
export type DestructiveKind = "localDelete" | "localOverwrite" | "remoteDelete";

// DestructivePath is one file a pass would destroy, and what would happen to it.
export type DestructivePath = { kind: DestructiveKind; path: string };

// MassChange is how much of a vault one pass would destroy, counted per side so a prompt can say
// what it would do rather than only how much.
export type MassChange = {
  localDeletes: number;
  localOverwrites: number;
  paths: DestructivePath[];
  remoteDeletes: number;
  tracked: number;
};

// MassChangeCopy is what the confirmation dialog says: what the pass would do, what of it can be
// undone, and what happens while nobody answers.
export type MassChangeCopy = { halted: string; lead: string; note: string };

// destructiveLabel returns the verb shown beside a path in the confirmation dialog.
export function destructiveLabel(kind: DestructiveKind): string {
  if (kind === "localDelete") {
    return "delete";
  }
  if (kind === "localOverwrite") {
    return "replace";
  }

  return "remove from bucket";
}

// massChangeCopy returns what the dialog says about a halted pass, kept here rather than in the
// modal so the wording of every branch is pinned by a test.
export function massChangeCopy(change: MassChange): MassChangeCopy {
  const parts: string[] = [];
  if (change.localDeletes > 0) {
    parts.push(`delete ${files(change.localDeletes)} from this vault`);
  }
  if (change.localOverwrites > 0) {
    parts.push(`replace ${files(change.localOverwrites)} here with the version from your bucket`);
  }
  if (change.remoteDeletes > 0) {
    parts.push(`remove ${files(change.remoteDeletes)} from your bucket`);
  }

  const lead =
    `Syncing now would ${phrase(parts)}. That is more of this vault than Geode will ` +
    "change without asking.";

  return {
    halted: "Nothing has changed yet, and automatic sync stays off until you answer this.",
    lead,
    note: note(change),
  };
}

// massChangeFor counts what a plan would destroy: a delete on either side, or a pull landing on a
// file that already exists here. A conflict copy and a plain addition destroy nothing.
export function massChangeFor(actions: SyncAction[], local: Snapshot, tracked: number): MassChange {
  const localByPath = byPath(local.files);
  const change: MassChange = {
    localDeletes: 0,
    localOverwrites: 0,
    paths: [],
    remoteDeletes: 0,
    tracked,
  };

  for (const action of actions) {
    if (action.kind === "pullDelete") {
      change.localDeletes += 1;
      change.paths.push({ kind: "localDelete", path: action.path });
      continue;
    }
    if (action.kind === "pull" && localByPath.has(action.path)) {
      change.localOverwrites += 1;
      change.paths.push({ kind: "localOverwrite", path: action.path });
      continue;
    }
    if (action.kind === "pushDelete") {
      change.remoteDeletes += 1;
      change.paths.push({ kind: "remoteDelete", path: action.path });
    }
  }

  return change;
}

// massChangeHalts reports whether a pass must stop and ask before it touches anything.
export function massChangeHalts(change: MassChange): boolean {
  return change.paths.length > massChangeThreshold(change.tracked);
}

// massChangeThreshold returns how many files a pass may destroy unasked in a vault of this size:
// a share of it, never fewer than the floor, never more than the ceiling.
export function massChangeThreshold(tracked: number): number {
  const share = Math.floor(tracked * DESTRUCTIVE_RATIO);
  if (share < DESTRUCTIVE_FLOOR) {
    return DESTRUCTIVE_FLOOR;
  }
  if (share > DESTRUCTIVE_CEILING) {
    return DESTRUCTIVE_CEILING;
  }

  return share;
}

// files renders a file count with its noun, since a dialog read once should not make anyone parse
// "file(s)".
function files(count: number): string {
  if (count === 1) {
    return "1 file";
  }

  return `${count} files`;
}

// note returns the line about what can be undone, which is the part nobody can guess: a deleted
// file is in the trash, an overwritten one is simply gone.
function note(change: MassChange): string {
  if (change.localOverwrites > 0 && change.localDeletes > 0) {
    return (
      "Deleted files go to your trash, but replaced files do not: the version in this vault is " +
      "lost."
    );
  }
  if (change.localOverwrites > 0) {
    return "A replaced file does not go to your trash: the version in this vault is lost.";
  }
  if (change.localDeletes > 0) {
    return "Deleted files go to your trash, so this is recoverable if it turns out to be wrong.";
  }

  return "Nothing in this vault is touched; this only changes what your bucket holds.";
}

// phrase joins what a pass would do into one readable clause, since the dialog reads it as a
// sentence rather than a list.
function phrase(parts: string[]): string {
  if (parts.length === 0) {
    return "destroy nothing";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }

  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

import type { PutCondition, StorageClient } from "../storage/storage.ts";
import {
  byPath,
  type FileState,
  isSnapshot,
  type Reader,
  type Snapshot,
  takeSnapshot,
} from "../vault/vault.ts";
import { executeSyncPlan, type LocalWriter, type SyncFailure } from "./execute.ts";
import { MANIFEST_KEY, manifestAfterSync, planSync } from "./plan.ts";

// SyncOutcome is the result of a single sync pass. On success it carries the new snapshot to
// persist as the next sync's starting point and how many actions were applied; on failure it
// carries a short user facing message and any per file failures for logging.
export type SyncOutcome =
  | { ok: true; snapshot: Snapshot; changeCount: number }
  | { ok: false; message: string; failures: SyncFailure[] };

// adoptLiveStats returns manifest with each entry swapped for the live vault's entry at the same
// path wherever the content hashes match, so state.json carries local size and mtime and the next
// snapshot can stat-skip the rehash. An entry whose live content differs (a mid sync edit) and a
// live file the manifest doesn't know (a mid sync creation) both keep the manifest's view, so the
// next sync's diff picks them up as local changes. Exported for its tests; syncOnce is the only
// production caller.
export function adoptLiveStats(manifest: Snapshot, live: Snapshot): Snapshot {
  const liveByPath = byPath(live.files);
  const files: FileState[] = [];
  for (const entry of manifest.files) {
    const liveEntry = liveByPath.get(entry.path);
    if (liveEntry !== undefined && liveEntry.hash === entry.hash) {
      files.push(liveEntry);
      continue;
    }
    files.push(entry);
  }

  return { files };
}

// readRemoteManifest fetches and parses the remote manifest. A confirmed 404 means no manifest
// has ever been written, the safe assumption for a first sync against an empty bucket, so that's
// treated as an empty snapshot flagged firstSync. Any other failure (network, auth, a real 5xx)
// is reported as an error rather than ever guessed at as "remote is empty" — getting that guess
// wrong would look exactly like every previously known remote file had just been deleted.
//
// firstSync distinguishes "no manifest has ever been written" from "a manifest exists and is
// genuinely empty": syncOnce must ignore the local ancestor in the former (nothing has ever been
// synced, so state.json cannot be a valid common ancestor) but trust it in the latter (an empty
// remote that a prior sync really produced, where a local file absent from it was deleted).
//
// etag rides along with an existing manifest so syncOnce can make its manifest upload conditional
// on the remote still being exactly this version, the guard against two devices syncing at
// overlapping times (#83).
export async function readRemoteManifest(
  storage: StorageClient,
): Promise<
  | { ok: true; snapshot: Snapshot; firstSync: true }
  | { ok: true; snapshot: Snapshot; firstSync: false; etag: string }
  | { ok: false; message: string }
> {
  const fetched = await storage.getObject(MANIFEST_KEY);

  if (fetched.ok && fetched.body !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(fetched.body));
    } catch {
      return { ok: false, message: "remote manifest is corrupt" };
    }
    if (!isSnapshot(parsed)) {
      return { ok: false, message: "remote manifest is corrupt" };
    }
    // Every S3 compatible server returns an ETag on a successful read; without one (a stripping
    // proxy, a broken provider) the manifest upload can't be made conditional, and uploading it
    // unconditionally is exactly the concurrent clobber #83 fixed, so refuse rather than sync
    // unsafely.
    if (fetched.etag === null) {
      return { ok: false, message: "remote manifest has no etag" };
    }
    return { ok: true, snapshot: parsed, firstSync: false, etag: fetched.etag };
  }

  // TODO(#41): GetResult conflates 404 with every other failure; swap this for a real status
  // once that's fixed, rather than sniffing the message text for a status code.
  if (fetched.message.includes("(404)")) {
    return { ok: true, snapshot: { files: [] }, firstSync: true };
  }
  return { ok: false, message: fetched.message };
}

// syncOnce runs one full sync pass over the injected local vault (reader/localWriter) and remote
// bucket (storage): it snapshots the local vault against previous (the last synced snapshot),
// reads the remote manifest, plans and executes the reconciliation, then uploads a manifest
// reflecting what the bucket now actually holds. previous is passed in and the new
// snapshot returned rather than read or written internally, so the caller owns persistence (the
// plugin through state.json, tests through their own store) and this stays pure over its inputs.
// now is injected so a conflict copy's name is deterministic under test.
export async function syncOnce(
  previous: Snapshot,
  reader: Reader,
  localWriter: LocalWriter,
  storage: StorageClient,
  now: number,
): Promise<SyncOutcome> {
  const remote = await readRemoteManifest(storage);
  if (!remote.ok) {
    return { ok: false, message: remote.message, failures: [] };
  }

  // No remote manifest means no prior sync ever completed against this bucket, so previous (the
  // local state.json) cannot be a valid common ancestor: an upgrader's stale state, written by an
  // older build on every file event rather than only on completed syncs, would diff against the
  // empty remote as "every file deleted remotely" and pullDelete the whole vault. Dropping the
  // ancestor on a first sync reduces it to a clean push of whatever is local, with nothing to lose.
  let ancestor = previous;
  if (remote.firstSync) {
    ancestor = { files: [] };
  }

  const local = await takeSnapshot(reader, ancestor);

  const actions = planSync(ancestor, local, remote.snapshot);
  const failures = await executeSyncPlan(actions, local, reader, localWriter, storage, now);
  if (failures.length > 0) {
    return { ok: false, message: `${failures.length} file(s) failed to sync`, failures };
  }

  // The manifest is derived from what the plan just did to the bucket, never from a fresh disk
  // snapshot: a file edited while the plan ran would land in a re-snapshot claiming content the
  // bucket never received, the edit would then never upload (state.json already agrees with the
  // manifest), and another device could later push the stale bucket copy back over it (#84). The
  // re-snapshot here only refreshes stats, so a mid sync edit keeps its bucket entry and reads as
  // a local change on the next pass.
  const manifest = manifestAfterSync(local, remote.snapshot, actions, now);
  const final = adoptLiveStats(manifest, await takeSnapshot(reader, local));
  const manifestBody = new TextEncoder().encode(JSON.stringify(final));

  // The upload is conditional on the remote manifest still being exactly what this pass read at
  // the start (or still absent, on a first sync). An unconditional put would last-writer-win
  // against a device syncing at overlapping times, and the loser's pushes would then read as
  // remote deletions on the winner's next sync: files silently deleted (#83). Losing the race
  // fails this pass loudly instead; state.json doesn't advance, and the next sync re-reads the
  // fresh manifest and reconciles both devices' work with nothing lost.
  let condition: PutCondition = { kind: "ifAbsent" };
  if (!remote.firstSync) {
    condition = { kind: "ifMatch", etag: remote.etag };
  }
  const uploaded = await storage.putObject(MANIFEST_KEY, manifestBody, condition);
  if (!uploaded.ok) {
    if (uploaded.status === "conflict") {
      return {
        ok: false,
        message: "another device synced at the same time; sync again",
        failures: [],
      };
    }
    return { ok: false, message: uploaded.message, failures: [] };
  }

  return { ok: true, snapshot: final, changeCount: actions.length };
}

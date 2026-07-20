import type { StorageClient } from "../storage/storage.ts";
import { isSnapshot, type Reader, type Snapshot, takeSnapshot } from "../vault/vault.ts";
import { executeSyncPlan, type LocalWriter, type SyncFailure } from "./execute.ts";
import { MANIFEST_KEY, planSync } from "./plan.ts";

// SyncOutcome is the result of a single sync pass. On success it carries the new snapshot to
// persist as the next sync's starting point and how many actions were applied; on failure it
// carries a short user facing message and any per file failures for logging.
export type SyncOutcome =
  | { ok: true; snapshot: Snapshot; changeCount: number }
  | { ok: false; message: string; failures: SyncFailure[] };

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
export async function readRemoteManifest(
  storage: StorageClient,
): Promise<{ ok: true; snapshot: Snapshot; firstSync: boolean } | { ok: false; message: string }> {
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
    return { ok: true, snapshot: parsed, firstSync: false };
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
// reads the remote manifest, plans and executes the reconciliation, then re-snapshots and uploads
// the manifest so it always matches what is really on disk. previous is passed in and the new
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
  const failures = await executeSyncPlan(actions, reader, localWriter, storage, now);
  if (failures.length > 0) {
    return { ok: false, message: `${failures.length} file(s) failed to sync`, failures };
  }

  // Re-snapshot rather than hand merging local with the plan's outcome: this is the only way to
  // be sure the manifest we upload matches what's really on disk after every pull, delete, and
  // conflict rename just applied.
  const final = await takeSnapshot(reader, local);
  const manifestBody = new TextEncoder().encode(JSON.stringify(final));
  const uploaded = await storage.putObject(MANIFEST_KEY, manifestBody);
  if (!uploaded.ok) {
    return { ok: false, message: uploaded.message, failures: [] };
  }

  return { ok: true, snapshot: final, changeCount: actions.length };
}

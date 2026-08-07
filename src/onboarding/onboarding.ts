import type { StorageClient } from "../storage/storage.ts";
import { resolveVaultIdentity } from "../sync/plan.ts";
import { readRemoteManifest, readSentinel, type SyncFault } from "../sync/sync.ts";

// DONE_STEPS is what a user needs to know once a first sync has landed, and is the only place
// geode explains how it behaves; said before a sync has run it would be noise.
export const DONE_STEPS = [
  "Geode now syncs on its own: edits go up a few seconds after you stop typing, and it checks " +
    "for remote changes every 5 minutes.",
  "The cloud icon in the status bar is the whole status. Click it to sync right now.",
  'Run "Geode: Logs" from the command palette to see everything it has done.',
];

// Copy is what the dialog says about a preview: one lead paragraph, then any cautions that follow
// the counts.
export type Copy = { caution: string[]; lead: string };

// Counts is how a first sync would split the two sides, counted by path alone: no file is hashed,
// so shared means a path exists on both sides, never that the two copies differ.
export type Counts = { download: number; shared: number; upload: number };

// Preview is what a first sync against this bucket would do, and is everything the dialog needs to
// decide what to say; see docs/technical_plugin.md.
export type Preview =
  | { kind: "push"; upload: number }
  | { kind: "pull"; download: number }
  | { kind: "merge"; counts: Counts }
  | { kind: "blocked"; message: string }
  | { kind: "unreachable"; message: string };

// RemoteRead is what the bucket said when the preview asked, kept apart from the judgement made
// about it so every branch of previewFor stays a pure table case.
export type RemoteRead =
  | { kind: "fresh" }
  | { kind: "vault"; paths: string[] }
  | { kind: "blocked"; message: string }
  | { kind: "unreachable"; message: string };

// Stage is where the dialog has got to, and is the only state it holds.
export type Stage =
  | { kind: "checking" }
  | { kind: "preview"; preview: Preview }
  | { kind: "syncing" }
  | { kind: "done"; changeCount: number }
  | { kind: "failed"; message: string };

// SyncReport is what one pass tells a caller that has to say more about it than the status bar's
// icon can.
export type SyncReport = { ok: true; changeCount: number } | { ok: false; message: string };

// copyFor returns what the dialog says about preview, kept here rather than in the modal so the
// wording of every branch is pinned by a test.
export function copyFor(preview: Preview): Copy {
  if (preview.kind === "push") {
    if (preview.upload === 0) {
      return {
        caution: [],
        lead:
          "This bucket is empty, and so is this vault. Syncing now claims the bucket, so the " +
          "next device you connect syncs into it.",
      };
    }
    return {
      caution: [],
      lead:
        `This bucket is empty. ${files(preview.upload)} will be uploaded, and this vault ` +
        "becomes the copy every other device syncs from.",
    };
  }

  if (preview.kind === "pull") {
    return {
      caution: [],
      lead:
        `This bucket already holds a vault. ${files(preview.download)} will be downloaded into ` +
        "this empty vault, and nothing here is overwritten.",
    };
  }

  if (preview.kind === "merge") {
    const caution: string[] = [];
    if (preview.counts.shared > 0) {
      caution.push(
        `Back up this vault first if the ${files(preview.counts.shared)} on both sides matter.`,
      );
    }
    return {
      caution,
      lead:
        "Both sides have files, so geode will merge them. Nothing is deleted: where a file " +
        "differs on both sides the remote copy takes the name, and yours is kept beside it as a " +
        "conflict copy.",
    };
  }

  if (preview.kind === "blocked") {
    return {
      caution: ["Nothing has been written to the bucket. Fix this in settings, then try again."],
      lead: `Geode won't sync here: ${preview.message}.`,
    };
  }

  return { caution: [], lead: `Could not read the bucket: ${preview.message}.` };
}

// countsFor splits two path lists into what a first sync would upload, download, and find waiting
// on both sides.
export function countsFor(localPaths: string[], remotePaths: string[]): Counts {
  const local = new Set(localPaths);
  const remote = new Set(remotePaths);

  let shared = 0;
  let upload = 0;
  for (const path of local) {
    if (remote.has(path)) {
      shared += 1;
      continue;
    }
    upload += 1;
  }

  let download = 0;
  for (const path of remote) {
    if (local.has(path)) {
      continue;
    }
    download += 1;
  }

  return { download, shared, upload };
}

// doneLead returns the one line summary of a completed first sync.
export function doneLead(changeCount: number): string {
  if (changeCount === 0) {
    return "Synced. Nothing needed moving, and this bucket now belongs to this vault.";
  }
  if (changeCount === 1) {
    return "Synced. 1 change applied.";
  }

  return `Synced. ${changeCount} changes applied.`;
}

// previewFor turns what the bucket said, and what is on disk, into what a first sync would do.
export function previewFor(localPaths: string[], remote: RemoteRead): Preview {
  if (remote.kind === "fresh") {
    return { kind: "push", upload: localPaths.length };
  }
  if (remote.kind === "vault") {
    if (localPaths.length === 0) {
      return { kind: "pull", download: remote.paths.length };
    }
    return { kind: "merge", counts: countsFor(localPaths, remote.paths) };
  }
  if (remote.kind === "blocked") {
    return { kind: "blocked", message: remote.message };
  }

  return { kind: "unreachable", message: remote.message };
}

// readRemote asks the bucket the two questions a preview is built from, reading only: a preview
// that wrote anything would be the very first sync it exists to ask permission for.
export async function readRemote(
  storage: StorageClient,
  localVaultId: string | undefined,
): Promise<RemoteRead> {
  const [manifest, sentinel] = await Promise.all([
    readRemoteManifest(storage),
    readSentinel(storage),
  ]);
  if (!manifest.ok) {
    return refusal(manifest.fault, manifest.message);
  }
  if (!sentinel.ok) {
    return refusal(sentinel.fault, sentinel.message);
  }

  // The minted ID is discarded, since all the preview asks is whether this pass would be refused
  // for pointing a vault at a bucket that already belongs to a different one.
  const identity = resolveVaultIdentity(
    manifest.firstSync,
    sentinel.sentinel,
    localVaultId,
    () => "",
  );
  if (!identity.ok) {
    return { kind: "blocked", message: identity.message };
  }

  if (manifest.firstSync) {
    return { kind: "fresh" };
  }

  const paths: string[] = [];
  for (const entry of manifest.snapshot.files) {
    paths.push(entry.path);
  }

  return { kind: "vault", paths };
}

// stageForCheck returns where the dialog lands once it knows what both sides hold.
export function stageForCheck(localPaths: string[], remote: RemoteRead): Stage {
  return { kind: "preview", preview: previewFor(localPaths, remote) };
}

// stageForFailedCheck returns where the dialog lands when a preview read throws instead of
// returning a result, which is another way of not knowing and so is offered the same retry.
export function stageForFailedCheck(err: unknown): Stage {
  return { kind: "preview", preview: { kind: "unreachable", message: messageFrom(err) } };
}

// stageForFailedSync returns where the dialog lands when a pass throws past the report it was
// supposed to return.
export function stageForFailedSync(err: unknown): Stage {
  return { kind: "failed", message: messageFrom(err) };
}

// stageForSync returns where the dialog lands once a pass has reported.
export function stageForSync(report: SyncReport): Stage {
  if (!report.ok) {
    return { kind: "failed", message: report.message };
  }

  return { kind: "done", changeCount: report.changeCount };
}

// files renders a file count with its noun, since a dialog read once should not make anyone parse
// "file(s)".
function files(count: number): string {
  if (count === 1) {
    return "1 file";
  }

  return `${count} files`;
}

// messageFrom returns what a thrown value can be shown as, since nothing stops a rejection
// carrying something that is not an Error.
function messageFrom(err: unknown): string {
  if (err instanceof Error && err.message !== "") {
    return err.message;
  }

  return "unexpected error";
}

// refusal maps a failed read onto the two things the dialog can offer: something to go and fix, or
// something to try again.
function refusal(fault: SyncFault, message: string): RemoteRead {
  if (fault === "permanent") {
    return { kind: "blocked", message };
  }

  return { kind: "unreachable", message };
}

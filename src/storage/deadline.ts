import type { HttpResponse, Transport } from "./storage.ts";

// BASE_TIMEOUT_MS is the budget every request gets before any allowance for its body: generous
// enough for a slow provider to answer a listing or a small note, short enough that a stalled
// connection surfaces as an error the user can act on rather than a sync that never ends.
const BASE_TIMEOUT_MS = 60_000;

const BYTES_PER_MB = 1_000_000;

// TIMEOUT_MS_PER_MB extends the budget by a megabyte's worth of upload time so a large attachment
// on a slow uplink is not cut off part way through a transfer that was going to succeed. The
// implied floor is roughly 0.1 MB/s. A single put carries the whole object today, so the allowance
// is what keeps big files syncable until they are uploaded in chunks (#55).
const TIMEOUT_MS_PER_MB = 10_000;

// timeoutFor returns how long a request carrying bytes of body is allowed to take.
export function timeoutFor(bytes: number): number {
  return BASE_TIMEOUT_MS + Math.ceil(bytes / BYTES_PER_MB) * TIMEOUT_MS_PER_MB;
}

// withDeadline sends request through transport and rejects if no response has arrived within ms.
// Obsidian's requestUrl accepts no AbortSignal, so the losing request cannot be cancelled and keeps
// running, detached, until the platform gives up on it; settling the promise is the whole point.
// A dispatch that never settles leaves the plugin's in flight sync guard set forever, so every
// later sync silently no-ops and the status bar sits on "syncing" until Obsidian restarts.
export async function withDeadline(
  transport: Transport,
  request: Request,
  ms: number,
): Promise<HttpResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Promise.race subscribes to both promises, so a transport that rejects after the deadline has
  // already won is still handled and never surfaces as an unhandled rejection.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`request timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });

  try {
    return await Promise.race([transport(request), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

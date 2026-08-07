import type { HttpResponse, Transport } from "./storage.ts";

// BASE_TIMEOUT_MS is the budget every request gets before any allowance for its body: generous
// enough for a slow provider to answer a listing or a small note, short enough that a stalled
// connection surfaces as an error the user can act on rather than a sync that never ends.
const BASE_TIMEOUT_MS = 60_000;

const BYTES_PER_MB = 1_000_000;

// TIMEOUT_MS_PER_MB buys a megabyte's worth of transfer time, an implied floor of roughly
// 0.1 MB/s, so a large attachment on a slow link is not cut off part way through.
const TIMEOUT_MS_PER_MB = 10_000;

// timeoutFor returns how long a request moving bytes of body, in either direction, is allowed to
// take.
export function timeoutFor(bytes: number): number {
  return BASE_TIMEOUT_MS + Math.ceil(bytes / BYTES_PER_MB) * TIMEOUT_MS_PER_MB;
}

// withDeadline rejects if no response arrives within ms. The losing request cannot be cancelled, so
// settling the promise is the whole point.
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

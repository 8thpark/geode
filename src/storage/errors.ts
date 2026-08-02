import type { ResultStatus } from "./storage.ts";

// messageFor turns an error thrown while dispatching a request into an actionable message. Such an
// error means the request never reached the server, so the raw text ("Failed to fetch",
// "net::ERR_NAME_NOT_RESOLVED") names a symptom, not a fix; the guidance points at the usual causes
// while keeping the raw detail for the logs. The plugin dispatches through requestUrl, so a CORS
// block is no longer among those causes (#156).
export function messageFor(err: unknown): string {
  const detail = detailFor(err);
  if (detail === "") {
    return (
      "Couldn't reach the storage endpoint; check your connection and that the endpoint is " +
      "correct"
    );
  }

  return (
    `Couldn't reach the storage endpoint (${detail}); check your connection and that the ` +
    "endpoint is correct"
  );
}

// detailFor extracts the raw message from a caught error, or "" when there is nothing to quote.
function detailFor(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return "";
}

// statusForHttp maps HTTP 400 to the non-retryable client status and preserves known domain
// statuses; unrecognised codes, including 5xx and 429, fall through to retryable server status.
// 409 joins 412 as "conflict": real Amazon S3 returns 409 (rather than 412) when a conditional
// write loses a race against another in-flight write to the same key, so both codes mean the
// same thing to a caller: another writer won, retry the compare-and-swap.
export function statusForHttp(code: number): ResultStatus {
  if (code === 400) {
    return "client";
  }
  if (code === 404) {
    return "not_found";
  }
  if (code === 403 || code === 401) {
    return "auth";
  }
  if (code === 412 || code === 409) {
    return "conflict";
  }
  return "server";
}

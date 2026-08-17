import type { ResultStatus } from "./storage.ts";

// messageFor turns a dispatch error into an actionable message, since such an error means the
// request never reached the server and its raw text names a symptom rather than a fix.
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

// statusForHttp maps an HTTP code onto a result status, treating anything unrecognised as
// retryable. 409 joins 412 as a conflict, since Amazon S3 returns it for a lost conditional write.
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

// detailFor extracts the raw message from a caught error, or "" when there is nothing to quote.
function detailFor(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return "";
}

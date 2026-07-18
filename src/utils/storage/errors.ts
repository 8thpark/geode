import type { ResultStatus } from "../../storage.ts";

// messageFor converts a caught error into a plain message string.
export function messageFor(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return "Network error";
}

// statusForHttp maps an HTTP status code to a ResultStatus. Anything that isn't a recognised 404
// or auth failure (including 5xx and unclassified 4xx such as 429) falls through to "server",
// which callers treat as retryable.
export function statusForHttp(code: number): ResultStatus {
  if (code === 404) {
    return "not_found";
  }
  if (code === 403 || code === 401) {
    return "auth";
  }
  return "server";
}

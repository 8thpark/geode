import type { ResultStatus } from "./storage.ts";

// messageFor converts a caught error into a plain message string.
export function messageFor(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return "Network error";
}

// statusForHttp maps HTTP 400 to the non-retryable client status and preserves known domain
// statuses; unrecognised codes, including 5xx and 429, fall through to retryable server status.
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
  if (code === 412) {
    return "conflict";
  }
  return "server";
}

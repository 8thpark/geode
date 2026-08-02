import assert from "node:assert/strict";
import test from "node:test";
import { messageFor, statusForHttp } from "./errors.ts";
import type { ResultStatus } from "./storage.ts";

test("messageFor: quotes the raw detail from a caught error", () => {
  const message = messageFor(new TypeError("Failed to fetch"));

  assert.match(message, /Couldn't reach the storage endpoint/);
  assert.match(message, /Failed to fetch/);
  assert.match(message, /check your connection/);
});

test("messageFor: still guides when there is nothing to quote", () => {
  const message = messageFor("not an error");

  assert.match(message, /Couldn't reach the storage endpoint/);
  assert.doesNotMatch(message, /\(/);
});

test("statusForHttp: classifies provider responses", () => {
  const cases: { code: number; want: ResultStatus }[] = [
    { code: 400, want: "client" },
    { code: 401, want: "auth" },
    { code: 403, want: "auth" },
    { code: 404, want: "not_found" },
    { code: 409, want: "conflict" },
    { code: 412, want: "conflict" },
    { code: 429, want: "server" },
    { code: 500, want: "server" },
  ];

  for (const tc of cases) {
    assert.equal(statusForHttp(tc.code), tc.want, `HTTP ${tc.code}`);
  }
});

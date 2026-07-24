import assert from "node:assert/strict";
import test from "node:test";
import { statusForHttp } from "./errors.ts";
import type { ResultStatus } from "./storage.ts";

test("statusForHttp: classifies provider responses", () => {
  const cases: { code: number; want: ResultStatus }[] = [
    { code: 400, want: "client" },
    { code: 401, want: "auth" },
    { code: 403, want: "auth" },
    { code: 404, want: "not_found" },
    { code: 412, want: "conflict" },
    { code: 429, want: "server" },
    { code: 500, want: "server" },
  ];

  for (const tc of cases) {
    assert.equal(statusForHttp(tc.code), tc.want, `HTTP ${tc.code}`);
  }
});

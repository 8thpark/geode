import assert from "node:assert/strict";
import test from "node:test";
import { timeoutFor, withDeadline } from "./deadline.ts";
import type { HttpResponse, Transport } from "./storage.ts";

// okResponse is the reply a transport hands back when the request lands, with the fields no test
// here inspects filled in emptily.
const okResponse: HttpResponse = {
  ok: true,
  status: 200,
  body: new Uint8Array(),
  header: () => null,
};

// probe is the signed request the tests dispatch; its contents are irrelevant to the deadline.
function probe(): Request {
  return new Request("https://s3.example.com/vault/k", { method: "GET" });
}

test("withDeadline: hands back the response when the transport answers in time", async () => {
  const transport: Transport = async () => okResponse;

  const response = await withDeadline(transport, probe(), 1_000);

  assert.equal(response.status, 200);
});

test("withDeadline: rejects when the transport never settles", async () => {
  // The wedge this whole module exists for: requestUrl opens a connection, the provider stalls, and
  // the promise is never settled by anyone.
  const transport: Transport = () => new Promise<HttpResponse>(() => {});

  await assert.rejects(withDeadline(transport, probe(), 10), /request timed out after 0s/);
});

test("withDeadline: passes a transport's own rejection through untouched", async () => {
  const transport: Transport = async () => {
    throw new Error("net::ERR_NAME_NOT_RESOLVED");
  };

  await assert.rejects(withDeadline(transport, probe(), 1_000), /ERR_NAME_NOT_RESOLVED/);
});

test("withDeadline: a transport that settles late is still handled, not left unhandled", async () => {
  // Promise.race subscribes to the loser too, so this rejection lands on a handler rather than
  // taking the process down as an unhandled rejection.
  let fail: (err: Error) => void = () => {};
  const transport: Transport = () =>
    new Promise<HttpResponse>((_, reject) => {
      fail = reject;
    });

  await assert.rejects(withDeadline(transport, probe(), 10));
  fail(new Error("arrived after the deadline"));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("timeoutFor: scales the budget with the size of the body", () => {
  const cases: { name: string; bytes: number; want: number }[] = [
    { name: "a bodyless request gets the base budget", bytes: 0, want: 60_000 },
    { name: "a small note rounds up to one megabyte", bytes: 4_000, want: 70_000 },
    { name: "exactly one megabyte stays at one allowance", bytes: 1_000_000, want: 70_000 },
    { name: "a 10 MB attachment gets ten allowances", bytes: 10_000_000, want: 160_000 },
    { name: "a 100 MB attachment gets a hundred", bytes: 100_000_000, want: 1_060_000 },
  ];

  for (const c of cases) {
    assert.equal(timeoutFor(c.bytes), c.want, c.name);
  }
});

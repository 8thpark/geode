import assert from "node:assert/strict";
import test from "node:test";
import type { RequestUrlParam } from "obsidian";
import { nativeRequest, nativeResponse, nativeTransport } from "./native.ts";

test("nativeTransport: converts the request, dispatches it, and converts the response back", async () => {
  const body = new Uint8Array([1, 2, 3]);
  let seen: RequestUrlParam | undefined;
  const dispatch = async (param: RequestUrlParam) => {
    seen = param;
    return {
      status: 200,
      arrayBuffer: body.buffer,
      headers: { etag: '"v1"' },
      json: null,
      text: "",
    };
  };

  const transport = nativeTransport(dispatch);
  const response = await transport(
    new Request("https://s3.example.com/vault/k", {
      method: "PUT",
      headers: { authorization: "sig" },
      body,
    }),
  );

  assert.equal(seen?.method, "PUT");
  assert.equal(seen?.throw, false);
  assert.equal(seen?.headers?.authorization, "sig");
  assert.deepEqual(new Uint8Array(seen?.body as ArrayBuffer), body);
  assert.equal(response.ok, true);
  assert.deepEqual(response.body, body);
  assert.equal(response.header("ETag"), '"v1"');
});

test("nativeRequest: carries the url, method, and every signed header, and disables throw", async () => {
  const request = new Request("https://acc.r2.cloudflarestorage.com/vault/notes/a.md", {
    method: "PUT",
    headers: {
      authorization: "AWS4-HMAC-SHA256 Credential=abc",
      "x-amz-date": "20260730T120000Z",
      "x-amz-content-sha256": "deadbeef",
    },
    body: new Uint8Array([1]),
  });

  const param = await nativeRequest(request);

  assert.equal(param.url, "https://acc.r2.cloudflarestorage.com/vault/notes/a.md");
  assert.equal(param.method, "PUT");
  assert.equal(param.throw, false);
  assert.equal(param.headers?.authorization, "AWS4-HMAC-SHA256 Credential=abc");
  assert.equal(param.headers?.["x-amz-date"], "20260730T120000Z");
  assert.equal(param.headers?.["x-amz-content-sha256"], "deadbeef");
});

test("nativeRequest: a binary body survives as an ArrayBuffer of the same bytes", async () => {
  const body = new Uint8Array([0, 1, 2, 254, 255]);
  const request = new Request("https://s3.example.com/vault/blob", { method: "PUT", body });

  const param = await nativeRequest(request);

  assert.ok(param.body instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(param.body), body);
});

test("nativeRequest: a bodyless request sends no payload at all", async () => {
  for (const method of ["GET", "HEAD", "DELETE"]) {
    const request = new Request("https://s3.example.com/vault/key", { method });

    const param = await nativeRequest(request);

    assert.equal(param.body, undefined, method);
  }
});

test("nativeResponse: classifies the status, treating any 2xx as ok", () => {
  const cases: { status: number; ok: boolean }[] = [
    { status: 200, ok: true },
    { status: 204, ok: true },
    { status: 400, ok: false },
    { status: 403, ok: false },
    { status: 500, ok: false },
  ];

  for (const { status, ok } of cases) {
    const response = nativeResponse({ status, arrayBuffer: new ArrayBuffer(0), headers: {} });
    assert.equal(response.ok, ok, `HTTP ${status}`);
    assert.equal(response.status, status);
  }
});

test("nativeResponse: reads the buffered body into bytes", () => {
  const bytes = new Uint8Array([9, 8, 7]);

  const response = nativeResponse({ status: 200, arrayBuffer: bytes.buffer, headers: {} });

  assert.deepEqual(response.body, bytes);
});

test("nativeResponse: looks a header up case insensitively", () => {
  const response = nativeResponse({
    status: 200,
    arrayBuffer: new ArrayBuffer(0),
    headers: { etag: '"v1"' },
  });

  assert.equal(response.header("ETag"), '"v1"');
  assert.equal(response.header("etag"), '"v1"');
  assert.equal(response.header("missing"), null);
});

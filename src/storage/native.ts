import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { HttpResponse } from "./storage.ts";

// nativeRequest converts a signed request into the parameters for Obsidian's requestUrl, carrying
// the SigV4 Authorization and x-amz-* headers through unchanged so the signature stays valid. throw
// is false so a rejected status comes back as a response for the storage layer to classify, rather
// than throwing and being misread as the request never reaching the server.
export async function nativeRequest(request: Request): Promise<RequestUrlParam> {
  return {
    url: request.url,
    method: request.method,
    headers: headersOf(request),
    body: await bodyOf(request),
    throw: false,
  };
}

// nativeResponse converts a requestUrl response into the HttpResponse the storage layer consumes,
// classifying any 2xx as ok and reading the already buffered body into bytes.
export function nativeResponse(
  response: Pick<RequestUrlResponse, "status" | "arrayBuffer" | "headers">,
): HttpResponse {
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    body: new Uint8Array(response.arrayBuffer),
    header: (name) => headerOf(response.headers, name),
  };
}

// bodyOf reads a signed request's body as an ArrayBuffer for requestUrl, returning undefined for
// the bodyless verbs (GET, HEAD, DELETE, and a copy PUT) so requestUrl sends no payload at all.
async function bodyOf(request: Request): Promise<ArrayBuffer | undefined> {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) {
    return undefined;
  }

  return buffer;
}

// headerOf looks a response header up case insensitively, since requestUrl lowercases the names it
// returns while callers ask for them however they were sent (an "etag" for a server's "ETag").
function headerOf(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key];
    }
  }

  return null;
}

// headersOf flattens a signed request's headers into the plain record requestUrl expects.
function headersOf(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return headers;
}

import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { HttpResponse, Transport } from "./storage.ts";

// Dispatch sends a native request parameter and resolves its response. Obsidian's requestUrl
// satisfies this shape; a test supplies a fake so the whole conversion, dispatch, and response
// mapping can be exercised without a running Obsidian.
export type Dispatch = (param: RequestUrlParam) => Promise<RequestUrlResponse>;

// nativeRequest converts a signed request into requestUrl parameters, carrying every header
// through unchanged so the signature stays valid and letting a rejected status come back as a
// response.
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

// nativeTransport builds a Transport from a dispatcher, holding all the conversion logic here so
// a fake dispatch can exercise it without a running Obsidian.
export function nativeTransport(dispatch: Dispatch): Transport {
  return async (request) => nativeResponse(await dispatch(await nativeRequest(request)));
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

import { requestUrl } from "obsidian";
import type { HttpResponse } from "./storage.ts";

// obsidianTransport dispatches a signed request through Obsidian's requestUrl, which issues a
// native HTTP request outside the browser fetch stack and so is never blocked by CORS. This is the
// transport the plugin uses at runtime; routing through the global fetch instead would make an R2
// or S3 bucket reject the app's origin unless the user hand configured a CORS policy on it (#156).
// throw is false so a rejected status comes back as a response for the storage layer to classify,
// rather than throwing and being misread as the request never reaching the server.
export async function obsidianTransport(request: Request): Promise<HttpResponse> {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: headersOf(request),
    body: await bodyOf(request),
    throw: false,
  });

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

// headersOf flattens a signed request's headers into the plain record requestUrl expects, carrying
// the SigV4 Authorization and x-amz-* headers through unchanged so the signature stays valid.
function headersOf(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return headers;
}

import { requestUrl } from "obsidian";
import { nativeRequest, nativeResponse } from "./native.ts";
import type { HttpResponse } from "./storage.ts";

// obsidianTransport dispatches a signed request through Obsidian's requestUrl, which issues a
// native HTTP request outside the browser fetch stack and so is never blocked by CORS. This is the
// transport the plugin uses at runtime; routing through the global fetch instead would make an R2
// or S3 bucket reject the app's origin unless the user hand configured a CORS policy on it (#156).
// The Request/response conversion lives in the pure native module so it can be tested without a
// running Obsidian; this file is the thin glue that calls requestUrl.
export async function obsidianTransport(request: Request): Promise<HttpResponse> {
  const response = await requestUrl(await nativeRequest(request));

  return nativeResponse(response);
}

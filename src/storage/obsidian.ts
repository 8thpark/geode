import { requestUrl } from "obsidian";
import { nativeTransport } from "./native.ts";

// obsidianTransport dispatches a signed request through Obsidian's requestUrl, which issues a
// native HTTP request outside the browser fetch stack and so is never blocked by CORS. This is the
// transport the plugin uses at runtime; routing through the global fetch instead would make an R2
// or S3 bucket reject the app's origin unless the user hand configured a CORS policy on it (#156).
// All of the conversion and dispatch logic lives in the pure native module and is tested there;
// this file is only the binding of that transport to the real requestUrl.
export const obsidianTransport = nativeTransport(requestUrl);

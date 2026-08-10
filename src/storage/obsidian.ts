import { requestUrl } from "obsidian";
import { nativeTransport } from "./native.ts";

// obsidianTransport binds the native transport to Obsidian's requestUrl, which issues a request
// outside the browser fetch stack and so is never blocked by CORS.
export const obsidianTransport = nativeTransport(requestUrl);

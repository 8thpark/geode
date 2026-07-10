import { AwsClient } from "aws4fetch";
import { endpointFor, type GeodeSettings, regionFor } from "./settings.ts";

// ConnectionResult reports whether a storage provider accepted a test request. Message is the
// empty string when ok is true.
export type ConnectionResult = {
  ok: boolean;
  message: string;
};

// missingFieldFor returns the name of the first field testConnection needs but doesn't have, or
// "" if everything required is present.
function missingFieldFor(settings: GeodeSettings, secretAccessKey: string): string {
  if (settings.bucket === "") {
    return "bucket";
  }
  if (settings.accessKeyId === "") {
    return "access key ID";
  }
  if (secretAccessKey === "") {
    return "secret access key";
  }
  return "";
}

// testConnection sends a signed HEAD request for the configured bucket and reports whether the
// provider accepted the credentials.
export async function testConnection(
  settings: GeodeSettings,
  secretAccessKey: string,
): Promise<ConnectionResult> {
  const missing = missingFieldFor(settings, secretAccessKey);
  if (missing !== "") {
    return { ok: false, message: `Fill in ${missing} first` };
  }

  const client = new AwsClient({
    accessKeyId: settings.accessKeyId,
    secretAccessKey,
    region: regionFor(settings),
    service: "s3",
  });
  const url = `${endpointFor(settings)}/${settings.bucket}`;

  let response: Response;
  try {
    response = await client.fetch(url, { method: "HEAD" });
  } catch (err) {
    if (err instanceof Error) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: "Network error" };
  }

  if (!response.ok) {
    return { ok: false, message: `Storage rejected the request (${response.status})` };
  }
  return { ok: true, message: "" };
}

import { AwsClient } from "aws4fetch";
import { endpointFor, type GeodeSettings, regionFor } from "./settings.ts";
import { encodeKey } from "./utils/storage/encode.ts";
import { messageFor, statusForHttp } from "./utils/storage/errors.ts";
import { parseListObjectsXml } from "./utils/storage/xml.ts";

// ResultStatus classifies the outcome of a storage operation so callers can distinguish absent
// objects from transient failures without parsing the message string.
export type ResultStatus = "ok" | "not_found" | "auth" | "server" | "network";

// ConnectionResult reports whether a storage provider accepted a test request. Message is the
// empty string when ok is true.
export type ConnectionResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// PutResult reports whether an object was written. Message is the empty string when ok is true.
export type PutResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// GetResult reports whether an object was read. Body is null when ok is false.
export type GetResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
  body: Uint8Array | null;
};

// DeleteResult reports whether an object was removed. Message is the empty string when ok is
// true.
export type DeleteResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// ObjectMeta describes one object returned by a bucket listing.
export type ObjectMeta = {
  key: string;
  size: number;
  lastModified: string;
};

// ListResult reports whether a bucket listing succeeded. Objects is empty when ok is false.
export type ListResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
  objects: ObjectMeta[];
};

// StorageClient reads, writes, deletes, and lists objects in a bucket. Every method takes and
// returns plain data, never provider credentials or settings, so a future WebDAV or Dropbox
// client can satisfy this same shape without changing anything that depends on it.
export type StorageClient = {
  putObject: (key: string, body: Uint8Array) => Promise<PutResult>;
  getObject: (key: string) => Promise<GetResult>;
  deleteObject: (key: string) => Promise<DeleteResult>;
  listObjects: (prefix?: string) => Promise<ListResult>;
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
    return { ok: false, status: "auth", message: `Fill in ${missing} first` };
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
    return { ok: false, status: "network", message: messageFor(err) };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: statusForHttp(response.status),
      message: `Storage rejected the request (${response.status})`,
    };
  }
  return { ok: true, status: "ok", message: "" };
}

// s3PutObject writes body to key, creating or overwriting it.
async function s3PutObject(
  client: AwsClient,
  baseUrl: string,
  key: string,
  body: Uint8Array,
): Promise<PutResult> {
  let response: Response;
  try {
    // Uint8Array<ArrayBufferLike> vs DOM's ArrayBufferView<ArrayBuffer> is a TS lib mismatch,
    // not a real runtime issue; every JS engine accepts a Uint8Array as a fetch body.
    response = await client.fetch(`${baseUrl}/${encodeKey(key)}`, {
      method: "PUT",
      body: body as BodyInit,
    });
  } catch (err) {
    return { ok: false, status: "network", message: messageFor(err) };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: statusForHttp(response.status),
      message: `Storage rejected the write (${response.status})`,
    };
  }
  return { ok: true, status: "ok", message: "" };
}

// s3GetObject reads the bytes stored at key.
async function s3GetObject(client: AwsClient, baseUrl: string, key: string): Promise<GetResult> {
  let response: Response;
  try {
    response = await client.fetch(`${baseUrl}/${encodeKey(key)}`, { method: "GET" });
  } catch (err) {
    return { ok: false, status: "network", message: messageFor(err), body: null };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: statusForHttp(response.status),
      message: `Storage rejected the read (${response.status})`,
      body: null,
    };
  }
  const buffer = await response.arrayBuffer();
  return { ok: true, status: "ok", message: "", body: new Uint8Array(buffer) };
}

// s3DeleteObject removes key from the bucket.
async function s3DeleteObject(
  client: AwsClient,
  baseUrl: string,
  key: string,
): Promise<DeleteResult> {
  let response: Response;
  try {
    response = await client.fetch(`${baseUrl}/${encodeKey(key)}`, { method: "DELETE" });
  } catch (err) {
    return { ok: false, status: "network", message: messageFor(err) };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: statusForHttp(response.status),
      message: `Storage rejected the delete (${response.status})`,
    };
  }
  return { ok: true, status: "ok", message: "" };
}

// s3ListObjects lists objects in the bucket, optionally restricted to a key prefix.
async function s3ListObjects(
  client: AwsClient,
  baseUrl: string,
  prefix: string | undefined,
): Promise<ListResult> {
  let url = `${baseUrl}?list-type=2`;
  if (prefix !== undefined && prefix !== "") {
    url += `&prefix=${encodeURIComponent(prefix)}`;
  }

  let response: Response;
  try {
    response = await client.fetch(url, { method: "GET" });
  } catch (err) {
    return { ok: false, status: "network", message: messageFor(err), objects: [] };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: statusForHttp(response.status),
      message: `Storage rejected the list (${response.status})`,
      objects: [],
    };
  }
  const xml = await response.text();
  return { ok: true, status: "ok", message: "", objects: parseListObjectsXml(xml) };
}

// createS3Client returns a StorageClient backed by the S3 compatible endpoint in settings.
export function createS3Client(settings: GeodeSettings, secretAccessKey: string): StorageClient {
  const client = new AwsClient({
    accessKeyId: settings.accessKeyId,
    secretAccessKey,
    region: regionFor(settings),
    service: "s3",
  });
  const baseUrl = `${endpointFor(settings)}/${settings.bucket}`;

  return {
    putObject: (key, body) => s3PutObject(client, baseUrl, key, body),
    getObject: (key) => s3GetObject(client, baseUrl, key),
    deleteObject: (key) => s3DeleteObject(client, baseUrl, key),
    listObjects: (prefix) => s3ListObjects(client, baseUrl, prefix),
  };
}

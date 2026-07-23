import { AwsClient } from "aws4fetch";
import {
  endpointFor,
  type GeodeSettings,
  regionFor,
} from "../settings/settings.ts";
import { encodeKey } from "./encode.ts";
import { messageFor, statusForHttp } from "./errors.ts";
import { parseListObjectsXml } from "./xml.ts";

// ConnectionResult reports whether a storage provider accepted a test request. Message is the
// empty string when ok is true.
export type ConnectionResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// DeleteResult reports whether an object was removed. Message is the empty string when ok is
// true.
export type DeleteResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// GetResult reports whether an object was read. Body is null when ok is false. Etag is the
// object's ETag exactly as the server sent it (quotes included, opaque to us), for handing back
// in a later conditional put; null when ok is false or the server sent none.
export type GetResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
  body: Uint8Array | null;
  etag: string | null;
};

// ListResult reports whether a bucket listing succeeded. Objects is empty when ok is false.
export type ListResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
  objects: ObjectMeta[];
};

// ObjectMeta describes one object returned by a bucket listing.
export type ObjectMeta = {
  key: string;
  size: number;
  lastModified: string;
};

// PutCondition makes a put conditional: "ifMatch" succeeds only while the object's ETag still
// equals etag, "ifAbsent" only while no object exists at the key. A failed precondition comes
// back as a "conflict" status, how a caller detects a concurrent writer instead of silently
// overwriting what that writer just stored.
export type PutCondition =
  | { kind: "ifMatch"; etag: string }
  | { kind: "ifAbsent" };

// PutResult reports whether an object was written. Message is the empty string when ok is true.
export type PutResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// ResultStatus classifies the outcome of a storage operation so callers can distinguish absent
// objects and failed put preconditions from transient failures without parsing the message
// string.
export type ResultStatus =
  | "ok"
  | "not_found"
  | "conflict"
  | "auth"
  | "server"
  | "network";

// StorageClient reads, writes, deletes, and lists objects in a bucket. Every method takes and
// returns plain data, never provider credentials or settings, so a future WebDAV or Dropbox
// client can satisfy this same shape without changing anything that depends on it.
export type StorageClient = {
  putObject: (
    key: string,
    body: Uint8Array,
    condition?: PutCondition,
  ) => Promise<PutResult>;
  getObject: (key: string) => Promise<GetResult>;
  deleteObject: (key: string) => Promise<DeleteResult>;
  listObjects: (prefix?: string) => Promise<ListResult>;
};

// createS3Client returns a StorageClient backed by the S3 compatible endpoint in settings.
export function createS3Client(
  settings: GeodeSettings,
  secretAccessKey: string,
): StorageClient {
  const client = new AwsClient({
    accessKeyId: settings.accessKeyId,
    secretAccessKey,
    region: regionFor(settings),
    service: "s3",
  });
  const baseUrl = `${endpointFor(settings)}/${settings.bucket}`;

  return {
    putObject: (key, body, condition) =>
      s3PutObject(client, baseUrl, key, body, condition),
    getObject: (key) => s3GetObject(client, baseUrl, key),
    deleteObject: (key) => s3DeleteObject(client, baseUrl, key),
    listObjects: (prefix) => s3ListObjects(client, baseUrl, prefix),
  };
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

// conditionHeaders converts a PutCondition into the HTTP precondition headers an S3 compatible
// server evaluates before accepting a write.
function conditionHeaders(
  condition: PutCondition | undefined,
): Record<string, string> {
  if (condition === undefined) {
    return {};
  }
  if (condition.kind === "ifAbsent") {
    return { "If-None-Match": "*" };
  }

  return { "If-Match": condition.etag };
}

// missingFieldFor returns the name of the first field testConnection needs but doesn't have, or
// "" if everything required is present. The requirements mirror hasConnectionConfig: all providers
// need bucket, access key, and secret; R2 derives endpoint and region from the account ID, so
// only custom needs them explicitly.
function missingFieldFor(
  settings: GeodeSettings,
  secretAccessKey: string,
): string {
  if (settings.bucket === "") {
    return "bucket";
  }
  if (settings.accessKeyId === "") {
    return "access key ID";
  }
  if (secretAccessKey === "") {
    return "secret access key";
  }

  if (settings.provider === "r2") {
    if (settings.accountId === "") {
      return "account ID";
    }
  } else {
    if (settings.endpoint === "") {
      return "endpoint";
    }
    if (settings.region === "") {
      return "region";
    }
  }

  return "";
}

// s3DeleteObject removes key from the bucket.
async function s3DeleteObject(
  client: AwsClient,
  baseUrl: string,
  key: string,
): Promise<DeleteResult> {
  let response: Response;
  try {
    response = await client.fetch(`${baseUrl}/${encodeKey(key)}`, {
      method: "DELETE",
    });
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

// s3GetObject reads the bytes stored at key.
async function s3GetObject(
  client: AwsClient,
  baseUrl: string,
  key: string,
): Promise<GetResult> {
  let response: Response;
  try {
    response = await client.fetch(`${baseUrl}/${encodeKey(key)}`, {
      method: "GET",
    });
  } catch (err) {
    return {
      ok: false,
      status: "network",
      message: messageFor(err),
      body: null,
      etag: null,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: statusForHttp(response.status),
      message: `Storage rejected the read (${response.status})`,
      body: null,
      etag: null,
    };
  }
  const buffer = await response.arrayBuffer();
  return {
    ok: true,
    status: "ok",
    message: "",
    body: new Uint8Array(buffer),
    etag: response.headers.get("etag"),
  };
}

// s3ListObjects lists objects in the bucket, optionally restricted to a key prefix. S3 caps a
// single response at 1,000 keys, so it follows NextContinuationToken until the listing is complete
// and returns every key. Stopping early would make unlisted keys look like remote deletions.
async function s3ListObjects(
  client: AwsClient,
  baseUrl: string,
  prefix: string | undefined,
): Promise<ListResult> {
  const objects: ObjectMeta[] = [];
  let continuationToken: string | undefined;

  do {
    let url = `${baseUrl}?list-type=2`;
    if (prefix !== undefined && prefix !== "") {
      url += `&prefix=${encodeURIComponent(prefix)}`;
    }
    if (continuationToken !== undefined) {
      url += `&continuation-token=${encodeURIComponent(continuationToken)}`;
    }

    let response: Response;
    try {
      response = await client.fetch(url, { method: "GET" });
    } catch (err) {
      return {
        ok: false,
        status: "network",
        message: messageFor(err),
        objects: [],
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: statusForHttp(response.status),
        message: `Storage rejected the list (${response.status})`,
        objects: [],
      };
    }

    const page = parseListObjectsXml(await response.text());
    objects.push(...page.objects);
    continuationToken = page.nextContinuationToken;
  } while (continuationToken !== undefined);

  return { ok: true, status: "ok", message: "", objects };
}

// s3PutObject writes body to key, creating or overwriting it. When condition is set, the write
// only lands if its precondition still holds; a 412 from the server surfaces as "conflict".
async function s3PutObject(
  client: AwsClient,
  baseUrl: string,
  key: string,
  body: Uint8Array,
  condition: PutCondition | undefined,
): Promise<PutResult> {
  let response: Response;
  try {
    // Uint8Array<ArrayBufferLike> vs DOM's ArrayBufferView<ArrayBuffer> is a TS lib mismatch,
    // not a real runtime issue; every JS engine accepts a Uint8Array as a fetch body.
    response = await client.fetch(`${baseUrl}/${encodeKey(key)}`, {
      method: "PUT",
      body: body as BodyInit,
      headers: conditionHeaders(condition),
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

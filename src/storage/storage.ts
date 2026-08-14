import { AwsClient } from "aws4fetch";
import {
  accessKeyIdFor,
  accountIdFor,
  bucketFor,
  endpointFor,
  type GeodeSettings,
  isAwsRegion,
  normalizeEndpoint,
  normalizePrefix,
  prefixError,
  regionFor,
} from "../settings/settings.ts";
import { timeoutFor, withDeadline } from "./deadline.ts";
import { encodeComponent, encodeKey } from "./encode.ts";
import { messageFor, statusForHttp } from "./errors.ts";
import { parseListObjectsXml } from "./xml.ts";

// PROBE_KEY_PREFIX keeps the connection test's throwaway object under the reserved prefix, so a
// leftover probe is never pulled to a device as a phantom vault file.
const PROBE_KEY_PREFIX = ".geode/connection-probe-";

// ConnectionResult reports whether a storage provider accepted a test request; message is empty
// when ok is true.
export type ConnectionResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// DeleteResult reports whether an object was removed; message is empty when ok is true.
export type DeleteResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// GetResult reports whether an object was read; body and etag are null when ok is false, and
// etag is otherwise the server's opaque ETag string, unchanged, for handing back in a later
// conditional put.
export type GetResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
  body: Uint8Array | null;
  etag: string | null;
};

// HeadResult reports whether an object exists at a key, without transferring its body; etag
// carries the same meaning as GetResult's.
export type HeadResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
  etag: string | null;
};

// HttpResponse is the normalized reply a Transport returns, so storage operations never touch a
// streaming Response and both transports are interchangeable; header looks a name up case
// insensitively, since the two transports disagree on header casing.
export type HttpResponse = {
  ok: boolean;
  status: number;
  body: Uint8Array;
  header: (name: string) => string | null;
};

// ListResult reports whether a bucket listing succeeded; objects is empty when ok is false.
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

// PutCondition makes a put conditional: "ifMatch" requires the current ETag, "ifAbsent" requires no
// object at the key; a failed precondition surfaces as a "conflict" status rather than silently
// overwriting a concurrent writer.
export type PutCondition = { kind: "ifMatch"; etag: string } | { kind: "ifAbsent" };

// PutResult reports whether an object was written; message is empty when ok is true.
export type PutResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
};

// ResultStatus classifies a storage operation's outcome, so callers can distinguish absent
// objects and failed preconditions from transient failures without parsing the message string.
export type ResultStatus =
  | "ok"
  | "not_found"
  | "conflict"
  | "auth"
  | "client"
  | "server"
  | "network";

// StorageClient reads, writes, deletes, and lists objects, taking and returning plain data so a
// future WebDAV or Dropbox client can satisfy the same shape. Every key is relative to the client's
// own root; see docs/technical_storage.md.
export type StorageClient = {
  putObject: (key: string, body: Uint8Array, condition?: PutCondition) => Promise<PutResult>;
  getObject: (key: string, expectedBytes?: number) => Promise<GetResult>;
  headObject: (key: string) => Promise<HeadResult>;
  deleteObject: (key: string) => Promise<DeleteResult>;
  listObjects: (prefix?: string) => Promise<ListResult>;
};

// Transport sends an already signed request and resolves its response, rejecting only when the
// request never reaches the server; send applies the deadline, so a transport itself need not
// bound its own runtime.
export type Transport = (request: Request) => Promise<HttpResponse>;

// createS3Client returns a StorageClient backed by the S3 compatible endpoint in settings, sending
// every request through the given transport.
export function createS3Client(
  settings: GeodeSettings,
  secretAccessKey: string,
  transport: Transport,
): StorageClient {
  // Settings arrive straight from data.json, which nothing above this client validates, so
  // refusing every operation here is the only way a bad prefix can never sync or address the
  // wrong bucket.
  const badPrefix = prefixError(settings.prefix);
  if (badPrefix !== "") {
    return refusingClient(badPrefix);
  }

  const client = new AwsClient({
    accessKeyId: accessKeyIdFor(settings),
    secretAccessKey,
    region: regionFor(settings),
    service: "s3",
  });
  const baseUrl = `${endpointFor(settings)}/${bucketFor(settings)}`;
  const root = normalizePrefix(settings.prefix);

  return {
    putObject: (key, body, condition) =>
      s3PutObject(client, transport, baseUrl, rootedKey(root, key), body, condition),
    getObject: (key, expectedBytes) =>
      s3GetObject(client, transport, baseUrl, rootedKey(root, key), expectedBytes),
    headObject: (key) => s3HeadObject(client, transport, baseUrl, rootedKey(root, key)),
    deleteObject: (key) => s3DeleteObject(client, transport, baseUrl, rootedKey(root, key)),
    listObjects: (prefix) => rootedList(client, transport, baseUrl, root, prefix),
  };
}

// fetchTransport dispatches a signed request through the global fetch; it is the transport for
// tests and any environment without Obsidian.
export async function fetchTransport(request: Request): Promise<HttpResponse> {
  const response = await fetch(request);
  const buffer = await response.arrayBuffer();

  return {
    ok: response.ok,
    status: response.status,
    body: new Uint8Array(buffer),
    header: (name) => response.headers.get(name),
  };
}

// probeConditionalWrites confirms a provider actually honours the compare and swap sync depends
// on, not merely that it accepts the credentials, deleting its throwaway object best effort when
// done.
export async function probeConditionalWrites(client: StorageClient): Promise<ConnectionResult> {
  const key = `${PROBE_KEY_PREFIX}${crypto.randomUUID()}`;
  const body = new TextEncoder().encode("geode connection probe");

  try {
    const first = await client.putObject(key, body, { kind: "ifAbsent" });
    if (!first.ok) {
      return { ok: false, status: first.status, message: first.message };
    }

    const second = await client.putObject(key, body, { kind: "ifAbsent" });
    if (second.ok) {
      return {
        ok: false,
        status: "client",
        message: "Storage ignored a conditional write, so concurrent edits can be lost",
      };
    }
    if (second.status !== "conflict") {
      return { ok: false, status: second.status, message: second.message };
    }

    const read = await client.getObject(key);
    if (!read.ok) {
      return { ok: false, status: read.status, message: read.message };
    }
    if (read.etag === null) {
      return {
        ok: false,
        status: "client",
        message: "Storage did not return an ETag, which sync needs for conditional writes",
      };
    }

    return { ok: true, status: "ok", message: "" };
  } finally {
    // Best effort: a rejecting cleanup would escape the finally and replace the probe's verdict,
    // so the rejection is swallowed rather than allowed to mask an otherwise successful test.
    await client.deleteObject(key).catch(() => undefined);
  }
}

// testConnection reports whether a storage provider is usable for sync: it must accept the
// credentials and honour the conditional writes probeConditionalWrites checks, since a HEAD alone
// would green-light a provider that silently loses edits under concurrency.
export async function testConnection(
  settings: GeodeSettings,
  secretAccessKey: string,
  transport: Transport,
): Promise<ConnectionResult> {
  const missing = missingFieldFor(settings, secretAccessKey);
  if (missing !== "") {
    return { ok: false, status: "auth", message: `Fill in ${missing} first` };
  }
  const badPrefix = prefixError(settings.prefix);
  if (badPrefix !== "") {
    return { ok: false, status: "client", message: badPrefix };
  }

  const client = new AwsClient({
    accessKeyId: accessKeyIdFor(settings),
    secretAccessKey,
    region: regionFor(settings),
    service: "s3",
  });
  const url = `${endpointFor(settings)}/${bucketFor(settings)}`;

  let response: HttpResponse;
  try {
    response = await send(client, transport, url, { method: "HEAD" });
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

  return probeConditionalWrites(createS3Client(settings, secretAccessKey, transport));
}

// bytesOf reports the size of a request body so its deadline can scale with it; only a put
// carries one.
function bytesOf(init: RequestInit): number {
  if (init.body instanceof Uint8Array) {
    return init.body.byteLength;
  }

  return 0;
}

// conditionHeaders converts a PutCondition into the HTTP precondition headers an S3 compatible
// server evaluates before accepting a write.
function conditionHeaders(condition: PutCondition | undefined): Record<string, string> {
  if (condition === undefined) {
    return {};
  }
  if (condition.kind === "ifAbsent") {
    return { "If-None-Match": "*" };
  }

  return { "If-Match": condition.etag };
}

// missingFieldFor returns the name of the first field testConnection needs but doesn't have, or
// "" when everything required is present; R2 derives endpoint and region from the account ID and
// Amazon S3 from the region, so only MinIO and a custom provider need both explicitly.
function missingFieldFor(settings: GeodeSettings, secretAccessKey: string): string {
  if (bucketFor(settings) === "") {
    return "bucket";
  }
  if (accessKeyIdFor(settings) === "") {
    return "access key ID";
  }
  if (secretAccessKey === "") {
    return "secret access key";
  }

  if (settings.provider === "r2") {
    if (accountIdFor(settings) === "") {
      return "account ID";
    }
    return "";
  }

  if (settings.provider === "custom" || settings.provider === "minio") {
    if (normalizeEndpoint(settings.endpoint) === "") {
      return "endpoint";
    }
  }
  if (regionFor(settings) === "") {
    return "region";
  }
  // Amazon S3 builds its endpoint host from the region, so a region that isn't a real region
  // identifier has no endpoint to sign against and is reported the same as a missing one.
  if (settings.provider === "s3" && !isAwsRegion(regionFor(settings))) {
    return "region (for example us-east-1)";
  }

  return "";
}

// refusingClient returns a StorageClient that fails every operation with the given message, since
// a configuration that could not be trusted to address a request should never attempt one; status
// is "client" because only correcting the setting, never a retry, can help.
function refusingClient(message: string): StorageClient {
  return {
    putObject: async () => ({ ok: false, status: "client", message }),
    getObject: async () => ({ ok: false, status: "client", message, body: null, etag: null }),
    headObject: async () => ({ ok: false, status: "client", message, etag: null }),
    deleteObject: async () => ({ ok: false, status: "client", message }),
    listObjects: async () => ({ ok: false, status: "client", message, objects: [] }),
  };
}

// rootedKey returns the bucket key an object actually lives at for a client rooted at root, so
// the prefix stays hidden from every layer above rather than threaded through sync's key
// constants.
function rootedKey(root: string, key: string): string {
  if (root === "") {
    return key;
  }

  return `${root}/${key}`;
}

// rootedList lists under the client's root and returns keys relative to it, mirroring rootedKey;
// a key that comes back outside the root fails the listing rather than being trusted, since a
// provider answering a different question should not be silently re-sliced into a plausible key.
async function rootedList(
  client: AwsClient,
  transport: Transport,
  baseUrl: string,
  root: string,
  prefix: string | undefined,
): Promise<ListResult> {
  if (root === "") {
    return s3ListObjects(client, transport, baseUrl, prefix);
  }

  let under = `${root}/`;
  if (prefix !== undefined) {
    under += prefix;
  }
  const listed = await s3ListObjects(client, transport, baseUrl, under);
  if (!listed.ok) {
    return listed;
  }

  const objects: ObjectMeta[] = [];
  for (const object of listed.objects) {
    if (!object.key.startsWith(`${root}/`)) {
      return {
        ok: false,
        status: "server",
        message: `Storage listed "${object.key}", which is outside the configured prefix`,
        objects: [],
      };
    }
    objects.push({ ...object, key: object.key.slice(root.length + 1) });
  }

  return { ok: true, status: "ok", message: "", objects };
}

// s3DeleteObject removes key from the bucket.
async function s3DeleteObject(
  client: AwsClient,
  transport: Transport,
  baseUrl: string,
  key: string,
): Promise<DeleteResult> {
  let response: HttpResponse;
  try {
    response = await send(client, transport, `${baseUrl}/${encodeKey(key)}`, {
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

// s3GetObject reads the bytes stored at key; expectedBytes, when known, scales the deadline the
// same way a put's body does, so a large attachment on a slow link is not cut short, defaulting
// to zero (the base budget) for reads with no size to hand.
async function s3GetObject(
  client: AwsClient,
  transport: Transport,
  baseUrl: string,
  key: string,
  expectedBytes = 0,
): Promise<GetResult> {
  let response: HttpResponse;
  try {
    response = await send(
      client,
      transport,
      `${baseUrl}/${encodeKey(key)}`,
      { method: "GET" },
      expectedBytes,
    );
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

  return {
    ok: true,
    status: "ok",
    message: "",
    body: response.body,
    etag: response.header("etag"),
  };
}

// s3HeadObject reports whether key exists without transferring its body, used both to skip
// uploading a blob whose content addressed key already exists and, via its etag, to detect a
// mutable key like the manifest changing without paying for a body transfer.
async function s3HeadObject(
  client: AwsClient,
  transport: Transport,
  baseUrl: string,
  key: string,
): Promise<HeadResult> {
  let response: HttpResponse;
  try {
    response = await send(client, transport, `${baseUrl}/${encodeKey(key)}`, { method: "HEAD" });
  } catch (err) {
    return { ok: false, status: "network", message: messageFor(err), etag: null };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: statusForHttp(response.status),
      message: `Storage rejected the head (${response.status})`,
      etag: null,
    };
  }
  return { ok: true, status: "ok", message: "", etag: response.header("etag") };
}

// s3ListObjects lists objects in the bucket, optionally restricted to a key prefix, following
// NextContinuationToken past S3's 1,000 key page cap since stopping early would read as remote
// deletions.
async function s3ListObjects(
  client: AwsClient,
  transport: Transport,
  baseUrl: string,
  prefix: string | undefined,
): Promise<ListResult> {
  const objects: ObjectMeta[] = [];
  let continuationToken: string | undefined;

  do {
    let url = `${baseUrl}?list-type=2`;
    if (prefix !== undefined && prefix !== "") {
      url += `&prefix=${encodeComponent(prefix)}`;
    }
    if (continuationToken !== undefined) {
      url += `&continuation-token=${encodeComponent(continuationToken)}`;
    }

    let response: HttpResponse;
    try {
      response = await send(client, transport, url, { method: "GET" });
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

    const parsed = parseListObjectsXml(new TextDecoder().decode(response.body));
    if (!parsed.ok) {
      return {
        ok: false,
        status: "server",
        message: parsed.message,
        objects: [],
      };
    }
    objects.push(...parsed.page.objects);
    continuationToken = parsed.page.nextContinuationToken;
  } while (continuationToken !== undefined);

  return { ok: true, status: "ok", message: "", objects };
}

// s3PutObject writes body to key, creating or overwriting it; when condition is set, a losing
// precondition surfaces as "conflict" whether the provider reports it as 412 or 409.
async function s3PutObject(
  client: AwsClient,
  transport: Transport,
  baseUrl: string,
  key: string,
  body: Uint8Array,
  condition: PutCondition | undefined,
): Promise<PutResult> {
  let response: HttpResponse;
  try {
    // Uint8Array<ArrayBufferLike> vs DOM's ArrayBufferView<ArrayBuffer> is a TS lib mismatch,
    // not a real runtime issue; every JS engine accepts a Uint8Array as a fetch body.
    response = await send(client, transport, `${baseUrl}/${encodeKey(key)}`, {
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

// send signs the request, then dispatches it through the transport under a deadline, applied here
// rather than at each transport binding since this is the one dispatch point every storage
// operation goes through.
async function send(
  client: AwsClient,
  transport: Transport,
  url: string,
  init: RequestInit,
  expectedResponseBytes = 0,
): Promise<HttpResponse> {
  const signed = await client.sign(url, init);

  // Only one direction carries bytes at a time (a put streams up, a get streams down), so the
  // deadline scales with whichever transfer is non-empty, keeping neither cut off mid flight.
  const transferBytes = Math.max(bytesOf(init), expectedResponseBytes);

  return withDeadline(transport, signed, timeoutFor(transferBytes));
}

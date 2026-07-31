import { AwsClient } from "aws4fetch";
import { endpointFor, type GeodeSettings, regionFor } from "../settings/settings.ts";
import { timeoutFor, withDeadline } from "./deadline.ts";
import { encodeComponent, encodeKey } from "./encode.ts";
import { messageFor, statusForHttp } from "./errors.ts";
import { parseListObjectsXml } from "./xml.ts";

// PROBE_KEY_PREFIX namespaces testConnection's throwaway probe object under geode's reserved bucket
// prefix (sync's RESERVED_PREFIX). A probe left behind by a failed cleanup therefore sits where
// sync ignores it, never pulled to every device as a phantom vault file.
const PROBE_KEY_PREFIX = ".geode/connection-probe-";

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

// HeadResult reports whether an object exists at a key, without transferring its body. Message is
// the empty string when ok is true. Etag is the object's ETag exactly as the server sent it,
// mirroring GetResult, so a caller can detect the object changing underneath it without paying
// for a body transfer; null when ok is false or the server sent none.
export type HeadResult = {
  ok: boolean;
  status: ResultStatus;
  message: string;
  etag: string | null;
};

// HttpResponse is the normalized reply a Transport returns: the HTTP status and the fully read
// body, so the storage operations never touch a streaming Response and the fetch and requestUrl
// transports are interchangeable behind one shape. Header looks a single response header up by
// name, case insensitively, since the two transports disagree on header name casing.
export type HttpResponse = {
  ok: boolean;
  status: number;
  body: Uint8Array;
  header: (name: string) => string | null;
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
export type PutCondition = { kind: "ifMatch"; etag: string } | { kind: "ifAbsent" };

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
  | "client"
  | "server"
  | "network";

// StorageClient reads, writes, deletes, and lists objects in a bucket. Every method takes and
// returns plain data, never provider credentials or settings, so a future WebDAV or Dropbox
// client can satisfy this same shape without changing anything that depends on it.
export type StorageClient = {
  putObject: (key: string, body: Uint8Array, condition?: PutCondition) => Promise<PutResult>;
  getObject: (key: string, expectedBytes?: number) => Promise<GetResult>;
  headObject: (key: string) => Promise<HeadResult>;
  deleteObject: (key: string) => Promise<DeleteResult>;
  listObjects: (prefix?: string) => Promise<ListResult>;
};

// Transport sends an already signed request and returns its response, rejecting only when the
// request never completes (offline, a failed DNS lookup, a refused connection). A transport need
// not bound its own runtime: send dispatches every request under a deadline, so a stalled
// connection rejects there rather than hanging forever. The plugin injects a transport backed by
// Obsidian's requestUrl, which issues a native request and so is never subject to CORS; tests and
// any non Obsidian caller inject fetchTransport.
export type Transport = (request: Request) => Promise<HttpResponse>;

// createS3Client returns a StorageClient backed by the S3 compatible endpoint in settings, sending
// every request through the given transport.
export function createS3Client(
  settings: GeodeSettings,
  secretAccessKey: string,
  transport: Transport,
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
      s3PutObject(client, transport, baseUrl, key, body, condition),
    getObject: (key, expectedBytes) => s3GetObject(client, transport, baseUrl, key, expectedBytes),
    headObject: (key) => s3HeadObject(client, transport, baseUrl, key),
    deleteObject: (key) => s3DeleteObject(client, transport, baseUrl, key),
    listObjects: (prefix) => s3ListObjects(client, transport, baseUrl, prefix),
  };
}

// fetchTransport dispatches a signed request through the global fetch. It is the transport for
// tests and any environment without Obsidian; the plugin uses a requestUrl backed transport so its
// requests are not subject to CORS.
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

// probeConditionalWrites confirms the provider actually honours the compare-and-swap sync is built
// on, not merely that it accepts the credentials. It writes a throwaway object with If-None-Match:
// *, then issues a second If-None-Match: * write that must be rejected: a provider with no
// conditional-write support (Backblaze B2, Wasabi, Garage) fails the first write, and one that
// accepts the header but ignores it (Google Cloud Storage's S3 interop) lets the second write
// clobber the first, the exact silent data loss the conditional puts exist to prevent. It also
// checks the read hands back an ETag, which sync needs to make later updates conditional. The probe
// object is always deleted, best effort.
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
    // Best effort: the probe already proved what it needed to, and a leftover object lives under
    // the reserved prefix where sync ignores it. A cleanup that rejects would escape the finally
    // and replace the probe's verdict, so the rejection is swallowed rather than allowed to mask
    // an otherwise successful test.
    await client.deleteObject(key).catch(() => undefined);
  }
}

// testConnection reports whether a storage provider is usable for sync: it accepts the credentials
// (a signed HEAD for the bucket) and honours the conditional writes sync's compare-and-swap depends
// on (probeConditionalWrites). Reporting ok on the HEAD alone would green-light providers that
// authenticate fine but silently lose edits under concurrency.
export async function testConnection(
  settings: GeodeSettings,
  secretAccessKey: string,
  transport: Transport,
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

// bytesOf reports the size of a request body so its deadline can scale with it. Only a put carries
// one, and it is always the Uint8Array s3PutObject passes through.
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
// "" if everything required is present. The requirements mirror hasConnectionConfig: all providers
// need bucket, access key, and secret; R2 derives endpoint and region from the account ID, so
// only custom needs them explicitly.
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

// s3GetObject reads the bytes stored at key. expectedBytes is the object's known size from the
// manifest entry the caller is reading against; it scales the deadline the same way a put's body
// does, so a large attachment on a slow link is not cut off part way through the download. It
// defaults to zero for the few reads with no size to hand (the manifest itself), which get the base
// budget.
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

// s3HeadObject reports whether key exists, without transferring the object's body. Used both to
// check for an already stored blob before uploading it (a content addressed key that already
// exists holds, by construction, the exact bytes a caller would otherwise upload, so the upload
// can be skipped entirely) and, via its etag, to detect a mutable key like the manifest changing
// underneath a plan without paying for a body transfer.
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

// s3ListObjects lists objects in the bucket, optionally restricted to a key prefix. S3 caps a
// single response at 1,000 keys, so it follows NextContinuationToken until the listing is complete
// and returns every key. Stopping early would make unlisted keys look like remote deletions.
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

// s3PutObject writes body to key, creating or overwriting it. When condition is set, the write
// only lands if its precondition still holds; a 412, or a 409 from a provider that reports a
// losing race that way, surfaces as "conflict".
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

// send signs the request with the client's credentials, then hands the signed request to the
// transport under a deadline. Signing is environment agnostic (aws4fetch uses WebCrypto); only the
// transport, and so whether the request is subject to CORS, differs between the plugin runtime and
// tests. The deadline is applied here rather than at each transport binding because this is the one
// dispatch point every storage operation goes through, so no future transport can be injected
// without one.
async function send(
  client: AwsClient,
  transport: Transport,
  url: string,
  init: RequestInit,
  expectedResponseBytes = 0,
): Promise<HttpResponse> {
  const signed = await client.sign(url, init);

  // Only one direction ever carries bytes here: a put streams its body up, a get streams the object
  // back down, a copy moves nothing through the client. The deadline scales with whichever transfer
  // is non-empty so neither a large upload nor a large download is cut off mid-flight.
  const transferBytes = Math.max(bytesOf(init), expectedResponseBytes);

  return withDeadline(transport, signed, timeoutFor(transferBytes));
}

<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Storage

Everything Geode puts in your bucket goes through one client and comes back wrapped in one envelope,
so the bucket is uniformly self describing and nothing above the storage layer knows or cares which
provider is underneath. This page covers what the bucket holds, how objects are framed, and what the
client refuses to do.

- [Bucket Layout](#bucket-layout)
- [The Envelope](#the-envelope)
- [Versions And Refusal](#versions-and-refusal)
- [The Manifest](#the-manifest)
- [The Storage Client](#the-storage-client)
- [Prefixes](#prefixes)
- [Conditional Writes](#conditional-writes)
- [Listings](#listings)
- [Deadlines](#deadlines)

### Bucket Layout

Everything Geode writes lives under a single reserved prefix, so nothing it owns can ever be
mistaken for a vault file, even if your vault happens to contain a note at a colliding path. If you
configure a bucket prefix, all of this sits underneath it.

| Key                      | What it holds                                                     |
| ------------------------ | ----------------------------------------------------------------- |
| `.geode/manifest.json`   | The last synced snapshot: every path, and what it points at       |
| `.geode/sentinel.json`   | A marker written once, proving this bucket has been synced before |
| `.geode/blobs/<address>` | One file's content, addressed by its content rather than its path |

One other key can appear under the prefix: `.geode/connection-probe-<uuid>`, written and deleted by
the settings tab's connection test. It holds no vault data, is never read back as vault data, and is
not part of the format below.

A blob is keyed by an address derived from its own bytes, not by the vault path it belongs to. That
is what makes a rename free (the manifest points the new path at the same key), a duplicate
attachment cost one copy, and a delete non destructive: the manifest simply stops naming the
address, and the bytes stay recoverable for as long as any retained manifest still names it.

### The Envelope

Every object above is stored inside the same six byte envelope. A reader can tell what an object is,
and whether it can read it at all, before it parses a single byte of the payload.

| Offset | Bytes | Field   | Value today                    |
| ------ | ----- | ------- | ------------------------------ |
| 0      | 4     | Magic   | `GEOD` (`0x47 0x45 0x4F 0x44`) |
| 4      | 1     | Version | `0x01`                         |
| 5      | 1     | Suite   | `0x00`, plaintext              |
| 6      | rest  | Payload | The object's own bytes         |

The payload runs to the end of the object; S3 already reports where that is, so there is no length
field to keep in step with it.

Version and suite are separate bytes because they change for different reasons. Version describes
the header layout itself. Suite describes what was done to the payload. A new cipher must not have
to burn an envelope version, and a new header field must not invalidate every blob in the bucket.

| Suite  | Meaning                                              | Status                 |
| ------ | ---------------------------------------------------- | ---------------------- |
| `0x00` | Plaintext, the payload exactly as it was handed over | Written and read today |
| Others | Reserved                                             | Encryption, 0.3.0      |

Bytes are never read leniently. A body without a valid header is refused rather than treated as a
bare payload, because the moment a version 2 exists an unversioned object and a version 1 object
would be indistinguishable. The magic tag costs four bytes per object and buys the difference
between "this bucket holds something we did not write" and a confusing failure three layers up.

The payload handed back is a view over the caller's bytes rather than a copy. A blob can be a whole
attachment, and copying every one of them to strip six bytes would double the peak memory of every
pull for nothing.

### Versions And Refusal

Two version markers exist, and both take the same posture: a version this build does not recognise
is refused outright, reported as needing a different build of Geode, never read as far as possible
and never quietly repaired.

- The **envelope version**, in the header of every object, covering the framing.
- The **snapshot version**, inside the manifest's JSON, covering the shape of the manifest itself.
  The sentinel carries the same marker. See [Vault](technical_vault.md) for what each version was.

**From `0.1.0` onwards, a bucket is migrated forward, never abandoned.** Any format change after
that release reads what is already there and upgrades it in place; asking someone to start a fresh
bucket is not an option once real vaults are in the field. A newer format is still refused rather
than guessed at, since a build cannot migrate forward from a version that did not exist when it
shipped, and the fix there is updating the plugin.

The versions before `0.1.0` are the exception, and this is the last of them. Versions 1, 2, and 3
were all settled while the only vaults in a bucket were the project's own, so each asked for a fresh
bucket rather than carrying migration code for data nobody had. That window closes at `0.1.0`.

### The Manifest

Each entry names one vault path and four things about it:

| Field   | Meaning                                                 |
| ------- | ------------------------------------------------------- |
| `size`  | The file's size in bytes, as last seen                  |
| `mtime` | The file's modification time, as last seen              |
| `hash`  | The SHA-256 of the file's own bytes                     |
| `blob`  | The address its content lives at, under `.geode/blobs/` |

`hash` and `blob` hold the same string in an unencrypted vault, and they are still separate fields,
because they answer different questions. `hash` is what the content **is**: how a diff notices an
edit, and what a pulled body is checked against before it lands on disk. `blob` is **where** those
bytes are: an address, not a claim about content. They stop being the same string at `0.3.0`, which
is why the manifest records the address per entry rather than leaving every reader to derive it (see
[Encryption](technical_encryption.md)).

An address is validated as a single safe key segment when a manifest is read, since a manifest is
untrusted input: anyone who can write to the bucket can shape it, and an address becomes the last
segment of a bucket key.

### The Storage Client

The client reads, writes, deletes, and lists objects. Every method takes and returns plain data,
never credentials or settings, so a future WebDAV or Dropbox client can satisfy the same shape
without changing anything above it.

Requests are signed with `aws4fetch`, which uses WebCrypto and so is environment agnostic. Only the
transport differs between the plugin and tests. At runtime the plugin dispatches through Obsidian's
`requestUrl`, which issues a native HTTP request outside the browser fetch stack and so is never
blocked by CORS; routing through the global `fetch` instead would make an R2 or S3 bucket reject the
app's origin unless someone hand configured a CORS policy on it. Tests inject a fetch backed
transport.

Signing and dispatch happen at one point every operation goes through, so no future transport can be
injected without a deadline around it.

Errors are values. A failed operation reports a status the caller can act on rather than a message
to be read and guessed at, and an error thrown while dispatching means the request never reached the
server at all, so the raw text names a symptom rather than a fix.

### Prefixes

Every key is relative to the client's own root, which is the configured bucket prefix, and every
listed key comes back relative to it too. Nothing above the client knows or cares whether the vault
sits at the bucket root or three folders down: the reserved key constants stay fixed strings, and a
blob's address reads off a listed key the same way either way.

An unusable prefix is refused at the client rather than anywhere above it, and every operation then
fails with the same message. Settings arrive straight from `data.json`, which a hand edit, an older
build, or a synced `.obsidian/` folder can all put a bad prefix into without the settings tab ever
seeing it, so validating only where someone types is validating nothing.

Dropping a bad prefix would sync the vault to the bucket root. Honouring one is worse still: the URL
a request is signed against collapses relative segments itself, so a leading `..` leaves the bucket
entirely and addresses a different one. Refusing every operation is the only outcome that cannot
quietly read or write a vault somewhere it was never meant to go.

### Conditional Writes

Sync's whole safety argument rests on the manifest upload being a compare and swap, so the client
can make a put conditional two ways: `ifMatch` succeeds only while the object's ETag still equals a
given value, and `ifAbsent` only while no object exists at the key. A failed precondition comes back
as a conflict status rather than silently overwriting what the other writer just stored.

Amazon S3 returns 409 where the specification suggests 412 when a conditional write loses a race
against another in flight write to the same key, so both codes mean the same thing to a caller.

Accepting the credentials is not enough to prove a provider is usable, so the connection test probes
the behaviour directly. It writes a throwaway object with `If-None-Match: *`, then issues a second
one that must be rejected. A provider with no conditional write support (Backblaze B2, Wasabi,
Garage) fails the first write; one that accepts the header but ignores it (Google Cloud Storage's S3
interop) lets the second clobber the first, which is exactly the silent data loss the conditional
puts exist to prevent. The probe also checks the read hands back an ETag, since sync needs one to
make later updates conditional. The probe object is always deleted, best effort.

### Listings

The list response is parsed with a regex rather than a DOM parser: the schema is narrow and stable,
and `DOMParser` is not available outside a browser-like runtime, which would make the parser
untestable under `node:test`.

The parser refuses a response it may have read incompletely. A provider whose `<Contents>` carries a
namespace prefix or an attribute would otherwise parse to zero objects, indistinguishable from a
genuinely empty bucket, and such a response can still report `IsTruncated` and `KeyCount` normally,
so checking only for those markers would wave it through. Instead the parser counts every tag that
merely looks like a `Contents` element and fails if that count exceeds what it actually parsed.

This matters because a listing silently short of the truth is what a first sync reads as an empty
bucket: it would push local files and write a manifest that never mentions the entries the parser
dropped, orphaning them permanently.

The same reasoning applies to keys outside the configured root. Every key is asked for under the
root, so one that comes back outside it is a provider answering a question it was not asked. That
fails the listing rather than being mis-sliced into a plausible looking key.

### Deadlines

Every request runs under a deadline, extended by a megabyte's worth of transfer time so a large
attachment on a slow link is not cut off part way through a transfer that was going to succeed. The
implied floor is roughly 0.1 MB/s. A single request carries a whole object today, so the allowance
is what keeps big files syncable until they move in chunks.

Obsidian's `requestUrl` accepts no `AbortSignal`, so a request that loses its deadline cannot be
cancelled and keeps running, detached, until the platform gives up on it. Settling the promise is
the whole point: a dispatch that never settles would leave the plugin's in flight sync guard set
forever, so every later sync silently does nothing and the status bar sits on "syncing" until
Obsidian restarts.

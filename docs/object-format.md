<!-- omit in toc -->
# Object Format

How **Geode** lays out a vault in your bucket, and which parts of that layout are fixed now so
encryption can arrive later without moving anyone's data.

- [Bucket Layout](#bucket-layout)
- [The Envelope](#the-envelope)
- [Suites](#suites)
- [Versions and Refusal](#versions-and-refusal)
- [The Manifest](#the-manifest)
- [What Encryption Changes](#what-encryption-changes)
- [What Is Deliberately Not Reserved](#what-is-deliberately-not-reserved)

## Bucket Layout

Everything Geode writes lives under a single reserved prefix, so nothing it owns can ever be
mistaken for a vault file, even if your vault happens to contain a note at a colliding path. If you
configure a bucket prefix, all of this sits underneath it.

| Key                      | What it holds                                                     |
| ------------------------ | ----------------------------------------------------------------- |
| `.geode/manifest.json`   | The last synced snapshot: every path, and what it points at       |
| `.geode/sentinel.json`   | A marker written once, proving this bucket has been synced before |
| `.geode/blobs/<address>` | One file's content, addressed by its content rather than its path |

One other key can appear under the prefix: `.geode/connection-probe-<uuid>`, written and deleted by
the settings tab's connection test to prove the provider honours conditional writes. It holds no
vault data, is never read back as vault data, and is not part of the format below.

A blob is keyed by an address derived from its own bytes, not by the vault path it belongs to. That
is what makes a rename free (the manifest points the new path at the same key), a duplicate
attachment cost one copy, and a delete non destructive: the manifest simply stops naming the
address, and the bytes stay recoverable for as long as any retained manifest still names it.

## The Envelope

Every object above is stored inside the same six byte envelope. The bucket is uniformly self
describing: a reader can tell what an object is, and whether it can read it at all, before it parses
a single byte of the payload.

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

The envelope is also why the bytes of an object are never read leniently. A body without a valid
header is refused rather than treated as a bare payload, because the moment a version 2 exists, an
unversioned object and a version 1 object would be indistinguishable.

## Suites

| Suite  | Meaning                                              | Status                 |
| ------ | ---------------------------------------------------- | ---------------------- |
| `0x00` | Plaintext, the payload exactly as it was handed over | Written and read today |
| Others | Reserved                                             | Encryption, 0.3.0      |

The sentinel is expected to stay plaintext permanently. It is the bootstrap record, read before a
device knows anything else about the bucket, and it holds no vault content: an identifier and a
timestamp. When encryption lands it is also the natural home for the key derivation salt and a key
check value, both of which have to be readable before any key exists to read them with.

## Versions and Refusal

Two version markers exist, and both take the same posture: a version this build does not recognise
is refused outright, reported as needing a different build of Geode, never read as far as possible
and never quietly repaired.

- The **envelope version**, in the header of every object, covering the framing.
- The **snapshot version**, inside the manifest's JSON, covering the shape of the manifest itself.
  The sentinel carries the same marker.

**From `0.1.0` onwards, a bucket is migrated forward, never abandoned.** Any format change after
that release reads what is already there and upgrades it in place; asking a user to start a fresh
bucket is not an option once real vaults are in the field. A newer format is still refused rather
than guessed at, since a build cannot migrate forward from a version that did not exist when it
shipped, and the fix there is updating the plugin.

The versions before `0.1.0` are the exception, and this is the last of them. Versions 1, 2, and 3
were all settled while the only vaults in a bucket were the project's own, so each asked for a fresh
bucket rather than carrying migration code for data nobody had. That window closes at `0.1.0`.

## The Manifest

Each entry in the manifest names one vault path and four things about it:

| Field   | Meaning                                                 |
| ------- | ------------------------------------------------------- |
| `size`  | The file's size in bytes, as last seen                  |
| `mtime` | The file's modification time, as last seen              |
| `hash`  | The SHA-256 of the file's own bytes                     |
| `blob`  | The address its content lives at, under `.geode/blobs/` |

`hash` and `blob` hold the same string in an unencrypted vault, and they are still separate fields,
because they answer different questions. `hash` is what the content **is**: how a diff notices an
edit, and what a pulled body is checked against before it lands on disk. `blob` is **where** those
bytes are: an address, not a claim about content.

They stop being the same string at `0.3.0`, which is why the manifest records the address per entry
rather than leaving every reader to derive it. A device pulling a file it has never seen has no
plaintext to derive an address from, and, once addressing is keyed, no way to compute one without
the vault key. So the address has to be written down next to the digest rather than instead of it.

An address is validated as a single safe key segment when a manifest is read, since a manifest is
untrusted input: anyone who can write to the bucket can shape it, and an address becomes the last
segment of a bucket key.

## What Encryption Changes

`0.3.0` turns encryption on. The format decisions it depends on are already made, and the shape of
the bucket does not move:

1. **Blobs and the manifest gain a new suite.** The payload becomes ciphertext; the envelope around
   it is unchanged, so a mixed bucket stays readable object by object rather than all or nothing.
2. **Blob addressing becomes a keyed hash.** An address becomes an HMAC of the plaintext under a
   subkey derived from the vault key, rather than the plaintext's bare SHA-256.
3. **Nothing else has to move.** Keys stay fixed length, the manifest already has a field to record
   an address in, and every object already says which suite it is.

The keyed hash is the decision most worth stating plainly. Addressing a blob by the plain SHA-256 of
its plaintext would leak a hash of that plaintext to anyone who can list the bucket, letting them
test whether a file they already hold is in your vault. That is a real weakness for a project whose
whole premise is storage you do not have to fully trust. A keyed hash preserves deduplication within
a vault, keeps addresses fixed length, and removes the confirmation attack, at the cost of no longer
deduplicating across separate vaults, which was never a property worth having anyway.

Turning encryption on for a vault that already synced in plaintext re-uploads its content, since
plaintext blobs cannot become ciphertext in place. That is unavoidable, and it is a one time cost
paid by choice. What the envelope buys is everything else: no discriminator bolted onto a format
with no room for one, and no forced re-upload for a vault that starts out encrypted.

## What Is Deliberately Not Reserved

Content addressing removed the hard half of encrypted storage before it was ever built. There are no
plaintext paths in the bucket to hide, and every key is the same length, so directory identifier
machinery of the kind Cryptomator needs is unnecessary here.

Nothing is reserved for chunking, compression, or per file keys. Each of those would change the
payload rather than the framing, which is exactly what a suite byte is for.

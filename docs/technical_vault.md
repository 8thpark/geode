<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Vault

The vault layer is everything Geode knows about the files on this device: what is there, what it
hashes to, and whether a path is safe to write at all. It is pure over an injected reader and
writer, so none of it imports Obsidian and all of it is testable without one.

- [Snapshots](#snapshots)
- [What A Snapshot Entry Holds](#what-a-snapshot-entry-holds)
- [Skipping The Rehash](#skipping-the-rehash)
- [Memory](#memory)
- [Snapshot Versions](#snapshot-versions)
- [Path Safety](#path-safety)
- [Unicode And Case](#unicode-and-case)
- [Settings Fingerprints](#settings-fingerprints)

### Snapshots

A snapshot is every file the reader currently sees, with a content hash for each. Two of them plus
the remote manifest are what a sync plans from (see [Sync](technical_sync.md)): the ancestor from
the last successful pass, persisted as `state.json`, and a fresh one taken at the start of this
pass.

The reader answers three questions between reads, all from the index rather than from content:
whether a path is there at all, so a failed read on a present file is never mistaken for absence;
how big it is right now, fresher than a listing taken at the start of the pass; and when it last
changed, so a pull can confirm nothing moved underneath it without rereading the file. A vanished
path reports a zero stat and lets the read that follows raise the real error.

### What A Snapshot Entry Holds

| Field   | Meaning                                                 |
| ------- | ------------------------------------------------------- |
| `size`  | The file's size in bytes, as last seen                  |
| `mtime` | The file's modification time, as last seen              |
| `hash`  | The SHA-256 of the file's own bytes                     |
| `blob`  | The address its content lives at, under `.geode/blobs/` |

`hash` and `blob` answer two different questions that happen to have the same answer today. `hash`
is what the content is: how a diff notices an edit, and what a pulled body is verified against
before it lands on disk. `blob` is where those bytes live in the bucket, an address rather than a
claim about content. They stop being the same string at `0.3.0` (see
[Encryption](technical_encryption.md)).

Every producer of an entry derives the address from the file's own content, so two entries with the
same hash always carry the same address and nothing downstream has to reconcile the two.

A snapshot can also carry a vault ID, the identifier of the bucket it was last synced against. It is
only ever attached to the local `state.json` copy, never to the remote manifest, and it is what lets
a device tell "I have never synced" from "I have synced, and this bucket now looks wrong".

### Skipping The Rehash

A file whose size and mtime both match the previous snapshot reuses that hash rather than rereading
its content. This is the same stat gated hashing rsync, git, and Syncthing all use: mtime and size
alone are not reliable enough to trust as identity, but they are cheap enough to justify skipping a
rehash when neither has moved.

The same stat pair is used in the conservative direction during a pull, where it can only ever
refuse a write. An mtime that moved without the content moving costs one replanned pass, never a
wrong answer.

### Memory

Reads run a few at a time and reserve against a size read immediately before each one, so a vault of
large attachments serialises rather than piling full files into memory at once. The budget is 64 MB.
A file larger than the whole budget is still read, because there is no streaming read on the
platform, but it runs alone rather than alongside anything else. A stat gated skip reads nothing and
reserves nothing.

Waiters are admitted strictly in arrival order, so a later small read never jumps a queued large
one.

The bound is not absolute. Reading a size and reading the file are separate operations, so a file
that grows in the window between them still allocates its whole buffer past the reservation, and no
whole file reader can prevent that without a streaming read the mobile platform does not offer. The
concurrency cap is the hard backstop: at most that many buffers are ever resident at once.

### Snapshot Versions

Every serialized snapshot carries a format version, remote manifest and local `state.json` alike, so
a future format change has something to branch on when it meets an existing bucket.

| Version | What it was                                                                    |
| ------- | ------------------------------------------------------------------------------ |
| 1       | Plaintext, path keyed storage. Predates the marker, so an absent field means 1 |
| 2       | Content moved onto a content addressed key under the reserved prefix           |
| 3       | Split where content lives from what it hashes to, in separate fields           |

None of these migrate. A bucket written before version 3 needs a fresh bucket, not an upgrade, which
is only acceptable because every one of them was settled before `0.1.0` while the only vaults in a
bucket were the project's own. From `0.1.0` onwards a bucket is migrated forward instead, so a
version below the current one but at or above 3 is a decoder's job to read and upgrade in place.
Only a version above the current one stays refused, since no build can migrate forward from a format
that did not exist when it shipped.

The version is checked before the shape is even looked at. A future format is free to change the
shape itself, and its snapshots must still read as "needs a different build" rather than as corrupt.
The one exception is a missing version field: that check runs after the shape check, so a merely
malformed payload with no version field still reads as corrupt rather than as a well formed old
manifest.

A missing, unparseable, or unsupported `state.json` is treated as "no snapshot yet" rather than an
error. The safest fallback for unusable state is to start fresh, not to crash sync: an empty
ancestor can at worst produce conflict copies, never data loss.

### Path Safety

A manifest is untrusted input. Anyone who can write to the bucket can shape it, and `state.json`
flows through the same decoder, so every entry's path is checked before a snapshot is handed back. A
single unsafe path fails the whole snapshot rather than being silently dropped, so nothing
downstream ever has to re-check what decoding already promised.

Refused outright:

- Traversal segments, empty segments, absolute paths, and backslashes
- Anything at or under the reserved `.geode` root, which would let a manifest re-enter as a vault
  file
- Anything at or under `.obsidian`, where a written file is loadable plugin code
- Windows reserved device names, and segments ending in a dot or a space, which Windows silently
  strips on write

The reserved roots are matched on the first path segment alone, lowercased, rather than on the whole
path. Both macOS and Windows default to case insensitive filesystems, so `.OBSIDIAN` and `.obsidian`
are the same directory on disk even though they compare unequal as strings, and a case sensitive
check would let a differently cased manifest entry plan straight into either reserved root.

The shape check itself stops at the array. A body that parses but is the wrong shape becomes a
handled corrupt case rather than a `TypeError` later, and confirming the outer shape does not
promise that every entry inside it is well formed, so entries are checked individually.

### Unicode And Case

Paths are normalized to Unicode NFC before any other check runs. macOS and iOS decompose by default
where Linux and Android compose, so the same visible filename arrives as two different byte
sequences. Without normalization the same note produces two distinct bucket keys and two manifest
identities the moment it crosses platforms.

Normalizing first is also what makes the case check mean what it claims. Folding case on the raw
path would let an NFD `Café.md` and an NFC `café.md` both pass as distinct.

Two entries whose paths differ only by case are then refused. Bucket keys are case sensitive, but
macOS, Windows, and Android filesystems are case insensitive by default, so pulling both onto a
device with any of those would silently let the second write replace the first with no conflict ever
raised. This is checked for every snapshot regardless of which filesystem is decoding it, since a
manifest a case sensitive device wrote is still headed for whichever device syncs it next.

### Settings Fingerprints

A stable fingerprint of the sync target is recorded alongside the snapshot, so pointing Geode
somewhere new invalidates state that describes somewhere old.

It covers only where the vault lives, normalized the same way a connection normalizes them.
Credentials are deliberately excluded: they authorize access to a target, they do not identify one,
so rotating a key must not invalidate state and force a full rehash of the vault.

The prefix is part of the target. Repointing at another folder in the same bucket lands somewhere
with its own manifest and its own sentinel, so carrying the old state across would diff the vault
against a stranger.

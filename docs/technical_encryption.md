<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Encryption

Geode does not encrypt anything yet. What it does have is a bucket format with room reserved for it,
decided while the only vaults in a bucket were the project's own, so turning encryption on at
`0.3.0` changes what is inside an object rather than the shape of the bucket around it. This page is
what has been decided and why, so the eventual implementation has nothing left to argue about.

- [Where Things Stand](#where-things-stand)
- [What Encryption Changes](#what-encryption-changes)
- [Keyed Addressing](#keyed-addressing)
- [The Sentinel Stays Plaintext](#the-sentinel-stays-plaintext)
- [What Is Deliberately Not Reserved](#what-is-deliberately-not-reserved)
- [What A Newer Bucket Looks Like](#what-a-newer-bucket-looks-like)

### Where Things Stand

Every object in the bucket already carries a suite byte saying what was done to its payload, and the
only value written or read today is `0x00`, meaning plaintext. Reserving that byte is the whole
point of the envelope: encryption arrives as a second suite value, met by objects that already say
which one they are, rather than as a discriminator bolted onto a format that never had room for one.
See [Storage](technical_storage.md) for the envelope itself.

The manifest already records a blob's address per entry, separately from the hash of its content,
for the same reason. Both fields hold the same string today, and they are still separate.

### What Encryption Changes

Three things, and nothing else:

1. **Blobs and the manifest gain a new suite.** The payload becomes ciphertext; the envelope around
   it is unchanged, so a mixed bucket stays readable object by object rather than all or nothing.
2. **Blob addressing becomes a keyed hash.** An address becomes an HMAC of the plaintext under a
   subkey derived from the vault key, rather than the plaintext's bare SHA-256.
3. **Nothing else has to move.** Keys stay fixed length, the manifest already has a field to record
   an address in, and every object already says which suite it is.

Turning encryption on for a vault that already synced in plaintext re-uploads its content, since
plaintext blobs cannot become ciphertext in place. That is unavoidable, and it is a one time cost
paid by choice. What the envelope buys is everything else: no discriminator retrofitted onto a
format with no room for one, and no forced re-upload for a vault that starts out encrypted.

### Keyed Addressing

This is the decision most worth stating plainly.

Addressing a blob by the plain SHA-256 of its plaintext leaks a hash of that plaintext to anyone who
can list the bucket, letting them test whether a file they already hold is in your vault. That is a
real weakness for a project whose whole premise is storage you do not have to fully trust.

A keyed hash preserves deduplication within a vault, keeps addresses fixed length, and removes the
confirmation attack. The cost is no longer deduplicating across separate vaults, which was never a
property worth having.

It is also why the address has to be written down in the manifest rather than derived by each
reader. A device pulling a file it has never seen has no plaintext to derive an address from, and
once addressing is keyed it has no way to compute one without the vault key. So the address sits
next to the digest that says whether the bytes came back intact, rather than instead of it.

The same reasoning is why the address safety check is a statement about keys rather than about
digests. An address is 64 lowercase hex characters today, but a future suite is free to encode it
differently, and a check that pinned the alphabet would have to be relaxed exactly when the format
changed. What must hold for every scheme is that an address addresses one object under the blob
prefix and cannot steer a request anywhere else.

### The Sentinel Stays Plaintext

The sentinel is expected to stay plaintext permanently. It is the bootstrap record, read before a
device knows anything else about the bucket, and it holds no vault content: an identifier and a
timestamp.

When encryption lands it is also the natural home for the key derivation salt and a key check value,
both of which have to be readable before any key exists to read them with.

### What Is Deliberately Not Reserved

Content addressing removed the hard half of encrypted storage before it was ever built. There are no
plaintext paths in the bucket to hide, and every key is the same length, so the directory identifier
machinery of the kind Cryptomator needs is unnecessary here.

Nothing is reserved for chunking, compression, or per file keys. Each of those would change the
payload rather than the framing, which is exactly what a suite byte is for.

### What A Newer Bucket Looks Like

Until encryption ships, a build that meets an object whose suite it does not recognise reports it as
needing a different build of Geode. That is the same posture the envelope version and the snapshot
version take, and it is the reason both markers exist: at `0.3.0` the manifest payload is
ciphertext, and a build with no idea how to decrypt it must say so rather than hand the bytes to a
JSON parser and report the vault as corrupt.

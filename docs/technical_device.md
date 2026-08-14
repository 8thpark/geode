<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Device

Every device that syncs a vault has an identifier. It exists for one reason: when two machines edit
the same note, the conflict copy needs to say which one the preserved edit came from. On a three
device vault "whose" is the question actually being asked, and a timestamp alone cannot answer it.

- [Where It Lives](#where-it-lives)
- [What It Looks Like](#what-it-looks-like)
- [Why The Alphabet](#why-the-alphabet)

### Where It Lives

Obsidian's vault scoped localStorage, deliberately not `data.json` or `state.json`.

Both of those live under `.obsidian/plugins/geode/`, and plenty of people sync `.obsidian/` through
iCloud, Dropbox, git, or another plugin, which would hand one device's identity to every other
device that reads the synced copy. Devices sharing an identity is worse than having none: conflict
copies get attributed to the wrong machine, and two machines can then generate the identical
conflict path for one note, where the second rename overwrites or strands the edit the first
preserved.

localStorage never travels with the vault, so an identity stored there stays local by construction
rather than by asking anyone not to sync a file. The pause flag lives there for the same reason (see
[Sync](technical_sync.md)).

The cost is that clearing app data mints a fresh identity for that device. That is a cosmetic reset,
conflict copies already written keep the name they were given, and it is the right trade against two
devices silently answering to the same name.

A stored value that is not a usable string is treated as absent and replaced rather than trusted.

### What It Looks Like

Two halves: a platform label a human can recognise, and a random suffix that separates two devices
of the same kind. Something like `mac-k3pl7qna`.

Both halves are generated rather than typed, so the result is always safe as a path segment and can
never collide with another device's only by case, neither of which holds for a name someone could
set themselves.

The mobile checks come first when working out the label. An iPad reports itself as macOS on some
builds, so asking "is this a phone or a tablet" before "which desktop OS" is what keeps an iPad from
being labelled a mac.

### Why The Alphabet

The suffix uses Crockford's base32, lowercased, which omits `i`, `l`, `o`, and `u` so a suffix read
off a filename cannot be transcribed back wrong.

One case throughout, here and in the platform label, is what stops two generated identities
differing only by case. That would be a path collision, and a manifest carrying two paths differing
only by case is refused outright (see [Vault](technical_vault.md)).

Lowercase specifically, rather than upper, because the whole suffix a conflict copy adds to a
filename is lowercase.

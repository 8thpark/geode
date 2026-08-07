<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Introduction

Geode syncs an Obsidian vault through storage you own. This section is the map: what each part does,
where the dependency arrows point, and which page to open when you want the reasoning behind a
decision rather than the code that implements it.

- [The Shape](#the-shape)
- [Where To Look](#where-to-look)
- [The Invariants](#the-invariants)
- [How Code Is Written Here](#how-code-is-written-here)

### The Shape

One pass of sync, end to end:

```
vault ──snapshot──► plan ──execute──► bucket
  ▲                  ▲                  │
  │                  │                  │
  └──── state.json ──┴──── manifest ◄───┘
```

Three snapshots go into planning: the ancestor from the last successful pass, the live vault, and
the remote manifest. What comes out is a list of actions. Executing them writes blobs and local
files, and the pass ends by uploading a new manifest describing what the bucket now holds.

Everything else is either deciding when to run that pass, or making sure a step in it cannot lose an
edit.

### Where To Look

| Page                                  | What it covers                                        |
| ------------------------------------- | ----------------------------------------------------- |
| [Sync](technical_sync.md)             | When a pass runs, and the ordering it depends on      |
| [Vault](technical_vault.md)           | Snapshots, hashing, path safety, snapshot versions    |
| [Storage](technical_storage.md)       | Bucket layout, the object envelope, the S3 client     |
| [Encryption](technical_encryption.md) | What `0.3.0` changes, and what is reserved for it     |
| [Plugin](technical_plugin.md)         | Obsidian glue, adapters, and the layering rule        |
| [Settings](technical_settings.md)     | What is configurable, and what deliberately is not    |
| [Device](technical_device.md)         | Device identity, and why it never syncs               |
| [Logging](technical_logging.md)       | What gets logged, and what is left out on purpose     |

### The Invariants

Four things hold everywhere, and most of the design follows from them.

**No edit is ever silently lost.** A path that changed on both sides becomes a conflict copy rather
than a guess about which side should win. Every destructive local write is preceded by a check that
the file still holds what the plan thought it held, and that check sits as close to the write as the
platform allows.

**A failed pass loses nothing.** Local edits stay local, remote edits stay remote, and the next pass
reconciles both. Progress made before a failure is recorded so it is never redone, while every
failed path reverts to the ancestor's view and is replanned.

**The bucket is self describing.** Every object carries a version and says what was done to its
payload, so a build that cannot read something says so rather than guessing. A format this build
does not recognise is always "needs a different build of Geode", never "your vault is corrupt".

**Untrusted input is checked once, at the edge.** A manifest can be shaped by anyone who can write
to the bucket, so paths and addresses are validated when a snapshot is decoded and a single bad
entry fails the whole thing. Nothing downstream re-checks what decoding already promised.

### How Code Is Written Here

TypeScript written as if it were Go: simple, explicit, boring. Pure functions first, errors as
values rather than exceptions, no clever generics, no magic. Classes exist only where the Obsidian
API demands one, and those are shells whose methods delegate immediately.

The full rules live in the `typescript-as-go` skill, which is the source of truth for style,
comments included. Two consequences worth knowing before reading any of the code:

- **Comments say why, not what.** A doc comment is one sentence and at most three lines. If the
  reasoning needs more room than that, it lives on one of the pages above and the comment points at
  it.
- **Tests sit beside the code they cover**, as `name.test.ts`, table driven, using `node:test` with
  no framework dependency. Integration tests end in `.itest.ts` and need Docker.

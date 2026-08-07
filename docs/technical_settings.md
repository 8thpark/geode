<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Settings

Geode has almost nothing to configure, which is deliberate: the only settings are where the vault
lives and how to reach it. Everything about timing, retries, and conflict handling is a decision the
project makes rather than a dial to hand you (see [Sync](technical_sync.md)).

- [What Is Stored](#what-is-stored)
- [Normalizing At The Point Of Use](#normalizing-at-the-point-of-use)
- [Prefixes](#prefixes)
- [The Secret](#the-secret)
- [The Draft Model](#the-draft-model)
- [Testing A Connection](#testing-a-connection)

### What Is Stored

Settings persist to `data.json` in the plugin's own folder.

| Field         | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `provider`    | `r2` or `custom`                                               |
| `accountId`   | Cloudflare account, which R2 derives endpoint and region from  |
| `endpoint`    | The S3 compatible endpoint, for a custom provider              |
| `region`      | The region, for a custom provider                              |
| `bucket`      | The bucket name                                                |
| `prefix`      | The folder inside the bucket the vault lives under             |
| `accessKeyId` | The access key                                                 |
| `secretId`    | A reference to the secret, never the secret value itself       |

Two things deliberately do not live here. The device identity and the automatic sync pause both go
to vault scoped localStorage instead, because settings travel to every device that reads a synced
`.obsidian/` folder and both of those are statements about one machine (see
[Device](technical_device.md)).

### Normalizing At The Point Of Use

Endpoint, region, and prefix are stored exactly as typed and canonicalized where they are used, not
on save.

The reason is the unsaved changes indicator. If saving rewrote a value, the field would read back
differently from what was typed and a trailing slash would show up forever as an unsaved change on a
settings tab nobody had touched.

### Prefixes

The prefix is forgiving about slashes on purpose. Surrounding whitespace goes, empty segments are
dropped, so `/vaults/personal/`, `vaults//personal`, and `vaults/personal` all address the same
place.

What it cannot make sense of is refused rather than quietly reinterpreted. Since normalization
already absorbs surrounding and repeated slashes, anything that reaches the error check is a typo
rather than a formatting preference.

- **Relative segments** are refused instead of resolved, because the URL a request is signed against
  collapses them itself, so `notes/../vault` would sync somewhere other than what was typed.
- **Control characters** are refused because they cannot survive a URL intact.

A prefix loaded from disk is checked differently from one being typed. Loading never rejects it, and
deliberately keeps an unusable value: blanking it would silently repoint a vault at the bucket root,
and showing an empty field gives someone nothing to correct. The storage client is what refuses to
act on one, so an unusable prefix always fails loudly and always survives long enough to be fixed
(see [Storage](technical_storage.md)).

### The Secret

`secretId` is a reference name into Obsidian's SecretStorage, not the secret value.

Obsidian's secret picker lets someone choose or create a secret name of their own, and it has no way
to force a newly created entry onto a fixed identifier: its own "add secret" dialog always asks for
a name. So Geode remembers whichever identifier was actually picked, the same way it tracks every
other field.

### The Draft Model

The settings tab edits a draft rather than live settings, and derives whether it is dirty by
comparing the draft against what is saved rather than tracking a flag.

Re-seeding the draft depends on why the tab is rendering. When Obsidian opens the tab, the draft is
re-seeded from saved settings, so an external `data.json` change cannot leave a stale draft showing
a phantom unsaved change. An internal re-render, such as switching provider, keeps the draft in
progress.

Field changes update the actions row without redrawing the whole tab, so a text input never loses
focus mid keystroke.

A draft the storage layer would refuse outright, such as a malformed prefix, is reported through the
connection status line rather than through a field error of its own. That reuses the one status line
and the save gating already keyed to it, so an unusable draft cannot be saved and left to fail at
sync time instead, and no new UI has to exist to say so.

### Testing A Connection

A connection test does two things, and reporting success on the first alone would be actively
harmful.

1. **The credentials work**, proven by a signed HEAD against the bucket.
2. **The provider honours conditional writes**, proven by writing a throwaway object and then
   attempting a second conditional write that must be rejected.

The second check exists because sync's entire safety argument rests on the manifest upload being a
compare and swap. A provider that authenticates fine but ignores preconditions loses edits silently
under concurrency, which is exactly what green-lighting it on the HEAD alone would do. See
[Storage](technical_storage.md) for what the probe actually writes.

Saving is gated on the result, so a draft that failed its test cannot be saved and left to fail at
sync time instead.

Saving a connection this device has never synced through closes the settings window and opens the
first sync dialog, since a working connection and no sync yet is a half finished setup rather than a
finished one; see [Plugin](technical_plugin.md#the-first-sync-dialog).

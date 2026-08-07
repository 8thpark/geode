<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Plugin

The plugin is glue and nothing else. Obsidian demands a class, so there is one, but its methods
delegate immediately to module level functions and no logic lives on it. Everything that decides
anything sits in pure modules that never import Obsidian, which is what makes the interesting parts
of Geode testable without a running app.

- [The Layering Rule](#the-layering-rule)
- [The Adapters](#the-adapters)
- [What The Plugin Owns](#what-the-plugin-owns)
- [Guards](#guards)
- [Writing Files Safely](#writing-files-safely)
- [Deleting Files](#deleting-files)

### The Layering Rule

Three tiers, and the dependency only ever points one way.

```
plugin class ──► adapters ──► pure modules
                              (import nothing)
```

1. **Pure modules.** Planning, executing, scheduling, path safety, the object format, the storage
   client. None of them import `obsidian`.
2. **Adapters.** One file per concern, each binding a pure interface to a real Obsidian API. These
   are the only files allowed to know Obsidian exists at all.
3. **The plugin class.** Lifecycle, wiring, and the commands and UI Obsidian registers.

The payoff is that the integration tests can drive the real adapter code over a `node:fs` backed
stand-in for Obsidian's vault, in a temp directory, against a real S3 compatible server. That closes
the biggest fidelity gap in testing a sync engine, which is the local file I/O layer, without
needing a running Obsidian.

### The Adapters

| Adapter        | Binds                                                         |
| -------------- | ------------------------------------------------------------- |
| Vault reader   | Listing, reading, and stat-ing files through the Vault API    |
| Local writer   | Staging, committing, deleting, and renaming through the adapter |
| State store    | Reading and writing `state.json`                              |
| Storage        | Dispatching signed requests through `requestUrl`              |
| Log sink       | Appending to a capped file in the plugin's data folder        |

Pulled content is written through the low level data adapter rather than the Vault API, because a
path pulled down for the first time has no `TFile` for the Vault API to operate on.

### What The Plugin Owns

- Loading settings, the device identity, and whether this vault has synced before
- Registering the vault event listeners that mark local work pending
- Ticking the scheduler and starting a pass when one is due
- The status bar, the log view, and the commands
- Translating a failed pass into what the scheduler should do about it

That last one is the whole of the contract between two modules that otherwise know nothing about
each other. Sync says what went wrong without knowing there is a timer; the scheduler decides when
to try again without knowing what a bucket is.

Before a snapshot is taken, every open markdown editor is forced to write its buffer to disk.
Obsidian's own autosave is debounced by around two seconds, and the vault reader only ever sees
bytes already on disk, so without this a pull can land on a path whose editor still holds older
content and the next autosave silently overwrites the pulled bytes with content sync never saw. The
residual race is only whatever someone types between that flush and the read, rather than however
long has passed since Obsidian's debounce last fired.

### Guards

Three pieces of state the plugin holds, each preventing a specific failure.

**In flight.** A second sync never starts while one is running.

**Synced before.** Automatic sync waits until a pass has completed against the currently configured
bucket. A first pass mints the vault's identity, uploads everything, and has no ancestor to fall
back on if the configuration is wrong, so it stays something asked for rather than something that
happens to you. It is reloaded whenever settings change, which is what makes repointing at a fresh
bucket demote it back to a manual first sync.

**Conditional writes verified.** The manifest compare and swap only holds if the provider honours
conditional writes. The settings tab probes for this, but nothing forces anyone to run that test, so
sync verifies once per session before it trusts the compare and swap and refuses to run rather than
silently lose edits on a provider that ignores preconditions. Reset on save, so switching provider
re-verifies.

A manual pass ignores a pause and clears any halt. The escape hatch has to work in every state,
especially the one where the automatic path has given up.

Coming back online ends a backoff early, but is not treated as proof anything works, only as reason
enough to stop waiting out a backoff whose premise has visibly expired. It pulls a waiting retry
forward and stops there: the failure streak keeps its size, so a flapping interface cannot reset the
delay to the base over and over, and a halt survives untouched, since wrong credentials and a bucket
belonging to another vault are exactly as wrong after a reconnect. Nothing gates on
`navigator.onLine`, which reports being on a network rather than being able to reach anything:
trusting it would turn one wrong answer into a sync that silently never runs.

### Writing Files Safely

Pulled content is staged to a hidden temp file beside its destination and renamed into place, never
written directly, so an interrupted pull cannot leave torn bytes for the next snapshot to read as a
local edit and push to the bucket. Staging files are dot prefixed so Obsidian never indexes them and
they can never appear in a snapshot, and their names are deterministic so a leftover from an
interrupted write is reclaimed by the next write to the same path rather than accumulating.

`state.json` is written the same way. It is the one file every sync's safety reasoning rests on as
the common ancestor, so a crash mid write must never leave it torn. A torn read falls back to "no
snapshot", which is safe on its own but still turns every remotely deleted file into a resurrection
and every divergence into a conflict copy, so atomic writes mean that fallback is never actually
exercised by an interrupted write.

Desktop's adapter replaces an existing destination atomically on rename. Where a rename refuses to
overwrite, as mobile can, the current content is renamed aside, the staged file claims the path, and
only then is the aside copy removed. The destination's bytes are never deleted while a restore is
still possible, so if the rename failed for some other reason and the retry fails the same way, the
aside copy is renamed straight back and the file survives untouched.

Parent folders are created one level at a time rather than left to a single recursive call, since
Obsidian's public API leaves recursion through missing intermediate folders undocumented and mobile
adapters are not known to match desktop's behaviour.

Failures here throw, because that is how this layer reports anything, and the sync executor turns
them back into ordinary per file failures the moment they cross the boundary.

### Deleting Files

A pulled deletion is moved to trash, never hard removed, so a delete that turns out to be a mistake
stays recoverable on this device. That mirrors what Obsidian does for a manual delete.

System trash is tried first. The vault local `.trash` folder is the fallback when the OS has no
trash, as on mobile or a headless host, so the file is always recoverable somewhere rather than
gone.

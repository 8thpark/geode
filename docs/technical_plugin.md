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
- [The First Sync Dialog](#the-first-sync-dialog)
- [The Mass Change Dialog](#the-mass-change-dialog)
- [Toasts](#toasts)
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
| Toaster        | Putting a decided toast on screen, and taking the sticky one down |

Pulled content is written through the low level data adapter rather than the Vault API, because a
path pulled down for the first time has no `TFile` for the Vault API to operate on.

### What The Plugin Owns

- Loading settings, the device identity, and whether this vault has synced before
- Registering the vault event listeners that mark local work pending
- Ticking the scheduler and starting a pass when one is due
- The status bar, the log view, the toasts, and the commands
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

### The First Sync Dialog

Saving a connection is the moment someone has said what they want and nothing has happened yet.
Because the first pass is never started for you (see [Sync](technical_sync.md)), that moment would
otherwise end in silence, so saving opens a dialog that reads the bucket, says what a first sync
would do, and offers to run it.

It reads before it asks. The manifest and the sentinel answer whether a vault already lives there,
and the vault's own file list answers what is on this device. Nothing is written, and no file is
hashed: the counts come from comparing paths, which is why the merge case says "where a file
differs" rather than claiming to know that any file does.

| The bucket says       | This vault is | The dialog offers                                     |
| --------------------- | ------------- | ----------------------------------------------------- |
| No vault here yet     | Anything      | Upload everything, and this vault becomes the original |
| A vault already lives here | Empty    | Download everything, nothing local is touched         |
| A vault already lives here | Not empty | A merge, with upload, download, and overlap counts   |
| Something to go and fix | Anything    | The reason, and a way back to settings                 |
| Nothing, it can't be read | Anything  | The error, and another go                             |

Once a pass finishes the same dialog reports what moved and, for the first and only time, explains
how Geode behaves from then on: automatic syncing, the status bar icon, and the log view. Said
before a sync has ever run, that is noise; said the moment one has landed, it is the answer to
"what now". A failed pass keeps someone in the dialog with the message, the logs, and a retry,
rather than handing them back a status bar icon that can only say something went wrong.

There is deliberately no "overwrite the bucket" or "discard local and fetch" option. Plugins that
offer that pair are where their users lose notes, and a destructive choice presented during setup is
the one moment nobody has the context to answer it. Merging with conflict copies is the only path,
which is the same promise the rest of sync makes.

The dialog is offered while, and only while, a first sync is still ahead of this device: a usable
connection with no completed pass behind it. That is also what gates the **Set up sync** command, so
dismissing the dialog is never a dead end and a vault that is already set up is never offered a
setup step.

### The Mass Change Dialog

When a pass is refused by the [mass change guard](technical_sync.md#the-mass-change-guard), the
plugin opens the only other dialog Geode has. It is the same shape as the first sync one, and for
the same reason: something irreversible is about to happen, and the only person who can say whether
it is right is not the one who planned it.

Four things have to be on the screen, because a bare count cannot be answered:

1. What the pass would do, per side, in files rather than actions
2. Which part of it is recoverable, since a deleted file goes to the trash and a replaced one does
   not, and nobody would guess that
3. The files themselves, collapsed, first twenty and a count of the rest; seeing "all my daily
   notes" rather than "the folder I deleted on my phone" is what makes the question answerable
4. That nothing has changed yet and automatic sync stays off until it is answered, or someone
   cancels, notices sync is dead an hour later, and reports it as a bug

Cancel is the emphasised button and dismissing the dialog any other way counts as a cancel, so the
pass only runs when someone reached for the button that says so. Confirming runs a fresh manual
pass, which is also what lifts the halt, so the escape hatch and the answer are the same mechanism
rather than two that can disagree.

The answer carries the plan it was given back with it, and the fresh pass checks that it is still
planning exactly that (see [the guard](technical_sync.md#the-mass-change-guard)). When it is not,
the dialog opens again, and says so: a second identical looking prompt with no explanation reads as
a bug, and someone who has already clicked through one is exactly the person who will click through
the next without reading it.

### Toasts

The status bar is a cloud icon and a tooltip, which is enough to answer "what is it doing" and
nothing like enough to say something you have to act on. Toasts are the other half, and every one
geode raises comes from a single table in `notify/notify.ts`, so the wording, the duration, and the
silences are all pinned by one test rather than scattered across the plugin class.

| Occasion                          | Says                                                     | Stays |
| --------------------------------- | -------------------------------------------------------- | ----- |
| Automatic sync halted             | The reason, since nothing will happen until you act       | Until dismissed |
| A large change is waiting on you  | That nothing has synced, for whoever dismissed the dialog | 10s |
| Any pass failed                   | The reason                                                | 10s |
| Conflict copies were made         | How many, and that your copy is beside the remote one     | 10s |
| A pass applied changes            | How many                                                  | 5s |
| A manual pass found nothing to do | That you were already up to date                          | 5s |
| Syncing recovered                 | That it is working again                                  | 5s |
| Paused, resumed, settings saved   | That it happened                                          | 5s |

One thing stays silent: an automatic pass that applied nothing. That is the product working, it
happens every few minutes forever, and a notice you cannot stop is not information. `log.ts` drops
those lines for the same reason.

Precedence within a pass is worst news first. A halt outranks the failure it arrived as, a mass
change outranks the halt, and a conflict outranks the change count it came with, because the count
is the part you would have guessed.

The halt toast is the only sticky one, and it is held so the next thing geode says can take it
down. A "stopped syncing" notice still on screen after you have fixed the credentials is worse than
no notice at all, and a sticky toast outlives the plugin that raised it, so disabling geode retires
it too.

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

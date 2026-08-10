<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Sync

Sync is one pass: snapshot the vault, read the manifest, work out the difference, carry it out, and
write a new manifest. Everything else on this page is about the two questions that pass keeps
asking, which is when to run and what order to do things in, because both answers are load bearing
for the promise that no edit is ever lost.

- [When Geode Syncs](#when-geode-syncs)
- [What Never Happens Automatically](#what-never-happens-automatically)
- [Pausing](#pausing)
- [The Scheduler](#the-scheduler)
- [What A Pass Does](#what-a-pass-does)
- [Planning](#planning)
- [The Mass Change Guard](#the-mass-change-guard)
- [Executing](#executing)
- [Conflicts](#conflicts)
- [Vault Identity](#vault-identity)
- [When A Sync Fails](#when-a-sync-fails)

### When Geode Syncs

Local changes have a signal: Obsidian tells the plugin the instant a file appears, changes, moves,
or goes away. Remote changes have none, because no S3 compatible provider can notify a plugin, so
the only way to find out is to ask. Everything below follows from that split.

| Trigger      | Fires when                                            | Delay                |
| ------------ | ----------------------------------------------------- | -------------------- |
| Startup      | Obsidian has finished loading the vault               | Within a few seconds |
| Local change | A file appears, changes, moves, or is deleted         | 5 seconds of quiet   |
| Focus        | You come back to a window that has been away a while  | Immediately          |
| Poll         | A timer, while the Obsidian window has focus          | Every 5 minutes      |
| Manual       | You click the status bar, or run the **Sync** command | Immediately          |

Some detail worth knowing:

- **Local changes wait for quiet, not for a timer.** Five seconds after you stop typing, your work
  is on its way. A burst of edits becomes one sync rather than one per keystroke, and typing that
  never stops still syncs at least every 30 seconds so a long writing session is never stranded.
- **A window without focus does not poll.** There is nothing to show you, and coming back to the
  window is itself a trigger, so the gap closes in one sync the moment you look.
- **Local changes sync even when the window is unfocused**, since a file can change without you
  touching Obsidian.
- **Coming back to a window syncs only if it has been away for at least a minute.** Switching
  between apps is not a reason to sync.

### What Never Happens Automatically

**The first sync against a bucket is always something you ask for.** It creates the vault's
identity, uploads everything, and is the one pass with no previous state to fall back on if
something is misconfigured. Geode will not start it unattended. Once one has completed, everything
in the table above takes over.

The same applies if you point Geode at a different bucket: until a sync completes against the new
one, automatic sync waits. Automatic sync also stays off while storage is not fully configured.

You are not left to find that first pass yourself. Saving a connection opens a dialog that reads the
bucket, tells you what a first sync would upload, download, or merge, and runs it when you say so;
see [the first sync dialog](technical_plugin.md#the-first-sync-dialog).

**A sync that would destroy a large share of the vault is also always something you ask for**, first
pass or hundredth; see [the mass change guard](#the-mass-change-guard).

### Pausing

Two commands in the palette, **Pause automatic sync** and **Resume automatic sync**.

Pausing applies to the device you run it on and survives a restart. It is deliberately not a
setting, because settings live in your vault and travel to every device that syncs it; pausing your
laptop should never quietly pause your desktop. That is why the pause flag lives in Obsidian's
vault scoped localStorage rather than in `data.json`, the same reasoning the device ID uses (see
[Device](technical_device.md)).

While paused, the status bar shows a dimmed cloud with a line through it. Clicking it still syncs
once, and the **Sync** command still works. Pause stops the timer, never the escape hatch.

### The Scheduler

Deciding when to sync is kept apart from doing it. Every rule is a policy question with a defensible
answer rather than a number to configure, and every one is a pure comparison against a clock the
caller passes in, so the whole policy is table testable without a timer, a fake clock, or Obsidian.

The shape is deliberately dull. The plugin ticks the scheduler every 5 seconds and asks one
question, "is a pass due, and why". There is no timer per trigger, no rescheduling, and nothing to
interpret; a tick that finds nothing due does a handful of subtractions and returns. The cost is
that every delay below is accurate only to within one tick, which nobody can perceive and no
correctness argument rests on.

| Constant           | Value  | Why that value                                                    |
| ------------------ | ------ | ----------------------------------------------------------------- |
| `TICK_MS`          | 5s     | Cheap enough to be irrelevant, small enough to keep delays honest |
| `LOCAL_QUIET_MS`   | 5s     | Just past Obsidian's own ~2s autosave debounce                    |
| `LOCAL_MAX_WAIT_MS`| 30s    | An unbroken hour of typing never goes quiet, so it needs a ceiling|
| `FOCUS_MIN_GAP_MS` | 60s    | Without a floor, alt tabbing would be a sync trigger              |
| `POLL_INTERVAL_MS` | 5m     | Conservative, since every poll is currently a full pass           |
| `RACE_RETRY_MS`    | 10s    | Nothing went wrong, so nothing to back off from                   |
| `BACKOFF_BASE_MS`  | 2m     | The first retry is the one most likely to fail the same way       |
| `BACKOFF_MAX_MS`   | 30m    | Long enough to stop hammering, short enough to catch up    |

Five minutes is the conservative opening value for polling, and it is meant to come down. Every
poll is a full pass today; once a pass can rule itself out with a single HEAD on the manifest, the
interval can shorten without costing anything.

The order the rules are checked in is the priority order. A failed pass is its own reason to run
again, ahead of everything and regardless of focus: starting a pass clears the pending local work it
covers, so a push that fails on an unfocused window would otherwise have nothing left to fire it and
the edits would sit there until someone clicked back into Obsidian. Silence with unsynced work
behind it is the one outcome this whole design exists to avoid.

Local work then outranks polling, because pushing an edit we already know about beats asking a
question whose answer is almost always no, and it sits above the focus gate because a file can
change while the window is in the background.

Absence is measured from when focus was actually lost, never from the age of the last pass. An hour
of unbroken work in a focused window is not an absence, and measuring it that way would turn every
two second switch to another app into a full pass.

<!-- omit in toc -->
#### Why There Is No Interval Setting

Because it would be a question you cannot answer. The right delay for pushing an edit we already
know about is seconds; the right delay for asking a provider a question whose answer is almost
always "nothing changed" is minutes. One number cannot be both, and every plugin that offers one
gets both halves wrong at once. If the delays above turn out to be wrong, that is a bug to fix in a
release rather than a dial to hand you.

### What A Pass Does

One pass, in order:

1. Flush open editors, so bytes sitting in an editor buffer are on disk before anything reads them
2. Snapshot the local vault against the previous snapshot (see [Vault](technical_vault.md))
3. Read the remote manifest, and its ETag
4. Resolve vault identity, refusing if this bucket is not the one this device synced before
5. Plan the reconciliation from three snapshots
6. Stop and ask if the plan would destroy a large share of the vault, unless it already has
7. Execute every action, collecting per file failures rather than stopping at the first
8. Upload a manifest describing what the bucket now holds, conditional on that ETag still being
   current, or on the manifest still being absent for a first sync
9. Return the new snapshot for the caller to persist as `state.json`

The caller owns persistence. The previous snapshot is passed in and the new one handed back rather
than read or written internally, so a pass stays pure over its inputs and tests can drive it with
their own store.

A pass that planned nothing and found a manifest already describing exactly that skips step 8.
Writing it anyway is not merely a wasted request: every manifest upload is a compare and swap, so a
device with nothing to say is a device that can lose a race it had no reason to enter and report
"another device synced at the same time" over a vault nobody touched. Under manual sync that costs
one baffling click; under automatic sync it becomes a recurring error on a vault at rest, which is
how someone learns to stop reading the status bar.

A first sync uploads even having planned nothing, because the manifest existing is what tells every
later pass this bucket has been synced before.

### Planning

Planning compares three snapshots: the ancestor (`state.json`, the end of the last successful
sync), the live local vault, and the remote manifest. A path that changed on one side is a push or a
pull. A path that changed on both, to different content, is a conflict.

On a first sync the ancestor is dropped entirely. No remote manifest means no prior sync ever
completed against this bucket, so `state.json` cannot be a valid common ancestor. An upgrader's
stale state, written by an older build on every file event rather than only on completed syncs,
would otherwise diff against the empty remote as "every file deleted remotely" and pull-delete the
whole vault.

The manifest a pass uploads is derived from what the plan just did to the bucket, never from a fresh
snapshot of the disk. A file edited while the plan ran would land in a re-snapshot claiming content
the bucket never received; the edit would then never upload, because `state.json` already agreed
with the manifest, and another device could later push the stale bucket copy back over it. The
re-snapshot at the end only refreshes size and mtime, so a mid pass edit keeps its bucket entry and
reads as a local change next pass.

Every pushed entry is recorded at the hash of the bytes that actually reached the bucket, not at a
pre-push snapshot hash and not at the owning action's success. A conflict's copy push can succeed
while the same action's restore fails, and the copy still has to reach the manifest or it sits in
the bucket forever, invisible to every other device.

### The Mass Change Guard

Between planning and executing sits the last point at which refusing costs nothing. A plan is
counted before a byte moves, and a pass that would destroy a large share of the vault stops and asks
instead of running.

Destroying means one of three things, and nothing else counts:

| Action                                       | Destructive? | Why                                     |
| -------------------------------------------- | ------------ | --------------------------------------- |
| A file deleted locally                       | Yes          | Goes to the trash, but it does go       |
| A file here replaced by the remote version    | Yes          | The version in the vault is not kept    |
| A file deleted from the bucket               | Yes          | The manifest stops listing it           |
| A file added on either side                  | No           | Nothing is being replaced               |
| A conflict copy                              | No           | Both versions survive, under two names  |

The threshold is a share of the tracked files, clamped at both ends:

```
halt if destructive > clamp(tracked * 0.2, 10, 50)
```

Three bands fall out of that. Under 50 tracked files the floor of 10 binds, so deleting a handful of
notes never prompts. Between 50 and 250 the share binds. Above 250 the ceiling of 50 binds, because
a fifth of a ten thousand file vault is two thousand files and nobody should lose two thousand files
without being asked.

Neither end works alone. A share on its own waves through thousands in a large vault; a count on its
own can never fire in a vault smaller than the count itself, which is exactly where a new user is.
The floor is there because a guard people learn to dismiss guards nothing.

Tracked is the ancestor's file count, so a first sync has a tracked count of zero. That is safe by
construction rather than by special case: every action in a bootstrap is an addition, and a device
pulling a vault into an empty folder is adding too, so neither can reach the floor.

Halting executes nothing. No file is written, no manifest goes up, no sentinel is written, and
`state.json` does not advance, so cancelling leaves a pass that can simply be planned again. The
confirmation runs a fresh pass rather than resuming the halted one: the plan is rebuilt from a
re-read of the bucket, which is both simpler than holding an ETag open across a human's attention
span and safer, since the compare and swap is never left waiting on someone finding their reading
glasses.

An answer covers the plan it was given and no other. The confirmation carries the destructive set
that was on the screen, and the fresh pass runs only if what it now plans is exactly that set, path
for path and fate for fate. Anything else is a plan nobody has seen, so it is asked again rather
than executed under an old yes. That matters because the vault and the bucket both keep moving
between the dialog opening and someone answering it: without the binding, a "yes" to 12 deletions
could be spent on 400.

The comparison is by set rather than by order, since planning follows snapshot order and a re-read
of the bucket is under no obligation to repeat it. A fresh plan that no longer trips the guard at
all simply runs, confirmed or not; there is nothing left to ask about.

Under automatic sync the halt is a full stop rather than a prompt on a timer. The scheduler treats
it exactly like a permanent failure, so an unanswered dialog is asked once, not once every five
minutes.

### Executing

Each action runs against the local vault and the bucket, and one failed file never discards the
progress of the rest of the pass. Failures are collected per file and the manifest still goes up.

The interesting part is ordering. Any pass that writes over or deletes a local file is racing the
person using the vault, and the guarantees only hold if the checks sit as close to the mutation as
they can get.

<!-- omit in toc -->
#### Staging Before Checking

Pulled content is written to a hidden staging file beside its destination and renamed into place,
never written directly. Writing the payload is the slow part. It used to sit between the drift check
and the destination actually changing, so the window the check was meant to close still spanned
however long the write took: on a large attachment, long enough for an edit to land in it and be
silently overwritten. Staging first leaves only the rename in that window.

<!-- omit in toc -->
#### Cheapest Last

Three checks run before a pulled write commits, ordered so none of them stands behind another's slow
work:

```
stage payload ──► local drift ──► manifest HEAD ──► confirm ──► commit
    (slow)         (reads file)     (network)       (index)    (rename)
                                                    └──────────────────┘
                                                    the only window left
```

1. **Local drift**, the expensive one. It reads and hashes the whole destination and compares
   against the snapshot the plan was made from. Anything ordered after it inherits that read as its
   own race window, so it goes first.
2. **Manifest drift**, a HEAD on the manifest comparing ETags. A blob is fetched by its own address,
   so it always reads back exactly that content and can never itself notice a newer manifest having
   pointed the path elsewhere. The ETag is the only signal left that the plan's remote view is
   stale.
3. **Local confirmation**, an index only stat comparison against what the drift check recorded. It
   never rereads, because the hash already proved those bytes; the whole point is being cheap enough
   to sit last, so the local guarantee spans the network round trip rather than ending before it.

Size alone would not do for that last check. A typo fixed in place rewrites a note without changing
its length, so the mtime comparison is what makes it a guard rather than a formality. Size is kept
beside it because a rewrite inside the same clock tick can move one when it cannot move the other.

Deletions use the same three checks in the same order. A delete has nothing of its own to check
against and would otherwise remove a path a newer manifest has since repopulated. Acting on a stale
manifest is worse for a delete than for a write: the local file goes to trash, this pass's manifest
upload then loses its conditional PUT, and the next pass reads the deletion as the user's own and
pushes it, dropping from every device a path another device had just repopulated.

<!-- omit in toc -->
#### Write Modes

A staged write declares at staging time what it may do to its destination.

- **`replace`** installs over whatever is there, which is what an ordinary pull wants: the path's
  old content is exactly what the plan decided to move on from.
- **`create`** refuses to commit if anything is at the path. A conflict's restore lands on a path
  the same action renamed away moments earlier, so a file sitting there now was created in the
  window since, holds content no conflict copy preserved and no snapshot describes, and must not be
  replaced.

The vacancy check lives in the writer rather than in a caller's drift check because only the writer
can see the destination as it actually is. A filesystem stat through the adapter sees a file the
instant it appears; a check through Obsidian's file index lags the very rename the action just made,
and would refuse sound restores as often as it caught real ones.

<!-- omit in toc -->
#### Push Is Additive

A push needs none of this. A blob is keyed by an address derived from its own content, so an object
already at that key is byte identical to what the caller would otherwise upload: a rename or a
duplicate attachment costs one HEAD and nothing more. Losing a conditional PUT to another device
still leaves the key holding the right bytes, so it counts as success rather than a conflict.

A remote deletion is purely a manifest change. The path is dropped from what the next manifest
names, and the blob is left exactly where it is, reachable for as long as any retained manifest
still names its address. Nothing touches the bucket, so nothing can fail, and there is no live
object at a shared key for another device to clobber.

An earlier version copied a deleted file's blob to a bucket side trash location to buy a recovery
window. That was removed deliberately: content addressing already makes a delete non destructive,
so the trash copy was a second mechanism guaranteeing something the first one already guaranteed.
Anyone proposing a server side recycle bin should know it was built once and taken out again.

### Conflicts

A conflict is a path that changed on both sides to different content. Neither edit is ever silently
discarded: the local edit is renamed to a conflict copy and pushed, and the remote version claims
the original path.

The copy's name carries the time and the device, because on a three device vault "whose" is the
question actually being asked. It uses no spaces, is lowercase throughout, and separates fields with
underscores while hyphens live inside them, so a name parses unambiguously from the right even when
the note's own name contains underscores. Lowercase throughout also means two devices can never
produce paths differing only by case, which a manifest read refuses outright.

The timestamp keeps milliseconds. A plan carries at most one action per path, so two conflicts for
one path can only come from two passes, but nothing stops a failed pass being retried immediately
and automatic sync makes back to back passes ordinary. At second precision both would name the same
copy and the second rename would overwrite or strand the edit the first preserved: silent loss, in
the one function whose entire job is that no edit is ever lost.

Everything slow and fallible happens before the path is vacated. The remote version is fetched,
verified and staged, and the manifest confirmed current, all while the local edit still sits
untouched under its own name. Only then do the two renames run back to back. Failing before the
rename leaves the vault exactly as it was, so an unreachable blob or a manifest that moved on
replans the whole conflict next pass rather than leaving a copy on disk and an empty path where the
note used to be.

A conflict also records which side was deleted, so the executor never has to guess from a failed
read whether a deletion is why there is nothing there. `local` means there is no local content to
preserve, `remote` means there is nothing remote to pull, and `none` means both sides hold real,
differing content.

### Vault Identity

Two objects tell a device whether a bucket is the one it thinks it is.

- **The manifest** proves a sync has completed. Its absence usually means a fresh bucket.
- **The sentinel** proves a bucket has been synced before, independently of whether the manifest
  currently exists. It is written on the pass that completes a bucket's first sync, and on any
  later pass that finds it missing, which is how a bucket that lost one heals itself.

The sentinel exists because a manifest can go missing for a bad reason: a lifecycle rule, a manual
deletion, a typo in a configured prefix. Once a sentinel exists, whether the manifest happens to be
there never changes the answer. What matters is only whether this device's stored vault ID, if it
has one, agrees with the sentinel's.

Only when both are absent does it matter whether this device has synced before:

| Manifest | Sentinel | This device                | Result                                   |
| -------- | -------- | -------------------------- | ---------------------------------------- |
| Absent   | Absent   | Has synced somewhere       | Refused, nothing proves this is the vault |
| Absent   | Absent   | No history                 | Genuine first sync, mint a fresh ID       |
| Present  | Absent   | Either                     | Benign, self heals by writing the sentinel |
| Either   | Present  | ID disagrees               | Refused, this is a different vault        |

A blob surviving a deleted manifest is not automatically a hazard. A blob's key is an address
derived from its own content, so a survivor at an address the local vault still resolves to needs no
recovery: the ordinary push finds it already there and the manifest this pass writes describes it
correctly. What remains dangerous is a survivor whose hash matches nothing local.

That case is reported rather than refused. An earlier version blocked the whole pass on any
unexplained survivor, but that has no path back to a clean state when the explanation is mundane: an
interrupted first sync leaves a blob behind, the local file it belonged to is deleted before the
retry, and nothing local will ever explain it again. Since a bucket only stops being a first sync
once a manifest lands, a hard refusal never writes one, so every retry hits the identical refusal
forever. Proceeding lets a real first sync complete, at the cost that the unexplained content stays
unreferenced in the bucket, never destroyed, until someone investigates the reported failure.

### When A Sync Fails

Nothing is lost by a failed sync. Local edits stay local, remote edits stay remote, and the next
successful pass reconciles both. What changes is how soon that next pass is attempted.

| What went wrong                                | What Geode does                       |
| ---------------------------------------------- | ------------------------------------- |
| Network, timeout, provider error               | Retries, waiting longer each time     |
| One file failed, the rest went                 | Keeps the progress, retries that file |
| Another device synced at the same moment       | Retries in a few seconds              |
| Access key rejected, or storage misconfigured  | Stops automatic sync until you fix it |
| Secret access key missing                      | Stops automatic sync until you fix it |
| Provider does not support conditional writes   | Stops automatic sync until you fix it |
| Bucket was written by a newer version of Geode | Stops automatic sync; update Geode    |
| The pass would destroy a large share of the vault | Stops automatic sync until you answer |

A failed pass carries how it should be treated rather than leaving a caller to read the message and
guess, which is how a bare "(404)" once ended up being sniffed out of error text.

- **Transient** is anything a later attempt could plausibly get past on its own: a dropped
  connection, a provider having a bad minute, a file that was briefly busy.
- **Raced** is losing the manifest compare and swap to another device, which is not this device
  failing at all. Nothing is lost, both sides' work survives, and the next pass reconciles them.
- **Permanent** is everything retrying cannot fix: credentials that are wrong, a bucket belonging to
  a different vault, a manifest written in a format this build cannot read.
- **Blocked** is not a failure at all: the pass was refused by the mass change guard and is waiting
  on an answer. Nothing ran, so there is no progress to keep and nothing to retry.

A permanent failure halts automatic sync, and only two things lift that halt: syncing manually, and
saving settings. Both are someone acting on the problem it is about. A network reconnect is neither.
It says an interface came back, never that the provider is reachable or the credentials are good, so
it brings a waiting retry forward and leaves the halt exactly where it is.

A raced pass resets the failure streak rather than merely holding it. It reached the provider, read
the manifest, moved the files, and lost only the final compare and swap, which proves the network is
up and the credentials are good. Carrying an earlier failure past that point would let an unlucky
interleaving of a dropped connection, a race, and another dropped connection charge the second blip
a doubled delay for a streak a working round trip had already broken.

A failed pass can still return a snapshot. Completed actions are recorded so they are never
replanned, while each failed action's path reverts to the ancestor's view and is replanned next
pass. Reverting is what makes recording progress around a failed pull safe: advancing that path to
the manifest's entry would make the unchanged local content read as a fresh local edit, and the next
pass would push it over the newer remote version.

The manifest upload itself is conditional on the remote still being exactly what this pass read at
the start, or still absent on a first sync. An unconditional put would last writer win against a
device syncing at overlapping times, and the loser's pushes would then read as remote deletions on
the winner's next sync. Losing the race fails the pass loudly instead, `state.json` does not
advance, and the next sync reconciles both devices' work with nothing lost.

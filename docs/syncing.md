<!-- omit in toc -->
# Syncing

When **Geode** syncs on its own, what stops it, and what happens when it can't. There is nothing to
configure here; the only control is a pause, and it applies to one device.

- [When Geode Syncs](#when-geode-syncs)
- [What Never Happens Automatically](#what-never-happens-automatically)
- [Pausing](#pausing)
- [When A Sync Fails](#when-a-sync-fails)
- [Why There Is No Interval Setting](#why-there-is-no-interval-setting)

## When Geode Syncs

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

## What Never Happens Automatically

**The first sync against a bucket is always something you ask for.** It creates the vault's
identity, uploads everything, and is the one pass with no previous state to fall back on if
something is misconfigured. Geode will not start it unattended. Once one has completed, everything
in the table above takes over.

The same applies if you point Geode at a different bucket: until a sync completes against the new
one, automatic sync waits.

Automatic sync also stays off while storage is not fully configured.

## Pausing

Two commands in the palette:

- **Pause automatic sync**
- **Resume automatic sync**

Pausing applies to the device you run it on and survives a restart. It is deliberately not a
setting, because settings live in your vault and travel to every device that syncs it; pausing your
laptop should never quietly pause your desktop.

While paused, the status bar shows a dimmed cloud with a line through it. Clicking it still syncs
once, and the **Sync** command still works. Pause stops the timer, never the escape hatch.

## When A Sync Fails

Nothing is lost by a failed sync. Local edits stay local, remote edits stay remote, and the next
successful pass reconciles both. What changes is how soon that next pass is attempted.

| What went wrong                              | What Geode does                       |
| -------------------------------------------- | ------------------------------------- |
| Network, timeout, provider error             | Retries, waiting longer each time     |
| Another device synced at the same moment     | Retries; both devices' work survives  |
| One file failed, the rest went               | Keeps the progress, retries that file |
| Secret access key missing                    | Stops automatic sync until you fix it |
| Provider does not support conditional writes | Stops automatic sync until you fix it |

The retry delay starts at 2 minutes and doubles with each consecutive failure, up to 30 minutes. A
single success resets it, so an unreliable connection costs you one slow retry rather than a
permanently slow client.

The two cases that **stop** automatic sync do so because retrying cannot fix them, and retrying
every few minutes for a week would only generate noise. Saving your settings, or syncing by hand,
starts it again.

## Why There Is No Interval Setting

Because it would be a question you cannot answer. The right delay for pushing an edit we already
know about is seconds; the right delay for asking a provider a question whose answer is almost
always "nothing changed" is minutes. One number cannot be both, and every plugin that offers one
gets both halves wrong at once.

If the delays above turn out to be wrong, that is a bug to fix in a release rather than a dial to
hand you.

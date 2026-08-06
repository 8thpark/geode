<!-- omit in toc -->
# Technical

<!-- omit in toc -->
## Logging

Observability is a first class concern here, but a log nobody reads is worse than no log at all. So
the rule is that Geode logs what a person would want to see when something looks wrong, and stays
silent the rest of the time.

- [The Shape](#the-shape)
- [Where It Goes](#where-it-goes)
- [What Gets Logged](#what-gets-logged)
- [The Log View](#the-log-view)

### The Shape

Three pieces, deliberately separate:

- **The sink** persists entries and reads them back. It is the source of truth.
- **The bus** fans each entry out to whoever is listening right now, so an open view updates live
  instead of polling. It is in memory only and keeps no history.
- **The logger** is the interface the rest of the plugin logs through, with the four usual levels.

Listener errors are isolated. One throwing listener must not stop the others, nor break the logging
call that triggered it.

The logger's API is synchronous, so an append cannot be awaited. Listeners are notified only once
the append has persisted, so a listener that re-reads the sink is guaranteed to see the entry rather
than racing the write. A failed persist goes to the console rather than being left as an unhandled
rejection, and is never logged back into the sink, which would recurse if the sink itself is what is
failing.

### Where It Goes

A capped file inside the plugin's own data directory, written through the vault adapter. When there
is nowhere to persist to, which happens on some embedded and test hosts that never set a plugin
directory, it falls back to an in-memory sink with the same interface.

Appending is cheap; a full read, trim, and write is not. So the file is trimmed back down to its
line cap in batches, every 50 appends, rather than after every line. The file cannot grow unbounded
over a long running session either way.

### What Gets Logged

The interesting decision is what is left out.

**A pass that changed nothing does not log.** That is the ordinary case once sync is automatic, and
a line for each one would push everything worth reading out of a capped file inside two days.

**A pass someone asked for always logs**, whatever it did, because they are standing there waiting
for an answer.

**Nothing is logged when a pass starts.** A "starting" line with no matching "complete" is how a
perfectly ordinary idle poll comes to look like a hang.

### The Log View

A pane rendering the persisted log, most recent first, updating live as entries arrive.

It is always a straight render of what the sink holds: every change re-reads and redraws rather than
mutating the DOM in place. Read only, with no way to write entries, only to display what the sink
recorded.

A redraw waits while text is selected, then catches up from the sink as soon as that selection
clears, so a redraw never yanks the selection out from under someone mid copy.

Refreshes are coalesced rather than queued. The pending flag is reset before each read and checked
immediately after, and the guard is released in the same synchronous tick as that final check with
no await in between. So an entry logged while a read is in flight always forces one more read: it
either lands before this read's snapshot and is drawn now, or it sets the flag and the loop runs
again. It can never slip through the gap as the run finishes.

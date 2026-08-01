import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { LogBus, LogEntry, LogSink } from "./log.ts";
import { selectionOverlaps } from "./selection.ts";

// LOG_VIEW_TYPE identifies geode's log pane to Obsidian's workspace leaf API.
export const LOG_VIEW_TYPE = "geode-log-view";

// renderLogView draws entries into containerEl, most recent first.
function renderLogView(containerEl: HTMLElement, entries: LogEntry[]): void {
  containerEl.empty();
  containerEl.addClass("geode-log-view");

  if (entries.length === 0) {
    containerEl.createEl("p", { text: "No log entries yet.", cls: "setting-item-description" });
    return;
  }

  const list = containerEl.createDiv({ cls: "geode-log-list" });
  for (const entry of [...entries].reverse()) {
    renderRow(list, entry);
  }
}

// renderRow draws one entry into list, colour coded by level via a geode-log-row.is-<level> class.
function renderRow(list: HTMLElement, entry: LogEntry): void {
  const row = list.createDiv({ cls: `geode-log-row is-${entry.level}` });
  row.createSpan({ cls: "geode-log-time", text: new Date(entry.time).toLocaleString() });
  row.createSpan({ cls: "geode-log-level", text: entry.level.toUpperCase() });
  row.createSpan({ cls: "geode-log-message", text: entry.message });
}

// GeodeLogView renders geode's persisted log as a plain, most recent first list, updating live as
// entries are logged. The pane is always a straight render of what the sink holds: every change
// re-reads and redraws rather than mutating the DOM in place. A redraw waits while the user has
// selected log text, then catches up from the sink as soon as that selection clears. Read only: it
// has no way to write log entries, only display what the sink recorded.
export class GeodeLogView extends ItemView {
  private sink: LogSink;
  private bus: LogBus;
  // The refresh coalescing pair: refreshInFlight guards the single running refresh, and
  // refreshQueued records that another pass is owed because an entry arrived while one was running.
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private renderDeferred = false;

  constructor(leaf: WorkspaceLeaf, sink: LogSink, bus: LogBus) {
    super(leaf);
    this.sink = sink;
    this.bus = bus;
  }

  getViewType(): string {
    return LOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Geode logs";
  }

  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    this.addAction("trash-2", "Clear", () => void this.clear());
    // Subscribe before the first read, not after: an entry logged while that read is in flight
    // then still triggers a refresh, rather than being missed until the pane is reopened. register
    // runs the unsubscribe on pane close, so a closed view stops receiving entries.
    this.register(this.bus.subscribe(() => void this.refresh()));
    this.registerDomEvent(document, "selectionchange", () => {
      if (!this.renderDeferred) {
        return;
      }
      if (selectionOverlaps(this.contentEl, document.getSelection())) {
        return;
      }
      this.renderDeferred = false;
      void this.refresh();
    });
    await this.refresh();
  }

  // clear empties the persisted log, then re-renders from the sink like any other change, so the
  // pane reflects whatever actually survived, including any entry that landed mid-clear.
  private async clear(): Promise<void> {
    await this.sink.clear();
    await this.refresh();
  }

  // refresh re-reads the sink and redraws the pane. Concurrent calls coalesce onto the run already
  // in flight: each marks that another pass is owed and awaits the same run, so a burst of entries
  // collapses into a final render of the settled log rather than one render per entry.
  private refresh(): Promise<void> {
    if (this.refreshInFlight !== null) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.runRefresh();
    return this.refreshInFlight;
  }

  // runRefresh reads and draws in a loop until no further pass was requested mid-render. The queued
  // flag is reset before each read and checked immediately after, and the guard is released in the
  // same synchronous tick as that final check, with no await in between. So an entry logged while a
  // read is in flight always forces one more read: it either lands before this read's snapshot (and
  // is drawn now) or sets the flag (and the loop runs again), never slipping through the gap as the
  // run finishes.
  private async runRefresh(): Promise<void> {
    try {
      do {
        this.refreshQueued = false;
        await this.render();
      } while (this.refreshQueued);
    } finally {
      this.refreshInFlight = null;
    }
  }

  // render does the actual read and draw, split out so runRefresh can own the coalescing loop.
  private async render(): Promise<void> {
    const entries = await this.sink.read();
    if (selectionOverlaps(this.contentEl, document.getSelection())) {
      this.renderDeferred = true;
      return;
    }
    this.renderDeferred = false;
    renderLogView(this.contentEl, entries);
  }
}

import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { LogBus, LogEntry, LogSink } from "./log.ts";

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
// re-reads and redraws rather than mutating the DOM in place, so the pane can never drift from the
// persisted log. Read only: it has no way to write log entries, only display what the sink
// recorded.
export class GeodeLogView extends ItemView {
  private sink: LogSink;
  private bus: LogBus;
  // The refresh coalescing pair, mirroring the plugin's vault state refresh: while a refresh is in
  // flight, at most one more is queued, so a burst of entries collapses into a final render of the
  // settled log instead of one render per entry.
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;

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
    await this.refresh();
  }

  // clear empties the persisted log, then re-renders from the sink like any other change, so the
  // pane reflects whatever actually survived, including any entry that landed mid-clear.
  private async clear(): Promise<void> {
    await this.sink.clear();
    await this.refresh();
  }

  // refresh re-reads the sink and redraws the pane. Concurrent calls coalesce so a burst of
  // entries collapses into a single trailing render; the final render always runs after the last
  // change settles, so the pane converges on the persisted log rather than a stale snapshot.
  private async refresh(): Promise<void> {
    if (this.refreshInFlight !== null) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }

    let runQueued = false;
    this.refreshInFlight = this.render();
    try {
      await this.refreshInFlight;
      runQueued = this.refreshQueued;
    } finally {
      this.refreshInFlight = null;
      this.refreshQueued = false;
    }

    if (runQueued) {
      return this.refresh();
    }
  }

  // render does the actual read and draw, split out so refresh can own the coalescing guard.
  private async render(): Promise<void> {
    const entries = await this.sink.read();
    renderLogView(this.contentEl, entries);
  }
}

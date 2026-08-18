import { ItemView, type WorkspaceLeaf } from "obsidian";
import { formatTime, type LogBus, type LogEntry, type LogSink, levelLabel } from "./log.ts";
import { nextRender, selectionOverlaps } from "./selection.ts";

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
  row.createSpan({ cls: "geode-log-time", text: formatTime(entry.time) });
  row.createSpan({ cls: "geode-log-level", text: levelLabel(entry.level) });
  row.createSpan({ cls: "geode-log-message", text: entry.message });
}

// GeodeLogView renders the persisted log, most recent first, always as a straight redraw of what
// the sink holds rather than a DOM mutation; see docs/technical_logging.md.
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
      const selected = selectionOverlaps(this.contentEl, document.getSelection());
      const decision = nextRender(this.renderDeferred, "selectionchange", selected);
      this.renderDeferred = decision.deferred;
      if (decision.action !== "refresh") {
        return;
      }
      void this.refresh();
    });
    await this.refresh();
  }

  // clear empties the persisted log, then rerenders from the sink like any other change, so the
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

  // runRefresh loops until no further pass was requested mid render, releasing the guard in the
  // same tick as its final check so an entry can never slip through the gap.
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
    const selected = selectionOverlaps(this.contentEl, document.getSelection());
    const decision = nextRender(this.renderDeferred, "render", selected);
    this.renderDeferred = decision.deferred;
    if (decision.action !== "draw") {
      return;
    }
    renderLogView(this.contentEl, entries);
  }
}

import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { LogEntry, LogSink } from "./log.ts";

// LOG_VIEW_TYPE identifies geode's log pane to Obsidian's workspace leaf API.
export const LOG_VIEW_TYPE = "geode-log-view";

// POLL_INTERVAL_MS is how often an open log view re-reads the sink, so entries logged while the
// pane is sitting open still show up without a manual refresh.
const POLL_INTERVAL_MS = 2000;

// renderRow draws one entry into list, colour coded by level via a geode-log-row.is-<level> class.
function renderRow(list: HTMLElement, entry: LogEntry): void {
  const row = list.createDiv({ cls: `geode-log-row is-${entry.level}` });
  row.createSpan({ cls: "geode-log-time", text: new Date(entry.time).toLocaleString() });
  row.createSpan({ cls: "geode-log-level", text: entry.level.toUpperCase() });
  row.createSpan({ cls: "geode-log-message", text: entry.message });
}

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

// GeodeLogView renders geode's persisted log as a plain, most recent first list. Read only: it
// has no way to write log entries, only display what the sink already recorded.
export class GeodeLogView extends ItemView {
  private sink: LogSink;

  constructor(leaf: WorkspaceLeaf, sink: LogSink) {
    super(leaf);
    this.sink = sink;
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
    this.addAction("refresh-cw", "Refresh", () => {
      void this.refresh();
    });
    this.addAction("trash-2", "Clear", async () => {
      await this.sink.clear();
      await this.refresh();
    });
    await this.refresh();
    this.registerInterval(window.setInterval(() => void this.refresh(), POLL_INTERVAL_MS));
  }

  // refresh re-reads the sink and redraws the pane.
  private async refresh(): Promise<void> {
    const entries = await this.sink.read();
    renderLogView(this.contentEl, entries);
  }
}

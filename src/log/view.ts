import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { LogBus, LogEntry, LogSink } from "./log.ts";

// LOG_VIEW_TYPE identifies geode's log pane to Obsidian's workspace leaf API.
export const LOG_VIEW_TYPE = "geode-log-view";

// renderRow draws one entry into list, colour coded by level via a geode-log-row.is-<level> class.
// A newest entry is prepended so the list stays most recent first without redrawing the rows
// already shown; the initial backlog is appended in the order it is handed over.
function renderRow(list: HTMLElement, entry: LogEntry, newest: boolean): void {
  const row = list.createDiv({ cls: `geode-log-row is-${entry.level}` });
  row.createSpan({ cls: "geode-log-time", text: new Date(entry.time).toLocaleString() });
  row.createSpan({ cls: "geode-log-level", text: entry.level.toUpperCase() });
  row.createSpan({ cls: "geode-log-message", text: entry.message });
  if (newest) {
    list.prepend(row);
  }
}

// GeodeLogView renders geode's persisted log as a plain, most recent first list, updating live as
// entries are logged. Read only: it has no way to write log entries, only display what the sink
// already recorded and what the bus streams to it.
export class GeodeLogView extends ItemView {
  private sink: LogSink;
  private bus: LogBus;
  private maxRows: number;
  // Assigned in onOpen, which Obsidian always runs before any other view method.
  private list!: HTMLElement;
  private emptyEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, sink: LogSink, bus: LogBus, maxRows: number) {
    super(leaf);
    this.sink = sink;
    this.bus = bus;
    this.maxRows = maxRows;
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
    this.contentEl.addClass("geode-log-view");
    this.addAction("trash-2", "Clear", () => void this.clear());
    this.list = this.contentEl.createDiv({ cls: "geode-log-list" });

    this.setEntries(await this.sink.read());
    // register runs the unsubscribe on pane close, so a closed view stops receiving entries.
    this.register(this.bus.subscribe((entry) => this.addEntry(entry)));
  }

  // addEntry prepends a single newly logged entry, keeping the pane live without re-reading the
  // sink or redrawing the rows already on screen.
  private addEntry(entry: LogEntry): void {
    renderRow(this.list, entry, true);
    this.trim();
    this.updateEmpty();
  }

  // clear empties the persisted log and the pane together.
  private async clear(): Promise<void> {
    await this.sink.clear();
    this.setEntries([]);
  }

  // setEntries redraws the whole list from scratch: the initial backlog, and the empty state after
  // Clear. Live updates go through addEntry instead.
  private setEntries(entries: LogEntry[]): void {
    this.list.empty();
    for (const entry of [...entries].reverse()) {
      renderRow(this.list, entry, false);
    }
    this.trim();
    this.updateEmpty();
  }

  // trim caps the rendered rows at maxRows, dropping the oldest, so a long lived pane can't grow
  // the DOM past what the sink itself keeps on disk.
  private trim(): void {
    while (this.list.childElementCount > this.maxRows) {
      this.list.lastElementChild?.remove();
    }
  }

  // updateEmpty shows or hides the placeholder so it is present exactly when there are no rows.
  private updateEmpty(): void {
    const empty = this.list.childElementCount === 0;
    if (empty && this.emptyEl === null) {
      this.emptyEl = this.contentEl.createEl("p", {
        text: "No log entries yet.",
        cls: "setting-item-description",
      });

      return;
    }
    if (!empty && this.emptyEl !== null) {
      this.emptyEl.remove();
      this.emptyEl = null;
    }
  }
}

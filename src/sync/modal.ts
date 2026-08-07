import { type App, ButtonComponent, Modal } from "obsidian";
import { destructiveLabel, type MassChange, massChangeCopy } from "./guard.ts";

// PATH_LIMIT is how many files the dialog lists before summarising the rest: enough to recognise
// which corner of the vault this is, short of a scroll nobody reads.
const PATH_LIMIT = 20;

// Control is what a rendered button does to the dialog around it.
type Control = {
  cancel: () => void;
  confirm: () => void;
};

// render draws what the pass would destroy and the two answers to it, always as a full redraw of
// the dialog rather than a DOM mutation, the same posture the log view takes.
function render(el: HTMLElement, change: MassChange, control: Control): void {
  el.empty();
  el.addClass("geode-mass-change");

  const copy = massChangeCopy(change);
  el.createEl("p", { text: copy.lead });
  el.createEl("p", { cls: "geode-mass-change-note", text: copy.note });
  renderPaths(el, change);
  el.createEl("p", { text: copy.halted });

  const buttons = el.createDiv({ cls: "geode-mass-change-buttons" });
  // Cancel is the emphasised answer: someone reading a dialog they did not expect should land on
  // the button that changes nothing.
  new ButtonComponent(buttons)
    .setButtonText("Cancel")
    .setCta()
    .onClick(() => control.cancel());
  new ButtonComponent(buttons)
    .setButtonText("Sync anyway")
    .setWarning()
    .onClick(() => control.confirm());
}

// renderPaths draws the files themselves, collapsed: a count says how big the change is, and only
// the names say whether it is the right one.
function renderPaths(el: HTMLElement, change: MassChange): void {
  if (change.paths.length === 0) {
    return;
  }

  const details = el.createEl("details", { cls: "geode-mass-change-paths" });
  details.createEl("summary", { text: "Show the files" });
  const list = details.createEl("ul");
  for (const entry of change.paths.slice(0, PATH_LIMIT)) {
    const item = list.createEl("li");
    item.createSpan({ cls: "geode-mass-change-verb", text: destructiveLabel(entry.kind) });
    item.createSpan({ text: entry.path });
  }
  if (change.paths.length > PATH_LIMIT) {
    details.createEl("p", {
      cls: "geode-mass-change-more",
      text: `and ${change.paths.length - PATH_LIMIT} more`,
    });
  }
}

// GeodeMassChangeModal asks before a pass destroys a large share of a vault; see
// docs/technical_sync.md for what counts as large and why the answer is never assumed.
export class GeodeMassChangeModal extends Modal {
  private change: MassChange;
  private confirm: () => void;
  private confirmed = false;

  constructor(app: App, change: MassChange, confirm: () => void) {
    super(app);
    this.change = change;
    this.confirm = confirm;
  }

  onOpen(): void {
    this.titleEl.setText("This sync would change a lot of files");
    render(this.contentEl, this.change, {
      cancel: () => this.close(),
      confirm: () => {
        this.confirmed = true;
        this.close();
      },
    });
  }

  // Dismissing the dialog any other way is a cancel, so the pass only runs when someone actually
  // reached for the button that says so.
  onClose(): void {
    this.contentEl.empty();
    if (this.confirmed) {
      this.confirm();
    }
  }
}

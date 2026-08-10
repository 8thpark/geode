import { type App, ButtonComponent, Modal } from "obsidian";
import {
  type Counts,
  copyFor,
  DONE_STEPS,
  doneLead,
  type Preview,
  type RemoteRead,
  type Stage,
  type SyncReport,
  stageForCheck,
  stageForFailedCheck,
  stageForFailedSync,
  stageForSync,
} from "./onboarding.ts";

// Actions is everything the dialog needs from the plugin, and the whole of what it knows about
// geode: two reads to build a preview from, one pass to run, and two places to send someone.
export type Actions = {
  localPaths: () => Promise<string[]>;
  openLogs: () => void;
  openSettings: () => void;
  readRemote: () => Promise<RemoteRead>;
  sync: () => Promise<SyncReport>;
};

// Control is what a rendered button does to the dialog around it.
type Control = {
  check: () => void;
  close: () => void;
  sync: () => void;
};

// renderCount draws one labelled number of the counts row.
function renderCount(row: HTMLElement, label: string, value: number): void {
  const cell = row.createDiv({ cls: "geode-onboarding-count" });
  cell.createDiv({ cls: "geode-onboarding-count-value", text: String(value) });
  cell.createDiv({ cls: "geode-onboarding-count-label", text: label });
}

// renderCounts draws the three numbers a merge is worth knowing before agreeing to it.
function renderCounts(el: HTMLElement, counts: Counts): void {
  const row = el.createDiv({ cls: "geode-onboarding-counts" });
  renderCount(row, "Upload", counts.upload);
  renderCount(row, "Download", counts.download);
  renderCount(row, "On both sides", counts.shared);
}

// renderDone draws the finished state, the one place the dialog explains how geode behaves from
// here on.
function renderDone(el: HTMLElement, changeCount: number, control: Control): void {
  el.createEl("p", { text: doneLead(changeCount) });

  const list = el.createEl("ul", { cls: "geode-onboarding-steps" });
  for (const step of DONE_STEPS) {
    list.createEl("li", { text: step });
  }

  const buttons = el.createDiv({ cls: "geode-onboarding-buttons" });
  new ButtonComponent(buttons)
    .setButtonText("Done")
    .setCta()
    .onClick(() => control.close());
}

// renderFailed draws a failed pass, keeping someone in the dialog rather than returning them to a
// status bar icon that can only say that something went wrong.
function renderFailed(el: HTMLElement, message: string, actions: Actions, control: Control): void {
  el.createEl("p", { cls: "geode-onboarding-error", text: `Sync failed: ${message}` });

  const buttons = el.createDiv({ cls: "geode-onboarding-buttons" });
  new ButtonComponent(buttons).setButtonText("View logs").onClick(() => {
    control.close();
    actions.openLogs();
  });
  new ButtonComponent(buttons)
    .setButtonText("Try again")
    .setCta()
    .onClick(() => control.sync());
}

// renderPreview draws what a first sync would do, and the buttons that answer it.
function renderPreview(
  el: HTMLElement,
  preview: Preview,
  actions: Actions,
  control: Control,
): void {
  const copy = copyFor(preview);
  el.createEl("p", { text: copy.lead });

  if (preview.kind === "merge") {
    renderCounts(el, preview.counts);
  }
  for (const line of copy.caution) {
    el.createEl("p", { cls: "geode-onboarding-caution", text: line });
  }

  const buttons = el.createDiv({ cls: "geode-onboarding-buttons" });
  if (preview.kind === "blocked") {
    new ButtonComponent(buttons).setButtonText("Close").onClick(() => control.close());
    new ButtonComponent(buttons)
      .setButtonText("Open settings")
      .setCta()
      .onClick(() => {
        control.close();
        actions.openSettings();
      });
    return;
  }
  if (preview.kind === "unreachable") {
    new ButtonComponent(buttons).setButtonText("Close").onClick(() => control.close());
    new ButtonComponent(buttons)
      .setButtonText("Try again")
      .setCta()
      .onClick(() => control.check());
    return;
  }

  new ButtonComponent(buttons).setButtonText("Not now").onClick(() => control.close());
  new ButtonComponent(buttons)
    .setButtonText("Sync now")
    .setCta()
    .onClick(() => control.sync());
}

// renderStage draws the dialog for stage, always as a full redraw of what the stage holds rather
// than a DOM mutation, the same posture the log view takes.
function renderStage(el: HTMLElement, stage: Stage, actions: Actions, control: Control): void {
  el.empty();
  el.addClass("geode-onboarding");

  if (stage.kind === "checking") {
    el.createEl("p", { text: "Checking the bucket..." });
    return;
  }
  if (stage.kind === "preview") {
    renderPreview(el, stage.preview, actions, control);
    return;
  }
  if (stage.kind === "syncing") {
    el.createEl("p", {
      text: "Syncing. This can take a while on a large vault, and it carries on if you close this.",
    });
    return;
  }
  if (stage.kind === "done") {
    renderDone(el, stage.changeCount, control);
    return;
  }

  renderFailed(el, stage.message, actions, control);
}

// GeodeOnboardingModal walks someone through the one pass geode will never start for them; see
// docs/technical_plugin.md for why the first sync is asked for rather than assumed.
export class GeodeOnboardingModal extends Modal {
  private actions: Actions;
  private stage: Stage = { kind: "checking" };

  constructor(app: App, actions: Actions) {
    super(app);
    this.actions = actions;
  }

  onOpen(): void {
    this.titleEl.setText("Set up sync");
    this.check();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // check builds the preview, and is also what the unreachable state's retry runs.
  private check(): void {
    this.setStage({ kind: "checking" });
    void this.checkAsync();
  }

  // Both steps report failure as a value, so a rejection here is something neither expected. It
  // still has to land somewhere the dialog offers a way out of, or setup stops at "Checking...".
  private async checkAsync(): Promise<void> {
    try {
      const [paths, remote] = await Promise.all([
        this.actions.localPaths(),
        this.actions.readRemote(),
      ]);
      this.setStage(stageForCheck(paths, remote));
    } catch (err) {
      this.setStage(stageForFailedCheck(err));
    }
  }

  private async run(): Promise<void> {
    this.setStage({ kind: "syncing" });
    try {
      this.setStage(stageForSync(await this.actions.sync()));
    } catch (err) {
      this.setStage(stageForFailedSync(err));
    }
  }

  private setStage(stage: Stage): void {
    this.stage = stage;
    renderStage(this.contentEl, this.stage, this.actions, {
      check: () => this.check(),
      close: () => this.close(),
      sync: () => void this.run(),
    });
  }
}

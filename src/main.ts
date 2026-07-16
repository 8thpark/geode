import type { App } from "obsidian";
import { Plugin } from "obsidian";
import { createLogger, type Logger, type LogSink } from "./log";
import { createLogSink } from "./log-adapter";
import { GeodeLogView, LOG_VIEW_TYPE } from "./log-view";
import { DEFAULT_SETTINGS, type GeodeSettings, normalizeSettings } from "./settings";
import { GeodeSettingTab } from "./settings-tab";
import { createObsidianStateStore, createObsidianVaultReader } from "./vault-adapter";
import { diffSnapshots, takeSnapshot } from "./vault-state";

// VAULT_STATE_DEBOUNCE_MS delays a vault state refresh after the last file event, so a burst of
// edits (autosave, bulk rename, etc.) collapses into one snapshot instead of one per file.
const VAULT_STATE_DEBOUNCE_MS = 2000;

// MAX_LOG_LINES caps how many lines geode.log keeps on disk, so a long running session can't
// grow it unbounded.
const MAX_LOG_LINES = 500;

// LOG_MIN_LEVEL is fixed rather than user configurable: there's no meaningful "quiet" mode to
// offer today, so a verbosity setting would be a toggle with no observable effect.
const LOG_MIN_LEVEL = "debug";

// AppWithSetting adds Obsidian's internal, undocumented settings-window API (there is no public
// equivalent) so the Settings command can jump straight to Geode's tab, and opening the log view
// can close the settings modal out from under itself.
type AppWithSetting = App & {
  setting: { open: () => void; close: () => void; openTabById: (id: string) => void };
};

// GeodePlugin is the Obsidian plugin entry point that owns settings load and save.
export default class GeodePlugin extends Plugin {
  settings: GeodeSettings = DEFAULT_SETTINGS;
  // Both are assigned in onload, which Obsidian always runs before any other plugin method.
  logger!: Logger;
  private logSink!: LogSink;
  private refreshTimer: number | undefined;

  async onload() {
    await this.loadSettings();

    this.logSink = createLogSink(this.app.vault.adapter, this.manifest.dir, MAX_LOG_LINES);
    this.logger = createLogger(this.logSink, LOG_MIN_LEVEL);

    this.registerView(LOG_VIEW_TYPE, (leaf) => new GeodeLogView(leaf, this.logSink));
    this.addCommand({
      id: "logs",
      name: "Logs",
      callback: () => void this.openLogView(),
    });
    this.addCommand({
      id: "settings",
      name: "Settings",
      callback: () => this.openSettingsTab(),
    });
    this.register(() => this.app.workspace.detachLeavesOfType(LOG_VIEW_TYPE));

    this.addSettingTab(new GeodeSettingTab(this.app, this));
    this.logger.info(`loaded (provider=${this.settings.provider})`);

    // onLayoutReady, not onload directly: the vault isn't guaranteed fully indexed yet at
    // onload time, and a snapshot taken too early would see an incomplete file list.
    this.app.workspace.onLayoutReady(() => {
      void this.refreshVaultState();

      this.registerEvent(this.app.vault.on("create", () => this.scheduleVaultStateRefresh()));
      this.registerEvent(this.app.vault.on("modify", () => this.scheduleVaultStateRefresh()));
      this.registerEvent(this.app.vault.on("delete", () => this.scheduleVaultStateRefresh()));
      this.registerEvent(this.app.vault.on("rename", () => this.scheduleVaultStateRefresh()));
    });

    this.register(() => {
      if (this.refreshTimer !== undefined) {
        window.clearTimeout(this.refreshTimer);
      }
    });
  }

  // openLogView reveals the existing log leaf if one is already open, otherwise creates one in
  // the right sidebar. The settings window is a modal sitting on top of the whole app, so
  // revealing a leaf underneath it does nothing visible until it's closed first.
  async openLogView(): Promise<void> {
    (this.app as AppWithSetting).setting.close();

    const existing = this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      return;
    }
    await leaf.setViewState({ type: LOG_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  // openSettingsTab opens Obsidian's settings window directly on Geode's tab.
  openSettingsTab(): void {
    const app = this.app as AppWithSetting;
    app.setting.open();
    app.setting.openTabById(this.manifest.id);
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.logger.info("settings saved");
  }

  // scheduleVaultStateRefresh debounces refreshVaultState so a burst of vault events collapses
  // into a single snapshot instead of one per file.
  private scheduleVaultStateRefresh() {
    if (this.refreshTimer !== undefined) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshVaultState();
    }, VAULT_STATE_DEBOUNCE_MS);
  }

  // refreshVaultState snapshots the vault, compares it against what geode saw last time, and
  // persists the result — the memory push/pull sync will read from and diff against remote.
  async refreshVaultState() {
    const dir = this.manifest.dir;
    if (dir === undefined) {
      return;
    }

    const store = createObsidianStateStore(this.app.vault.adapter, `${dir}/state.json`);
    const reader = createObsidianVaultReader(this.app.vault);

    const previous = await store.read();
    const current = await takeSnapshot(reader, previous);
    const changes = diffSnapshots(previous, current);

    this.logger.info(`vault state refreshed (${changes.length} change(s) since last run)`);
    await store.write(current);
  }
}

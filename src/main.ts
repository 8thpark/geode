import type { App } from "obsidian";
import { Plugin, setIcon, setTooltip } from "obsidian";
import { createLogSink } from "./log/adapter";
import { createLogger, type Logger, type LogSink } from "./log/log";
import { GeodeLogView, LOG_VIEW_TYPE } from "./log/view";
import {
  DEFAULT_SETTINGS,
  type GeodeSettings,
  hasConnectionConfig,
  normalizeSettings,
} from "./settings/settings";
import { GeodeSettingTab } from "./settings/tab";
import { createS3Client } from "./storage/storage";
import { syncOnce } from "./sync/sync";
import {
  createObsidianLocalWriter,
  createObsidianReader,
  createObsidianStore,
} from "./vault/obsidian";
import { diffSnapshots, takeSnapshot } from "./vault/vault";

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

// SyncStatus is the state the status bar item reflects.
type SyncStatus = "idle" | "syncing" | "error";

// iconFor returns the status bar icon for status.
function iconFor(status: SyncStatus): string {
  if (status === "syncing") {
    return "refresh-cw";
  }
  if (status === "error") {
    return "cloud-alert";
  }
  return "cloud";
}

// tooltipFor returns the status bar hover text for status. detail is folded into the error case.
function tooltipFor(status: SyncStatus, detail: string): string {
  if (status === "syncing") {
    return "Geode: syncing...";
  }
  if (status === "error") {
    return `Geode: ${detail}`;
  }
  return "Geode: click to sync";
}

// GeodePlugin is the Obsidian plugin entry point that owns settings load and save.
export default class GeodePlugin extends Plugin {
  settings: GeodeSettings = DEFAULT_SETTINGS;
  // Assigned in onload, which Obsidian always runs before any other plugin method.
  logger!: Logger;
  private logSink!: LogSink;
  private statusBarEl!: HTMLElement;
  private refreshTimer: number | undefined;
  private syncing = false;

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
    this.addCommand({
      id: "sync",
      name: "Sync",
      callback: () => void this.syncNow(),
    });
    this.register(() => this.app.workspace.detachLeavesOfType(LOG_VIEW_TYPE));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("geode-status-bar", "mod-clickable");
    this.statusBarEl.addEventListener("click", () => void this.syncNow());
    this.setSyncStatus("idle", "");

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

  // setSyncStatus updates the status bar icon and tooltip to reflect status.
  private setSyncStatus(status: SyncStatus, detail: string): void {
    this.statusBarEl.removeClass("is-idle", "is-syncing", "is-error");
    this.statusBarEl.addClass(`is-${status}`);
    setIcon(this.statusBarEl, iconFor(status));
    setTooltip(this.statusBarEl, tooltipFor(status, detail));
  }

  // syncNow pushes every local change since the last sync to remote storage, pulls every remote
  // change since then down locally, and renames the local side of anything that changed on both
  // ends to a conflict copy rather than ever guessing which edit should win. Refuses to start a
  // second sync while one is already running.
  async syncNow(): Promise<void> {
    if (this.syncing) {
      return;
    }
    if (!hasConnectionConfig(this.settings)) {
      this.logger.warn("sync: storage isn't configured yet");
      this.setSyncStatus("error", "storage isn't configured yet");
      return;
    }
    const dir = this.manifest.dir;
    if (dir === undefined) {
      this.logger.error("sync: no plugin data directory available");
      this.setSyncStatus("error", "no plugin data directory available");
      return;
    }

    this.syncing = true;
    this.setSyncStatus("syncing", "");
    try {
      await this.runSync(dir);
    } catch (err) {
      let message = "unexpected error";
      if (err instanceof Error) {
        message = err.message;
      }
      this.logger.error(`sync: ${message}`);
      this.setSyncStatus("error", message);
    } finally {
      this.syncing = false;
    }
  }

  // runSync does the actual work of syncNow, split out so syncNow can own the in flight guard
  // and status bar bookkeeping around it without this getting lost in indentation.
  private async runSync(dir: string): Promise<void> {
    const secretAccessKey = this.app.secretStorage.getSecret(this.settings.secretId) ?? "";
    const storage = createS3Client(this.settings, secretAccessKey);
    const stateStore = createObsidianStore(this.app.vault.adapter, `${dir}/state.json`);
    const reader = createObsidianReader(this.app.vault);
    const localWriter = createObsidianLocalWriter(this.app.vault.adapter);

    const previous = await stateStore.read();
    const outcome = await syncOnce(previous, reader, localWriter, storage, Date.now());
    if (!outcome.ok) {
      for (const failure of outcome.failures) {
        this.logger.error(`sync: ${failure.path}: ${failure.message}`);
      }
      this.logger.error(`sync: ${outcome.message}`);
      this.setSyncStatus("error", outcome.message);
      return;
    }

    await stateStore.write(outcome.snapshot);
    this.logger.info(`sync: complete (${outcome.changeCount} change(s) applied)`);
    this.setSyncStatus("idle", "");
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

  // refreshVaultState logs how many local changes have accumulated since the last successful
  // sync. It deliberately does NOT persist anything: state.json is the last synced snapshot, the
  // common ancestor sync diffs both sides against, and only a completed sync may write it. Writing
  // the live vault here would poison that ancestor, so a brand new local file would look like a
  // remote deletion on the next sync and get wiped.
  async refreshVaultState() {
    const dir = this.manifest.dir;
    if (dir === undefined) {
      return;
    }

    const store = createObsidianStore(this.app.vault.adapter, `${dir}/state.json`);
    const reader = createObsidianReader(this.app.vault);

    // Both callers fire this and forget (void), so a rejection here would surface as an
    // unhandled promise rejection. takeSnapshot can throw when a file vanishes mid-snapshot
    // (a live vault race), so convert any failure to a logged result at this boundary.
    try {
      const previous = await store.read();
      const current = await takeSnapshot(reader, previous);
      const changes = diffSnapshots(previous, current);

      this.logger.info(`vault state refreshed (${changes.length} change(s) since last run)`);
    } catch (err) {
      this.logger.error(`vault state refresh failed: ${err}`);
    }
  }
}

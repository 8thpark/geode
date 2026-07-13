import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type GeodeSettings, normalizeSettings } from "./settings";
import { GeodeSettingTab } from "./settings-tab";
import { createObsidianStateStore, createObsidianVaultReader } from "./vault-adapter";
import { diffSnapshots, takeSnapshot } from "./vault-state";

// VAULT_STATE_DEBOUNCE_MS delays a vault state refresh after the last file event, so a burst of
// edits (autosave, bulk rename, etc.) collapses into one snapshot instead of one per file.
const VAULT_STATE_DEBOUNCE_MS = 2000;

// GeodePlugin is the Obsidian plugin entry point that owns settings load and save.
export default class GeodePlugin extends Plugin {
  settings: GeodeSettings = DEFAULT_SETTINGS;
  private refreshTimer: number | undefined;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GeodeSettingTab(this.app, this));
    console.log(`geode: loaded (provider=${this.settings.provider})`);

    // onLayoutReady, not onload directly: the vault isn't guaranteed fully indexed yet at
    // onload time, and a snapshot taken too early would see an incomplete file list.
    this.app.workspace.onLayoutReady(() => {
      void this.refreshVaultState();
    });

    this.registerEvent(this.app.vault.on("create", () => this.scheduleVaultStateRefresh()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleVaultStateRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleVaultStateRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleVaultStateRefresh()));

    this.register(() => {
      if (this.refreshTimer !== undefined) {
        window.clearTimeout(this.refreshTimer);
      }
    });
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    console.log("geode: settings saved");
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

    console.log(`geode: vault state refreshed (${changes.length} change(s) since last run)`);
    await store.write(current);
  }
}

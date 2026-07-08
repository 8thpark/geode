import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type GeodeSettings, normalizeSettings } from "./settings";
import { GeodeSettingTab } from "./settings-tab";

// GeodePlugin is the Obsidian plugin entry point that owns settings load and save.
export default class GeodePlugin extends Plugin {
  settings: GeodeSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GeodeSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

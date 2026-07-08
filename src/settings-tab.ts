import { type App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type GeodePlugin from "./main";

// renderSettingsTab draws every settings row into containerEl and persists edits via plugin.
export function renderSettingsTab(
  plugin: GeodePlugin,
  containerEl: HTMLElement,
  rerender: () => void,
): void {
  const { settings } = plugin;

  new Setting(containerEl)
    .setName("Provider")
    .setDesc("Where your vault is synced to.")
    .addDropdown((dropdown) =>
      dropdown
        .addOptions({ r2: "Cloudflare R2", custom: "Custom" })
        .setValue(settings.provider)
        .onChange(async (value) => {
          settings.provider = "r2";
          if (value === "custom") {
            settings.provider = "custom";
          }
          await plugin.saveSettings();
          rerender();
        }),
    );

  if (settings.provider === "r2") {
    new Setting(containerEl)
      .setName("Account ID")
      .setDesc("Your Cloudflare account ID.")
      .addText((text) =>
        text
          .setPlaceholder("abc123...")
          .setValue(settings.accountId)
          .onChange(async (value) => {
            settings.accountId = value;
            await plugin.saveSettings();
          }),
      );
  }

  if (settings.provider === "custom") {
    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc("The S3 compatible endpoint URL for your storage.")
      .addText((text) =>
        text
          .setPlaceholder("https://s3.example.com")
          .setValue(settings.endpoint)
          .onChange(async (value) => {
            settings.endpoint = value;
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Region")
      .setDesc("The region your bucket lives in.")
      .addText((text) =>
        text
          .setPlaceholder("us-east-1")
          .setValue(settings.region)
          .onChange(async (value) => {
            settings.region = value;
            await plugin.saveSettings();
          }),
      );
  }

  new Setting(containerEl)
    .setName("Bucket")
    .setDesc("The name of the bucket to sync your vault to.")
    .addText((text) =>
      text
        .setPlaceholder("my-vault")
        .setValue(settings.bucket)
        .onChange(async (value) => {
          settings.bucket = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName("Access key ID")
    .setDesc("The access key ID for your storage credentials.")
    .addText((text) =>
      text
        .setPlaceholder("AKIA...")
        .setValue(settings.accessKeyId)
        .onChange(async (value) => {
          settings.accessKeyId = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName("Secret access key")
    .setDesc("Held in Obsidian's secret storage; only its name is saved in plugin data.")
    .addComponent((el) =>
      new SecretComponent(plugin.app, el).setValue(settings.secretId).onChange(async (value) => {
        settings.secretId = value;
        await plugin.saveSettings();
      }),
    );
}

// GeodeSettingTab renders and persists the plugin's settings UI.
export class GeodeSettingTab extends PluginSettingTab {
  plugin: GeodePlugin;

  constructor(app: App, plugin: GeodePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    renderSettingsTab(this.plugin, this.containerEl, () => this.display());
  }
}

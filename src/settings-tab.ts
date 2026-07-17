import {
  type App,
  apiVersion,
  ButtonComponent,
  Platform,
  PluginSettingTab,
  SecretComponent,
  Setting,
} from "obsidian";
import type GeodePlugin from "./main";
import {
  draftForDisplay,
  type GeodeSettings,
  hasConnectionConfig,
  providerOr,
  settingsEqual,
} from "./settings";
import { testConnection } from "./storage";

// ConnectionStatus is the last known state of a Test Connection check. It lives only in memory;
// it is never persisted and resets to "unknown" whenever the draft changes.
type ConnectionStatus = "unknown" | "checking" | "ok" | "error";

// renderHeader draws the plugin title, subtitle, and external link buttons. The title is a plain
// div rather than an h1: Obsidian's settings pane suppresses nested h1 elements.
function renderHeader(containerEl: HTMLElement): void {
  const header = containerEl.createDiv({ cls: "geode-settings-header" });

  const titles = header.createDiv();
  titles.createDiv({ text: "Geode", cls: "geode-title" });
  titles.createEl("p", {
    text: "Remote sync, MCP, and an API for your vault.",
    cls: "setting-item-description",
  });

  const links = header.createDiv({ cls: "geode-settings-links" });
  new ButtonComponent(links).setButtonText("GitHub").onClick(() => {
    window.open("https://github.com/8thpark/geode", "_blank");
  });
  new ButtonComponent(links).setButtonText("Support").onClick(() => {
    const target = containerEl.querySelector<HTMLElement>(
      ".geode-support-anchor",
    );
    if (target !== null) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  new ButtonComponent(links)
    .setButtonText("Docs")
    .setCta()
    .onClick(() => {
      window.open("https://docs.geodemd.com", "_blank");
    });
}

// onFieldChanged clears any stale connection status and updates the actions row without
// redrawing the whole tab, so text inputs never lose focus mid keystroke. Whether the draft
// counts as dirty is derived by comparing it to saved settings, not tracked here.
function onFieldChanged(tab: GeodeSettingTab): void {
  tab.connectionStatus = "unknown";
  tab.connectionMessage = "";
  tab.refreshActionsUI();
}

// renderProviderFields draws the fields specific to the selected provider.
function renderProviderFields(
  tab: GeodeSettingTab,
  containerEl: HTMLElement,
): void {
  if (tab.draft.provider === "r2") {
    new Setting(containerEl)
      .setName("Account ID")
      .setDesc("Your Cloudflare account ID, found on the R2 overview page.")
      .addText((text) =>
        text
          .setPlaceholder("abc123...")
          .setValue(tab.draft.accountId)
          .onChange((value) => {
            tab.draft.accountId = value;
            onFieldChanged(tab);
          }),
      );
    return;
  }

  new Setting(containerEl)
    .setName("Endpoint")
    .setDesc("The S3 compatible endpoint URL for your storage.")
    .addText((text) =>
      text
        .setPlaceholder("https://s3.example.com")
        .setValue(tab.draft.endpoint)
        .onChange((value) => {
          tab.draft.endpoint = value;
          onFieldChanged(tab);
        }),
    );

  new Setting(containerEl)
    .setName("Region")
    .setDesc("The region your bucket lives in.")
    .addText((text) =>
      text
        .setPlaceholder("us-east-1")
        .setValue(tab.draft.region)
        .onChange((value) => {
          tab.draft.region = value;
          onFieldChanged(tab);
        }),
    );
}

// renderSecretRow draws the secret access key control. SecretComponent's setValue only
// pre-highlights an existing entry in its picker; it cannot force a newly created secret onto a
// fixed ID, since Obsidian's own "add secret" dialog always asks the user to name it. So we have
// to remember whichever ID the user actually picks, the same way we track every other field.
function renderSecretRow(tab: GeodeSettingTab, containerEl: HTMLElement): void {
  new Setting(containerEl)
    .setName("Secret access key")
    .setDesc(
      "Stored in Obsidian's built in secret manager, never in plugin data or synced files.",
    )
    .addComponent((el) => {
      const component = new SecretComponent(tab.app, el)
        .setValue(tab.draft.secretId)
        .onChange((value) => {
          tab.draft.secretId = value;
          onFieldChanged(tab);
        });

      // SecretComponent has no label API (obsidian.d.ts), so this renames its button after the
      // fact; it degrades gracefully to the default "Link..." label if Obsidian's markup changes.
      const button = el.querySelector("button");
      if (button !== null) {
        button.textContent = "Add secret";
      }
      return component;
    });
}

// connectionMessageFor returns the connection half of the status line for the given state.
function connectionMessageFor(tab: GeodeSettingTab): string {
  if (tab.connectionStatus === "checking") {
    return "Checking connection...";
  }
  if (tab.connectionStatus === "ok") {
    return "Connected";
  }
  if (tab.connectionStatus === "error") {
    return tab.connectionMessage;
  }
  return "Not tested yet";
}

// renderActions draws the status dot, status line, Test Connection button, and Save button, and
// stashes references on tab so later field edits can update them in place. The connection
// message and the dirty reminder are separate spans on one line so each keeps its own colour.
function renderActions(tab: GeodeSettingTab, containerEl: HTMLElement): void {
  const setting = new Setting(containerEl).setName("Connection");

  tab.statusDotEl = setting.nameEl.createSpan({ cls: "geode-status-dot" });
  setting.nameEl.prepend(tab.statusDotEl);

  const statusLine = setting.descEl.createSpan({ cls: "geode-status-line" });
  tab.connectionMessageEl = statusLine.createSpan({
    cls: "geode-connection-message",
  });
  tab.statusSeparatorEl = statusLine.createSpan({
    cls: "geode-status-separator",
    text: " · ",
  });
  tab.dirtyTextEl = statusLine.createSpan({
    cls: "geode-dirty-text",
    text: "Unsaved changes",
  });

  setting.addButton((button) =>
    button.setButtonText("Test").onClick(async () => {
      await tab.checkConnection();
    }),
  );

  setting.addButton((button) => {
    tab.saveButtonEl = button;
    // Obsidian's own disabled-button styling forces cursor: not-allowed with its own
    // !important rule; an inline style is the only thing guaranteed to win over that.
    button.buttonEl.style.setProperty("cursor", "pointer", "important");
    button
      .setButtonText("Save")
      .setCta()
      .onClick(async () => {
        await tab.save();
      });
  });

  tab.refreshActionsUI();
}

// renderStorageSection draws the card of storage related settings.
function renderStorageSection(
  tab: GeodeSettingTab,
  containerEl: HTMLElement,
): void {
  const card = containerEl.createDiv({ cls: "geode-card" });

  new Setting(card)
    .setName("Provider")
    .setDesc("Where your vault is synced to.")
    .addDropdown((dropdown) =>
      dropdown
        .addOptions({ r2: "Cloudflare R2", custom: "Custom" })
        .setValue(tab.draft.provider)
        .onChange((value) => {
          tab.draft.provider = providerOr(value);
          tab.connectionStatus = "unknown";
          tab.connectionMessage = "";
          tab.display(false);
        }),
    );

  renderProviderFields(tab, card);

  new Setting(card)
    .setName("Bucket")
    .setDesc("The name of the bucket to sync your vault to.")
    .addText((text) =>
      text
        .setPlaceholder("geode-bucket")
        .setValue(tab.draft.bucket)
        .onChange((value) => {
          tab.draft.bucket = value;
          onFieldChanged(tab);
        }),
    );

  new Setting(card)
    .setName("Access key ID")
    .setDesc("The access key ID for your storage credentials.")
    .addText((text) =>
      text
        .setPlaceholder("AKIA...")
        .setValue(tab.draft.accessKeyId)
        .onChange((value) => {
          tab.draft.accessKeyId = value;
          onFieldChanged(tab);
        }),
    );

  renderSecretRow(tab, card);
  renderActions(tab, card);
}

// renderSyncSection draws the sync exclusion settings: a textarea for user glob patterns and
// a note about the built-in local_ prefix convention.
function renderSyncSection(
  tab: GeodeSettingTab,
  containerEl: HTMLElement,
): void {
  new Setting(containerEl).setName("Sync").setHeading();
  const card = containerEl.createDiv({ cls: "geode-card" });

  new Setting(card)
    .setName("Ignore patterns")
    .setDesc(
      "Glob patterns for files and folders to exclude from sync, one per line. " +
        "The local_ prefix is always excluded regardless of these patterns.",
    )
    .addTextArea((text) => {
      text
        .setPlaceholder("private/**\n*.tmp")
        .setValue(tab.draft.ignorePatterns.join("\n"))
        .onChange((value) => {
          tab.draft.ignorePatterns = value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          onFieldChanged(tab);
        });
      text.inputEl.rows = 5;
      text.inputEl.style.width = "100%";
    });
}

// platformLabel returns a short human readable name for the OS Obsidian is running on.
function platformLabel(): string {
  if (Platform.isMacOS) {
    return "macOS";
  }
  if (Platform.isWin) {
    return "Windows";
  }
  if (Platform.isLinux) {
    return "Linux";
  }
  if (Platform.isIosApp) {
    return "iOS";
  }
  if (Platform.isAndroidApp) {
    return "Android";
  }
  return "Unknown";
}

// connectionSummary returns a one line description of the last connection test, for debug info.
// Blank when nothing has been tested yet, there's nothing worth reporting.
function connectionSummary(tab: GeodeSettingTab): string {
  if (tab.connectionStatus === "error") {
    return `error - ${tab.connectionMessage}`;
  }
  if (tab.connectionStatus === "unknown") {
    return "";
  }
  return tab.connectionStatus;
}

// DEBUG_LABEL_WIDTH is the column width debug info labels are padded to, so values line up.
const DEBUG_LABEL_WIDTH = 12;

// debugLine formats one "label: value" row of debug info, padded so values align in a column.
function debugLine(label: string, value: string): string {
  return `${label.padEnd(DEBUG_LABEL_WIDTH)}${value}`;
}

// debugInfoText builds the plain text block a user pastes into a support email or issue.
function debugInfoText(tab: GeodeSettingTab): string {
  return [
    debugLine("Geode:", `v${tab.plugin.manifest.version}`),
    debugLine("Obsidian:", `v${apiVersion}`),
    debugLine("Platform:", platformLabel()),
    debugLine("Provider:", tab.plugin.settings.provider),
    debugLine("Connection:", connectionSummary(tab)),
  ].join("\n");
}

// flashButtonText sets a button's text to feedback, then reverts it to original after a delay.
function flashButtonText(
  button: ButtonComponent,
  original: string,
  feedback: string,
): void {
  button.setButtonText(feedback);
  window.setTimeout(() => button.setButtonText(original), 1500);
}

// renderSupportSection draws the Support heading and its card of docs, email, and debug info.
function renderSupportSection(
  tab: GeodeSettingTab,
  containerEl: HTMLElement,
): void {
  const heading = new Setting(containerEl).setName("Support").setHeading();
  heading.settingEl.addClass("geode-support-anchor");
  const card = containerEl.createDiv({ cls: "geode-card" });

  new Setting(card)
    .setName("Documentation")
    .setDesc("Guides for connecting storage, syncing, and troubleshooting.")
    .addButton((button) =>
      button.setButtonText("Open").onClick(() => {
        window.open("https://docs.geodemd.com", "_blank");
      }),
    );

  new Setting(card)
    .setName("Email support")
    .setDesc("help@geodemd.com")
    .addButton((button) =>
      button.setButtonText("Copy").onClick(async () => {
        try {
          await navigator.clipboard.writeText("help@geodemd.com");
          flashButtonText(button, "Copy", "Copied");
        } catch (err) {
          tab.plugin.logger.error(`could not copy support email: ${err}`);
          flashButtonText(button, "Copy", "Failed");
        }
      }),
    );

  new Setting(card)
    .setName("Logs")
    .setDesc("What geode has done, most recent first.")
    .addButton((button) =>
      button.setButtonText("View").onClick(() => {
        void tab.plugin.openLogView();
      }),
    );

  const debugSetting = new Setting(card)
    .setName("Debugging info")
    .setDesc("Include this when you contact support or open a GitHub issue.");

  tab.debugInfoEl = card.createEl("pre", {
    cls: "geode-debug-box",
    text: debugInfoText(tab),
  });

  debugSetting.addButton((button) => {
    button.setButtonText("Copy").onClick(async () => {
      try {
        await navigator.clipboard.writeText(debugInfoText(tab));
        flashButtonText(button, "Copy", "Copied");
      } catch (err) {
        tab.plugin.logger.error(`could not copy debugging info: ${err}`);
        flashButtonText(button, "Copy", "Failed");
      }
    });
  });
}

// renderSettingsTab draws every section into containerEl from the tab's current draft state.
export function renderSettingsTab(
  tab: GeodeSettingTab,
  containerEl: HTMLElement,
): void {
  renderHeader(containerEl);
  renderStorageSection(tab, containerEl);
  renderSyncSection(tab, containerEl);
  renderSupportSection(tab, containerEl);
}

// GeodeSettingTab renders the settings UI from an in-memory draft and only writes to plugin
// settings when the user clicks Save.
export class GeodeSettingTab extends PluginSettingTab {
  plugin: GeodePlugin;
  draft: GeodeSettings;
  connectionStatus: ConnectionStatus = "unknown";
  connectionMessage = "";
  // checkId is incremented on every checkConnection call so a stale response
  // that resolves after a newer one has already started can be discarded.
  checkId = 0;
  saveButtonEl: ButtonComponent | null = null;
  statusDotEl: HTMLElement | null = null;
  connectionMessageEl: HTMLElement | null = null;
  statusSeparatorEl: HTMLElement | null = null;
  dirtyTextEl: HTMLElement | null = null;
  debugInfoEl: HTMLElement | null = null;

  constructor(app: App, plugin: GeodePlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.draft = { ...plugin.settings };
  }

  // dirty reports whether the draft differs from the last saved settings. Computed rather than
  // tracked, so reverting a field back to its saved value clears it automatically.
  get dirty(): boolean {
    return !settingsEqual(this.draft, this.plugin.settings);
  }

  // display renders the tab. When auto is true (every time Obsidian opens this tab, including
  // the first time) it re-seeds the draft from live plugin settings, then fires an automatic
  // connection test if the draft looks complete. Internal re-renders (a provider switch) pass
  // false so they keep the in-progress draft and don't retrigger the connection test.
  display(auto = true): void {
    // Constructor only runs once for the life of this tab instance. Without re-seeding here,
    // a reopened tab keeps a stale draft after settings change elsewhere (e.g. data.json via
    // sync) and can show phantom "Unsaved changes" against the newer saved settings.
    this.draft = draftForDisplay(auto, this.draft, this.plugin.settings);
    if (auto) {
      this.connectionStatus = "unknown";
      this.connectionMessage = "";
    }

    this.containerEl.empty();
    renderSettingsTab(this, this.containerEl);

    if (auto && hasConnectionConfig(this.draft)) {
      void this.checkConnection();
    }
  }

  // refreshActionsUI updates the status dot, status line, Save button, and debug info block
  // without redrawing the rest of the tab. Empty rows collapse rather than reserving blank line
  // height, and the connection message and dirty reminder are updated independently so the
  // dirty reminder never inherits the connection status colour.
  refreshActionsUI(): void {
    if (this.saveButtonEl !== null) {
      this.saveButtonEl.setDisabled(!this.dirty);
    }

    if (this.statusDotEl !== null) {
      this.statusDotEl.className = `geode-status-dot is-${this.connectionStatus}`;
    }

    if (this.connectionMessageEl !== null) {
      this.connectionMessageEl.setText(connectionMessageFor(this));
      this.connectionMessageEl.className = `geode-connection-message is-${this.connectionStatus}`;
    }

    if (this.dirtyTextEl !== null) {
      let dirtyDisplay = "none";
      if (this.dirty) {
        dirtyDisplay = "inline";
      }
      this.dirtyTextEl.style.display = dirtyDisplay;
    }

    if (this.statusSeparatorEl !== null) {
      let separatorDisplay = "none";
      if (this.dirty) {
        separatorDisplay = "inline";
      }
      this.statusSeparatorEl.style.display = separatorDisplay;
    }

    if (this.debugInfoEl !== null) {
      this.debugInfoEl.setText(debugInfoText(this));
    }
  }

  async save(): Promise<void> {
    this.plugin.logger.info(
      `saving settings (provider=${this.draft.provider})`,
    );
    this.plugin.settings = { ...this.draft };
    await this.plugin.saveSettings();
    this.refreshActionsUI();
  }

  async checkConnection(): Promise<void> {
    this.checkId += 1;
    const id = this.checkId;

    this.plugin.logger.info(
      `testing connection (provider=${this.draft.provider}, bucket=${this.draft.bucket})`,
    );
    this.connectionStatus = "checking";
    this.connectionMessage = "";
    this.refreshActionsUI();

    const secretAccessKey =
      this.app.secretStorage.getSecret(this.draft.secretId) ?? "";
    if (secretAccessKey === "") {
      this.plugin.logger.warn(
        `no secret found for ID "${this.draft.secretId}"`,
      );
    }

    const result = await testConnection(this.draft, secretAccessKey);

    if (id !== this.checkId) {
      return;
    }

    if (result.ok) {
      this.plugin.logger.info("connection ok");
      this.connectionStatus = "ok";
      this.refreshActionsUI();
      return;
    }

    this.connectionStatus = "error";
    this.connectionMessage = result.message;
    this.plugin.logger.error(`connection test failed: ${result.message}`);
    this.refreshActionsUI();
  }
}

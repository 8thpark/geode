import type { App } from "obsidian";
import { Platform, Plugin, setIcon, setTooltip } from "obsidian";
import { DEVICE_ID_KEY, deviceIdFrom, deviceSuffixFrom } from "./device/device";
import { createLogSink } from "./log/adapter";
import { createLogBus, createLogger, type LogBus, type Logger, type LogSink } from "./log/log";
import { GeodeLogView, LOG_VIEW_TYPE } from "./log/view";
import { type Actions, GeodeOnboardingModal } from "./onboarding/modal";
import { type RemoteRead, readRemote, type SyncReport } from "./onboarding/onboarding";
import {
  armed,
  DEFAULT_STATE,
  due,
  noteFocus,
  notePassFinished,
  notePassStarted,
  noteReconnected,
  noteResumed,
  noteVaultChange,
  PAUSE_KEY,
  type PassResult,
  type State,
  TICK_MS,
  type Trigger,
} from "./schedule/schedule";
import {
  DEFAULT_SETTINGS,
  type GeodeSettings,
  hasConnectionConfig,
  normalizeSettings,
  prefixError,
} from "./settings/settings";
import { GeodeSettingTab } from "./settings/tab";
import { obsidianTransport } from "./storage/obsidian";
import { createS3Client, probeConditionalWrites } from "./storage/storage";
import { GeodeMassChangeModal } from "./sync/modal";
import { type SyncFault, syncOnce } from "./sync/sync";
import {
  createObsidianLocalWriter,
  createObsidianReader,
  createObsidianStore,
  flushOpenEditors,
} from "./vault/obsidian";

// LOG_MIN_LEVEL is fixed rather than user configurable: there's no meaningful "quiet" mode to
// offer today, so a verbosity setting would be a toggle with no observable effect.
const LOG_MIN_LEVEL = "debug";

// MAX_LOG_LINES caps how many lines geode.log keeps on disk, so a long running session can't
// grow it unbounded.
const MAX_LOG_LINES = 500;

// DEVICE_SUFFIX_BYTES is how much randomness separates two devices carrying the same platform
// label. Five bytes encode to exactly eight base32 characters with nothing left over.
const DEVICE_SUFFIX_BYTES = 5;

// AppWithSetting adds Obsidian's internal, undocumented settings-window API (there is no public
// equivalent) so the Settings command can jump straight to Geode's tab, and opening the log view
// can close the settings modal out from under itself.
type AppWithSetting = App & {
  setting: {
    open: () => void;
    close: () => void;
    openTabById: (id: string) => void;
  };
};

// PassOutcome pairs what the scheduler needs from a pass with what a UI watching one needs, since
// neither answer contains the other: "stop" is not a message, and a message is not a policy.
type PassOutcome = { report: SyncReport; result: PassResult };

// SyncStatus is the state the status bar item reflects.
type SyncStatus = "idle" | "syncing" | "error" | "paused";

// deviceLabel returns the human recognisable half of this device's ID, asking "phone or tablet"
// before "which desktop OS" because an iPad reports itself as macOS on some builds.
function deviceLabel(): string {
  if (Platform.isIosApp) {
    return "ios";
  }
  if (Platform.isAndroidApp) {
    return "android";
  }
  if (Platform.isMacOS) {
    return "mac";
  }
  if (Platform.isWin) {
    return "windows";
  }
  if (Platform.isLinux) {
    return "linux";
  }

  return "device";
}

// iconFor returns the status bar icon for status.
function iconFor(status: SyncStatus): string {
  if (status === "syncing") {
    return "refresh-cw";
  }
  if (status === "error") {
    return "cloud-alert";
  }
  if (status === "paused") {
    return "cloud-off";
  }
  return "cloud";
}

// passResultFor maps how a pass failed onto what the scheduler should do about it, and is the whole
// of what those two modules need from each other.
function passResultFor(fault: SyncFault): PassResult {
  if (fault === "raced") {
    return "raced";
  }
  if (fault === "permanent") {
    return "stop";
  }

  return "retry";
}

// tooltipFor returns the status bar hover text for status. detail is folded into the error case.
function tooltipFor(status: SyncStatus, detail: string): string {
  if (status === "syncing") {
    return "Geode: syncing...";
  }
  if (status === "error") {
    return `Geode: ${detail}`;
  }
  if (status === "paused") {
    return "Geode: automatic sync paused; click to sync once";
  }
  return "Geode: click to sync";
}

// GeodePlugin is the Obsidian plugin entry point that owns settings load and save; see
// docs/technical_plugin.md for the layering rule every adapter here follows.
export default class GeodePlugin extends Plugin {
  settings: GeodeSettings = DEFAULT_SETTINGS;
  // deviceId names this machine in conflict copies and logs, held in vault scoped localStorage
  // rather than settings so it can never travel to another device.
  deviceId = "";
  // Assigned in onload, which Obsidian always runs before any other plugin method.
  logger!: Logger;
  private logBus!: LogBus;
  private logSink!: LogSink;
  private statusBarEl!: HTMLElement;
  // schedule decides when an automatic pass is due, and holds the in flight flag too so "a pass
  // is running" has one home rather than two fields that can disagree.
  private schedule: State = DEFAULT_STATE;
  // paused is this device's own answer to whether automatic sync runs at all, remembered across
  // restarts in localStorage (see PAUSE_KEY). Manual sync ignores it entirely.
  private paused = false;
  // syncedBefore gates automatic sync on this bucket having completed one pass already, and is
  // reloaded on every settings change.
  private syncedBefore = false;
  // Nothing forces anyone to run the settings tab's probe, so sync verifies conditional writes
  // once per session before trusting the compare and swap. Reset on save, so a new provider
  // re-verifies.
  private conditionalWritesVerified = false;

  async onload() {
    await this.loadSettings();
    this.deviceId = this.loadDeviceId();
    this.paused = this.app.loadLocalStorage(PAUSE_KEY) === true;

    this.logSink = createLogSink(this.app.vault.adapter, this.manifest.dir, MAX_LOG_LINES);
    this.logBus = createLogBus();
    this.logger = createLogger(this.logSink, LOG_MIN_LEVEL, this.logBus.emit);

    this.registerView(LOG_VIEW_TYPE, (leaf) => new GeodeLogView(leaf, this.logSink, this.logBus));
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
      callback: () => void this.syncNow("manual"),
    });
    // Offered only while there is a first sync left to run, so the palette never lists a setup
    // step for a vault that is already set up.
    this.addCommand({
      id: "setup",
      name: "Set up sync",
      checkCallback: (checking) => {
        if (!this.canOfferOnboarding()) {
          return false;
        }
        if (!checking) {
          this.offerOnboarding();
        }
        return true;
      },
    });
    // Two commands rather than one toggle, so the palette only ever offers the one that would do
    // something, and its name says what that is without the user having to know the current state.
    this.addCommand({
      id: "pause",
      name: "Pause automatic sync",
      checkCallback: (checking) => {
        if (this.paused) {
          return false;
        }
        if (!checking) {
          this.setPaused(true);
        }
        return true;
      },
    });
    this.addCommand({
      id: "resume",
      name: "Resume automatic sync",
      checkCallback: (checking) => {
        if (!this.paused) {
          return false;
        }
        if (!checking) {
          this.setPaused(false);
        }
        return true;
      },
    });
    this.register(() => this.app.workspace.detachLeavesOfType(LOG_VIEW_TYPE));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("geode-status-bar", "mod-clickable");
    this.statusBarEl.addEventListener("click", () => void this.syncNow("manual"));
    this.setSyncStatus(this.restingStatus(), "");

    this.addSettingTab(new GeodeSettingTab(this.app, this));
    this.logger.info(`loaded (provider=${this.settings.provider}, device=${this.deviceId})`);

    // onLayoutReady, not onload: the vault is not guaranteed indexed at onload, so every file
    // would arrive as a create event the moment the index caught up.
    this.app.workspace.onLayoutReady(() => {
      void this.loadSyncedBefore();
      this.schedule = noteFocus(this.schedule, document.hasFocus(), Date.now());

      this.registerEvent(this.app.vault.on("create", () => this.noteVaultChanged()));
      this.registerEvent(this.app.vault.on("modify", () => this.noteVaultChanged()));
      this.registerEvent(this.app.vault.on("delete", () => this.noteVaultChanged()));
      this.registerEvent(this.app.vault.on("rename", () => this.noteVaultChanged()));

      // Focus is both a gate and a trigger: an unfocused window polls for nothing, and coming back
      // to a machine is the moment stale content is most likely and most visible.
      this.registerDomEvent(window, "focus", () => {
        this.schedule = noteFocus(this.schedule, true, Date.now());
      });
      this.registerDomEvent(window, "blur", () => {
        this.schedule = noteFocus(this.schedule, false, Date.now());
      });
      // Reconnecting only ends a backoff whose premise has visibly expired, and is never proof
      // anything works. Nothing gates on navigator.onLine, which reports far less than it seems.
      this.registerDomEvent(window, "online", () => {
        this.schedule = noteReconnected(this.schedule, Date.now());
      });

      this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
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

  // canOfferOnboarding reports whether a first sync is still ahead of this device: a usable
  // connection it has never completed a pass through.
  private canOfferOnboarding(): boolean {
    if (this.syncedBefore || !hasConnectionConfig(this.settings)) {
      return false;
    }

    return prefixError(this.settings.prefix) === "";
  }

  // offerOnboarding opens the first sync dialog, closing the settings window first so the status
  // bar and the log view it points at are not left underneath a modal.
  private offerOnboarding(): void {
    if (!this.canOfferOnboarding()) {
      return;
    }
    (this.app as AppWithSetting).setting.close();
    new GeodeOnboardingModal(this.app, this.onboardingActions()).open();
  }

  // onboardingActions returns what the first sync dialog needs from the plugin.
  private onboardingActions(): Actions {
    return {
      localPaths: async () => {
        const files = await createObsidianReader(this.app.vault).listFiles();
        const paths: string[] = [];
        for (const file of files) {
          paths.push(file.path);
        }
        return paths;
      },
      openLogs: () => void this.openLogView(),
      openSettings: () => this.openSettingsTab(),
      readRemote: () => this.readRemoteForPreview(),
      sync: () => this.syncNow("manual"),
    };
  }

  // readRemoteForPreview builds the storage client the preview reads through, reporting anything
  // that stops it being built as the dialog's own blocked state rather than as a failed pass.
  private async readRemoteForPreview(): Promise<RemoteRead> {
    const secretAccessKey = this.app.secretStorage.getSecret(this.settings.secretId);
    if (secretAccessKey === null || secretAccessKey === "") {
      return {
        kind: "blocked",
        message: `no secret access key found for ID "${this.settings.secretId}"`,
      };
    }
    const dir = this.manifest.dir;
    if (dir === undefined) {
      return { kind: "blocked", message: "no plugin data directory available" };
    }

    const store = createObsidianStore(this.app.vault.adapter, `${dir}/state.json`, this.settings);
    let localVaultId: string | undefined;
    try {
      const snapshot = await store.read();
      localVaultId = snapshot.vaultId;
    } catch (err) {
      this.logger.error(`onboarding: could not read sync state: ${err}`);
    }

    return readRemote(
      createS3Client(this.settings, secretAccessKey, obsidianTransport),
      localVaultId,
    );
  }

  // restingStatus returns the status bar state to fall back to once nothing is happening, which is
  // "paused" rather than "idle" on a device where automatic sync is switched off. Silence means
  // everything is fine only if a device that has stopped syncing says so.
  private restingStatus(): SyncStatus {
    if (this.paused) {
      return "paused";
    }

    return "idle";
  }

  // setPaused switches automatic sync on or off for this device and remembers the answer.
  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.app.saveLocalStorage(PAUSE_KEY, paused);
    this.setSyncStatus(this.restingStatus(), "");
    if (paused) {
      this.logger.info("automatic sync paused on this device");
      return;
    }
    this.logger.info("automatic sync resumed on this device");
  }

  // setSyncStatus updates the status bar icon and tooltip to reflect status.
  private setSyncStatus(status: SyncStatus, detail: string): void {
    this.statusBarEl.removeClass("is-idle", "is-syncing", "is-error", "is-paused");
    this.statusBarEl.addClass(`is-${status}`);
    setIcon(this.statusBarEl, iconFor(status));
    setTooltip(this.statusBarEl, tooltipFor(status, detail));
  }

  // tick asks the scheduler, every TICK_MS, whether a pass is due. Both questions it asks are
  // answered in schedule.ts; all this contributes is reading the settings that armed needs, since
  // knowing what a setting looks like is the one thing the scheduler is kept away from.
  private tick(): void {
    const configured =
      hasConnectionConfig(this.settings) && prefixError(this.settings.prefix) === "";
    if (!armed({ configured, paused: this.paused, syncedBefore: this.syncedBefore })) {
      return;
    }
    const decision = due(this.schedule, Date.now());
    if (!decision.due) {
      return;
    }
    void this.syncNow(decision.trigger);
  }

  // syncNow runs one pass, refusing to start a second while one is running. A manual pass ignores
  // a pause and clears any halt, since the escape hatch has to work in every state.
  async syncNow(trigger: Trigger = "manual", allowMassChange = false): Promise<SyncReport> {
    if (this.schedule.syncing) {
      return { ok: false, message: "a sync is already running" };
    }
    if (!hasConnectionConfig(this.settings)) {
      this.logger.warn("sync: storage isn't configured yet");
      this.setSyncStatus("error", "storage isn't configured yet");
      return { ok: false, message: "storage isn't configured yet" };
    }
    // The storage client already refuses an unusable prefix; checking here is what makes the
    // refusal legible, rather than reporting it as a failed conditional write probe.
    const badPrefix = prefixError(this.settings.prefix);
    if (badPrefix !== "") {
      this.logger.warn(`sync: ${badPrefix}`);
      this.setSyncStatus("error", badPrefix);
      return { ok: false, message: badPrefix };
    }
    const dir = this.manifest.dir;
    if (dir === undefined) {
      this.logger.error("sync: no plugin data directory available");
      this.setSyncStatus("error", "no plugin data directory available");
      return { ok: false, message: "no plugin data directory available" };
    }

    if (trigger === "manual") {
      this.schedule = noteResumed(this.schedule);
    }
    this.schedule = notePassStarted(this.schedule);
    this.setSyncStatus("syncing", "");
    let outcome: PassOutcome = {
      report: { ok: false, message: "unexpected error" },
      result: "retry",
    };
    try {
      outcome = await this.runSync(dir, trigger, allowMassChange);
    } catch (err) {
      let message = "unexpected error";
      if (err instanceof Error) {
        message = err.message;
      }
      this.logger.error(`sync: ${message}`);
      this.setSyncStatus("error", message);
      outcome = { report: { ok: false, message }, result: "retry" };
    } finally {
      this.schedule = notePassFinished(this.schedule, outcome.result, Date.now());
    }

    return outcome.report;
  }

  // runSync does the work of syncNow, split out so the guard and status bar bookkeeping stay
  // readable, and returns what the scheduler backs off from.
  private async runSync(
    dir: string,
    trigger: Trigger,
    allowMassChange: boolean,
  ): Promise<PassOutcome> {
    const secretAccessKey = this.app.secretStorage.getSecret(this.settings.secretId);
    if (secretAccessKey === null || secretAccessKey === "") {
      const message = "secret access key not found; open settings to reconfigure";
      this.logger.error(`sync: secret access key not found for ID "${this.settings.secretId}"`);
      this.setSyncStatus("error", message);
      return { report: { ok: false, message }, result: "stop" };
    }

    const storage = createS3Client(this.settings, secretAccessKey, obsidianTransport);

    if (!this.conditionalWritesVerified) {
      const probe = await probeConditionalWrites(storage);
      if (!probe.ok) {
        this.logger.error(`sync: conditional write check failed: ${probe.message}`);
        this.setSyncStatus("error", probe.message);
        return { report: { ok: false, message: probe.message }, result: "stop" };
      }
      this.conditionalWritesVerified = true;
      this.logger.info("sync: conditional write support verified");
    }

    const stateStore = createObsidianStore(
      this.app.vault.adapter,
      `${dir}/state.json`,
      this.settings,
    );
    const reader = createObsidianReader(this.app.vault);
    const localWriter = createObsidianLocalWriter(this.app.vault.adapter);

    // Flush every open editor to disk right before the snapshot below reads the vault, so a file
    // mid edit is never invisible to this pass's drift checks (see flushOpenEditors).
    await flushOpenEditors(this.app.workspace);

    const previous = await stateStore.read();
    const outcome = await syncOnce(
      previous,
      reader,
      localWriter,
      storage,
      Date.now(),
      () => crypto.randomUUID(),
      this.deviceId,
      allowMassChange,
    );
    if (!outcome.ok && outcome.fault === "blocked") {
      this.logger.warn(`sync: ${outcome.message}`);
      this.setSyncStatus("error", outcome.message);
      new GeodeMassChangeModal(this.app, outcome.change, () => {
        void this.syncNow("manual", true);
      }).open();

      return { report: { ok: false, message: outcome.message }, result: "stop" };
    }
    if (!outcome.ok) {
      // A failed pass can still have made progress worth keeping: completed work is recorded so
      // it is never replanned, while each failed file stays pending.
      if (outcome.snapshot !== null) {
        await stateStore.write(outcome.snapshot);
      }
      for (const failure of outcome.failures) {
        this.logger.error(`sync: ${failure.path}: ${failure.message}`);
      }
      this.logger.error(`sync: ${outcome.message}`);
      this.setSyncStatus("error", outcome.message);

      return {
        report: { ok: false, message: outcome.message },
        result: passResultFor(outcome.fault),
      };
    }

    await stateStore.write(outcome.snapshot);
    this.syncedBefore = true;
    // An idle pass logs nothing, since a line each would flush the capped file inside two days, but
    // a pass someone asked for always reports.
    if (outcome.changeCount > 0 || trigger === "manual") {
      this.logger.info(`sync: complete (${trigger}, ${outcome.changeCount} change(s) applied)`);
    }
    this.setSyncStatus(this.restingStatus(), "");

    return { report: { ok: true, changeCount: outcome.changeCount }, result: "ok" };
  }

  // loadDeviceId returns this device's identity, minting one on first run and treating an unusable
  // stored value as absent.
  loadDeviceId(): string {
    const stored: unknown = this.app.loadLocalStorage(DEVICE_ID_KEY);
    if (typeof stored === "string" && stored !== "") {
      return stored;
    }
    const suffix = deviceSuffixFrom(crypto.getRandomValues(new Uint8Array(DEVICE_SUFFIX_BYTES)));
    const minted = deviceIdFrom(deviceLabel(), suffix);
    this.app.saveLocalStorage(DEVICE_ID_KEY, minted);

    return minted;
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  // loadSyncedBefore records whether this bucket has completed a pass already. The state store
  // refuses a file written against different settings, so repointing reads back as never synced.
  private async loadSyncedBefore(): Promise<void> {
    const dir = this.manifest.dir;
    if (dir === undefined) {
      return;
    }
    const store = createObsidianStore(this.app.vault.adapter, `${dir}/state.json`, this.settings);
    try {
      const snapshot = await store.read();
      this.syncedBefore = snapshot.vaultId !== undefined;
    } catch (err) {
      this.syncedBefore = false;
      this.logger.error(`could not read sync state: ${err}`);
    }
  }

  // noteVaultChanged records a local file appearing, changing, moving, or going away, which is
  // what starts the quiet period before the next push. No debounce here: the scheduler owns every
  // delay, and this stays a single assignment on the hot path of a vault event.
  private noteVaultChanged(): void {
    this.schedule = noteVaultChange(this.schedule, Date.now());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // A settings change may point at a different provider, so the next sync must re-verify
    // conditional write support rather than trust the last provider's result.
    this.conditionalWritesVerified = false;
    // Saving settings is the one action most likely to have fixed whatever a halt was about, and
    // it may also have repointed the vault at a bucket it has never synced.
    this.schedule = noteResumed(this.schedule);
    await this.loadSyncedBefore();
    this.logger.info("settings saved");
    // Saving a connection is the moment someone has said what they want and nothing has happened
    // yet, which is the only moment the first sync dialog has anything to offer.
    this.offerOnboarding();
  }
}

import type { App } from "obsidian";
import { Platform, Plugin, setIcon, setTooltip } from "obsidian";
import { DEVICE_ID_KEY, deviceIdFrom, deviceSuffixFrom } from "./device/device";
import { createLogSink } from "./log/adapter";
import { createLogBus, createLogger, type LogBus, type Logger, type LogSink } from "./log/log";
import { GeodeLogView, LOG_VIEW_TYPE } from "./log/view";
import {
  DEFAULT_STATE,
  due,
  noteFocus,
  notePassFinished,
  notePassStarted,
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
import { syncOnce } from "./sync/sync";
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

// SyncStatus is the state the status bar item reflects.
type SyncStatus = "idle" | "syncing" | "error" | "paused";

// deviceLabel returns the human recognisable half of this device's ID, lowercase to match the rest
// of the suffix a conflict copy carries. The mobile checks come first: an iPad reports itself as
// macOS on some builds, so asking "is this a phone or tablet" before "which desktop OS" is what
// keeps an iPad from being labelled mac.
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

// GeodePlugin is the Obsidian plugin entry point that owns settings load and save.
export default class GeodePlugin extends Plugin {
  settings: GeodeSettings = DEFAULT_SETTINGS;
  // deviceId names this machine in conflict copies and logs (#103). Read from, and when absent
  // minted into, vault scoped localStorage rather than settings: see DEVICE_ID_KEY for why it must
  // never be able to travel to another device.
  deviceId = "";
  // Assigned in onload, which Obsidian always runs before any other plugin method.
  logger!: Logger;
  private logBus!: LogBus;
  private logSink!: LogSink;
  private statusBarEl!: HTMLElement;
  // schedule decides when an automatic pass is due (#93). It holds the in flight flag too, so
  // "a pass is running" has one home rather than a plugin field and a scheduler field that can
  // disagree.
  private schedule: State = DEFAULT_STATE;
  // paused is this device's own answer to whether automatic sync runs at all, remembered across
  // restarts in localStorage (see PAUSE_KEY). Manual sync ignores it entirely.
  private paused = false;
  // syncedBefore gates automatic sync on a completed sync already existing for this bucket. A
  // bucket's first pass mints its identity, uploads the whole vault, and has no ancestor to fall
  // back on if the configuration is wrong, so it stays something a user asks for rather than
  // something that happens to them. Reloaded whenever settings change, which is what makes
  // repointing at a fresh bucket demote it back to a manual first sync.
  private syncedBefore = false;
  // The manifest compare-and-swap that keeps overlapping syncs from clobbering each other (#83)
  // only holds if the provider honours conditional writes. testConnection probes for this, but
  // nothing forces a user to run it, so sync verifies once per session before it trusts the CAS
  // and refuses to run rather than silently lose edits on a provider that ignores preconditions
  // (#108). Reset on saveSettings so switching provider re-verifies.
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

    // onLayoutReady, not onload directly: the vault isn't guaranteed fully indexed yet at
    // onload time, and every file would otherwise arrive as a create event the moment the index
    // caught up (#44).
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
      // Reconnecting is not treated as proof anything works, only as reason enough to stop waiting
      // out a backoff whose premise has visibly expired. Nothing gates on navigator.onLine, which
      // reports being on a network rather than being able to reach anything: trusting it would
      // turn one wrong answer into a sync that silently never runs.
      this.registerDomEvent(window, "online", () => {
        this.schedule = noteResumed(this.schedule);
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

  // tick asks the scheduler, every TICK_MS, whether a pass is due. Every gate that is about
  // whether a pass may run at all lives here, and every gate about whether it is time for one
  // lives in the scheduler: configuration is the plugin's business, timing is not.
  private tick(): void {
    if (this.paused || !this.syncedBefore) {
      return;
    }
    if (!hasConnectionConfig(this.settings) || prefixError(this.settings.prefix) !== "") {
      return;
    }
    const decision = due(this.schedule, Date.now());
    if (!decision.due) {
      return;
    }
    void this.syncNow(decision.trigger);
  }

  // syncNow pushes every local change since the last sync to remote storage, pulls every remote
  // change since then down locally, and renames the local side of anything that changed on both
  // ends to a conflict copy rather than ever guessing which edit should win. Refuses to start a
  // second sync while one is already running. A manual pass ignores a pause and clears any halt:
  // the escape hatch has to work in every state, especially the one where the automatic path has
  // given up.
  async syncNow(trigger: Trigger = "manual"): Promise<void> {
    if (this.schedule.syncing) {
      return;
    }
    if (!hasConnectionConfig(this.settings)) {
      this.logger.warn("sync: storage isn't configured yet");
      this.setSyncStatus("error", "storage isn't configured yet");
      return;
    }
    // createS3Client refuses an unusable prefix on its own, so this is not what makes sync safe
    // (#154); it is what makes the refusal legible. Without it the first operation to run is the
    // conditional write probe, and a user would be told their provider failed a write check when
    // the real answer is one bad character in a setting they can fix.
    const badPrefix = prefixError(this.settings.prefix);
    if (badPrefix !== "") {
      this.logger.warn(`sync: ${badPrefix}`);
      this.setSyncStatus("error", badPrefix);
      return;
    }
    const dir = this.manifest.dir;
    if (dir === undefined) {
      this.logger.error("sync: no plugin data directory available");
      this.setSyncStatus("error", "no plugin data directory available");
      return;
    }

    if (trigger === "manual") {
      this.schedule = noteResumed(this.schedule);
    }
    this.schedule = notePassStarted(this.schedule);
    this.setSyncStatus("syncing", "");
    let result: PassResult = "retry";
    try {
      result = await this.runSync(dir, trigger);
    } catch (err) {
      let message = "unexpected error";
      if (err instanceof Error) {
        message = err.message;
      }
      this.logger.error(`sync: ${message}`);
      this.setSyncStatus("error", message);
    } finally {
      this.schedule = notePassFinished(this.schedule, result, Date.now());
    }
  }

  // runSync does the actual work of syncNow, split out so syncNow can own the in flight guard
  // and status bar bookkeeping around it without this getting lost in indentation. Its result is
  // what the scheduler backs off from: "retry" for anything a later attempt could plausibly fix,
  // "stop" for the failures where retrying every few minutes is just noise (a secret that isn't
  // there, a provider that won't honour the conditional writes every safety property rests on).
  private async runSync(dir: string, trigger: Trigger): Promise<PassResult> {
    const secretAccessKey = this.app.secretStorage.getSecret(this.settings.secretId);
    if (secretAccessKey === null || secretAccessKey === "") {
      this.logger.error(`sync: secret access key not found for ID "${this.settings.secretId}"`);
      this.setSyncStatus("error", "secret access key not found; open settings to reconfigure");
      return "stop";
    }

    const storage = createS3Client(this.settings, secretAccessKey, obsidianTransport);

    if (!this.conditionalWritesVerified) {
      const probe = await probeConditionalWrites(storage);
      if (!probe.ok) {
        this.logger.error(`sync: conditional write check failed: ${probe.message}`);
        this.setSyncStatus("error", probe.message);
        return "stop";
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
    );
    if (!outcome.ok) {
      // A failed pass can still have made progress worth keeping (#87): the snapshot records what
      // completed so it is never re-planned, while each failed file stays pending for next pass.
      if (outcome.snapshot !== null) {
        await stateStore.write(outcome.snapshot);
      }
      for (const failure of outcome.failures) {
        this.logger.error(`sync: ${failure.path}: ${failure.message}`);
      }
      this.logger.error(`sync: ${outcome.message}`);
      this.setSyncStatus("error", outcome.message);
      return "retry";
    }

    await stateStore.write(outcome.snapshot);
    this.syncedBefore = true;
    // A pass that changed nothing is the ordinary case once sync is automatic, and a line for each
    // one would push everything worth reading out of a 500 line file inside two days. A pass a user
    // asked for always reports, since they are standing there waiting for an answer. Nothing is
    // logged when a pass starts, for the same reason: a "starting" line with no matching "complete"
    // is how a perfectly ordinary idle poll would come to look like a hang.
    if (outcome.changeCount > 0 || trigger === "manual") {
      this.logger.info(`sync: complete (${trigger}, ${outcome.changeCount} change(s) applied)`);
    }
    this.setSyncStatus(this.restingStatus(), "");

    return "ok";
  }

  // loadDeviceId returns this device's identity, minting and storing one the first time it runs on
  // a given device. Vault scoped localStorage, never data.json or state.json, so a synced
  // .obsidian/ folder can't hand this identity to another machine (see DEVICE_ID_KEY). A stored
  // value that isn't a usable string is treated as absent and replaced rather than trusted.
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

  // loadSyncedBefore records whether this vault has already completed a sync against the currently
  // configured bucket, which is what automatic sync waits for. The answer comes from state.json
  // carrying a vaultId, and createObsidianStore refuses a state file written against different
  // settings (#89), so repointing at another bucket reads back as never synced and correctly
  // demands a manual first pass rather than starting one unattended.
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
  }
}

// Upstream: core/notify_watcher.go (registerNotifyWatcherHooks,
// createNotifyDirWatcher)
//
// The multi-instance notify watcher: the `.notify` directory in pb_data is
// upstream's cross-platform workaround for telling the other processes on
// the same pb_data (another server, a CLI command, a running PocketBase)
// that the settings or the collections changed. Every instance has a random
// id; after a save it creates and removes an empty marker file
// `settings@<id>` or `collections@<id>`, and every other instance watching
// the directory reloads its settings or its collections cache 50 ms after
// the last event. Markers of the own instance are ignored.
//
// There is no hook system (D5): the settings and collection save paths call
// notifySettingsSaved and notifyCollectionsSaved, after the save (after the
// outer transaction commits, as upstream's after-success hooks run).
//
// Differences from upstream's results, all harmless:
//   - fs.watch cannot tell a created marker from a removed one (both are
//     "rename" events), so a removal counts too; the create and the remove
//     of one marker land in the same debounce window, so it is one reload.
//     A leftover marker of a crashed instance removed by hand reloads once.
//   - upstream reloads what the last event of a window names; this reloads
//     every kind named in the window, so a settings save followed by a
//     collections save within 50 ms reloads both.
//
// Only the main thread holds the settings and the collections cache (D8):
// the read workers run SQL on their own connections and keep no copy, so
// nothing else needs the reload.

import { type FSWatcher, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ErrorLogger } from "@/app/app";
import { LocalNotifyDirName } from "@/app/filesystem";
import { randomString } from "@/tools/security/random";

// upstream's debounce
const debounceMs = 50;

export interface NotifyTx {
  onComplete(fn: (txErr: unknown) => void): void;
}

export interface NotifyDatabases {
  txInfo(): NotifyTx | null;
}

// The part of the app that the save paths use.
export interface Notifier {
  // marker writes; no-op until the watcher runs (upstream's
  // `notifyWatcher != nil`)
  settingsSaved(): void;
  collectionsSaved(): void;
}

export interface NotifyWatcherConfig {
  dataDir: string;
  logger: ErrorLogger;
  // a test seam: the id comes from randomString(10) unless set
  instanceId?: string;
}

export class NotifyWatcher implements Notifier {
  readonly instanceId: string;
  readonly dir: string;
  readonly #logger: ErrorLogger;
  readonly #settingsFile: string;
  readonly #collectionsFile: string;
  #watcher: FSWatcher | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending = { settings: false, collections: false };
  // the reloads that wait for the running one (at most one follow-up)
  #queued = { settings: false, collections: false };
  // the running reload loop; one at a time, close() waits for it
  #running: Promise<void> | null = null;
  #closed = false;

  constructor(config: NotifyWatcherConfig) {
    this.instanceId = "@" + (config.instanceId ?? randomString(10));
    this.dir = join(config.dataDir, LocalNotifyDirName);
    this.#logger = config.logger;
    this.#settingsFile = join(this.dir, "settings" + this.instanceId);
    this.#collectionsFile = join(this.dir, "collections" + this.instanceId);
  }

  // The OnBootstrap part: creates the notify dir and starts watching it.
  // A failure is a warning, not an error. reloadSettings and
  // reloadCollections are the app's own reloads.
  start(reload: { settings: () => Promise<void>; collections: () => void }): void {
    this.#stop();
    this.#closed = false;

    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.#warnWatchFailure(new Error("failed to create a notify dir: " + messageOf(err)));
      return;
    }

    try {
      this.#watcher = watch(this.dir, { persistent: false }, (_event, filename) => {
        const name = filename === null ? "" : String(filename);
        // modified from within the current app instance
        if (name === "" || name.endsWith(this.instanceId)) {
          return;
        }
        if (name.startsWith("settings@")) {
          this.#pending.settings = true;
        } else if (name.startsWith("collections@")) {
          this.#pending.collections = true;
        } else {
          return;
        }

        this.#stopTimer();
        this.#timer = setTimeout(() => this.#fire(reload), debounceMs);
        this.#timer.unref?.();
      });
      this.#watcher.on("error", () => {
        // upstream only prints it with --dev
      });
    } catch (err) {
      this.#watcher = null;
      this.#warnWatchFailure(new Error("unable to watch notify dir: " + messageOf(err)));
    }
  }

  // The OnTerminate part: stops watching and removes the own markers. No
  // reload starts after it; it resolves once the running one has finished,
  // so the databases can close under nothing.
  async close(): Promise<void> {
    this.#closed = true;
    this.#stop();
    await this.#running;
  }

  #stop(): void {
    this.#stopTimer();
    this.#queued = { settings: false, collections: false };
    this.#pending = { settings: false, collections: false };
    if (this.#watcher !== null) {
      try {
        this.#watcher.close();
      } catch {
        // ignored, as upstream does
      }
      this.#watcher = null;
    }
    for (const file of [this.#settingsFile, this.#collectionsFile]) {
      try {
        rmSync(file, { force: true });
      } catch {
        // ignored, as upstream does
      }
    }
  }

  settingsSaved(): void {
    this.#mark(this.#settingsFile);
  }

  collectionsSaved(): void {
    this.#mark(this.#collectionsFile);
  }

  #mark(file: string): void {
    if (this.#watcher === null) {
      return;
    }
    try {
      writeFileSync(file, "", { mode: 0o644 });
    } catch (err) {
      this.#logger.warn("Failed to write watcher file", { error: err, file });
    }
    try {
      rmSync(file, { force: true });
    } catch {
      // ignored, as upstream does
    }
  }

  #stopTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #fire(reload: { settings: () => Promise<void>; collections: () => void }): void {
    this.#timer = null;
    if (this.#closed) {
      return;
    }
    this.#queued.settings ||= this.#pending.settings;
    this.#queued.collections ||= this.#pending.collections;
    this.#pending = { settings: false, collections: false };

    // events during a running reload coalesce into one follow-up
    this.#running ??= this.#drain(reload).finally(() => {
      this.#running = null;
    });
  }

  async #drain(reload: { settings: () => Promise<void>; collections: () => void }): Promise<void> {
    while (!this.#closed && (this.#queued.settings || this.#queued.collections)) {
      const { settings, collections } = this.#queued;
      this.#queued = { settings: false, collections: false };

      if (settings) {
        this.#logger.debug("Reloading settings after notify event");
        try {
          await reload.settings();
        } catch (err) {
          this.#logger.warn("Failed to reload app settings after notify", { error: err });
        }
      }
      if (collections && !this.#closed) {
        this.#logger.debug("Reloading cached collections after notify event");
        try {
          reload.collections();
        } catch (err) {
          this.#logger.warn("Failed to reload cached collections after notify", { error: err });
        }
      }
    }
  }

  #warnWatchFailure(err: Error): void {
    this.#logger.warn("Notify dir watcher failure.", { error: err.message });
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Runs the marker write once the save is final: at once outside a
// transaction, after the outermost commit inside one (a rolled back save
// notifies nobody).
export function notifyAfterSave(
  databases: NotifyDatabases,
  notify: Notifier | undefined,
  kind: "settings" | "collections",
): void {
  if (notify === undefined) {
    return;
  }
  const send = (): void =>
    kind === "settings" ? notify.settingsSaved() : notify.collectionsSaved();
  const tx = databases.txInfo();
  if (tx === null) {
    send();
    return;
  }
  tx.onComplete((txErr) => {
    if (txErr === null) {
      send();
    }
  });
}

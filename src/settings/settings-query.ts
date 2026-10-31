// Upstream: core/settings_query.go (Param, ReloadSettings, loadParam), the
// settings save path of core/db.go (Save with validation, for the Settings
// model) and the after-save reload of registerSettingsHooks
// (core/settings_model.go).
//
// The settings value may be encrypted with AES-GCM (Web Crypto, async), so
// loading and saving are async. The OnSettingsReload hook is not ported
// (D5): settingsReloaded is the plain internal call site of its consumers.

import type { App } from "@/app/app";
import type { Row } from "@/db/dbx/query";
import { isNoRowsError } from "@/db/dbx/rows";
import { saveNoValidate } from "@/db/db";
import { BaseModel, type Model } from "@/db/model";
import { goQuote } from "@/fields/field";
import { destroyRateLimitersStore, type RateLimitersApp } from "@/middlewares/rate-limit";
import { decodeUTF8Bytes } from "@/server/json-decode";
import {
  paramsKeySettings,
  paramsTable,
  type Settings,
  type SettingsExport,
  unmarshalSettings,
} from "@/settings/settings-model";
import { decrypt } from "@/tools/security/encrypt";

// Param is a `_params` row.
export class Param extends BaseModel {
  created = "";
  updated = "";
  // the stored bytes: a BLOB (Uint8Array), TEXT (string) or NULL
  value: Uint8Array | string | null = null;

  tableName(): string {
    return paramsTable;
  }

  override dbColumns(): Row {
    return {
      ...super.dbColumns(),
      created: this.created,
      updated: this.updated,
      value: this.value,
    };
  }

  override dbScan(row: Row): void {
    super.dbScan(row);
    if (Object.hasOwn(row, "created")) {
      this.created = row.created === null ? "" : String(row.created);
    }
    if (Object.hasOwn(row, "updated")) {
      this.updated = row.updated === null ? "" : String(row.updated);
    }
    if (Object.hasOwn(row, "value")) {
      this.value = row.value as Uint8Array | string | null;
    }
  }
}

// the settings param row, or null when there is none
function findSettingsParam(app: App): Param | null {
  const param = new Param();
  try {
    app.databases
      .concurrentDB()
      .select("{{" + paramsTable + "}}.*")
      .from(paramsTable)
      .model(paramsKeySettings, param);
  } catch (err) {
    if (isNoRowsError(err)) {
      return null;
    }
    throw err;
  }
  return param;
}

// os.Getenv(app.EncryptionEnv())
function encryptionKey(app: App): string {
  return app.getenv(app.encryptionEnv);
}

// ReloadSettings initializes and reloads the stored application settings.
//
// If no settings were stored it will persist the current app ones.
export async function reloadSettings(app: App): Promise<void> {
  const param = findSettingsParam(app);

  // no settings were previously stored -> save
  // (reloadSettings() will be invoked again after the successful save)
  if (param === null) {
    // force insert in case the param entry was deleted manually after application start
    app.settings.markAsNew();
    await saveSettings(app, app.settings);
    return;
  }

  await loadParam(app.settings, app, param.value);

  settingsReloaded(app);
}

// The internal consumers of a settings reload (upstream's OnSettingsReload
// handlers). The rate limiters reset here; saveSettingsSync, which saves
// without a reload, resets them too. The others are called from here by the
// tasks that add them:
//   - M4.4: reset the mailer client (NewMailClient reads the SMTP config);
//   - M5.3: reschedule the backups cron (backups.cron, cronMaxKeep);
//   - M5.5: apply the logs settings (minLevel, maxDays, logIP, logAuthId);
//   - M5.7: the trusted proxy settings (read per request, nothing to reset).
function settingsReloaded(app: App): void {
  destroyRateLimitersStore(app);
}

// loadParam loads the settings from the stored param into the app ones.
//
// @todo note that the encryption may get removed in the future since it doesn't
// really accomplish much and it might be better to find a way to encrypt the backups
// or implement support for resolving env variables.
async function loadParam(s: Settings, app: App, value: Uint8Array | string | null): Promise<void> {
  const raw = value ?? "";

  // try first without decryption
  let plainDecodeErr: unknown;
  try {
    unmarshalSettings(raw, s);
  } catch (err) {
    plainDecodeErr = err;
  }

  // failed, try to decrypt
  if (plainDecodeErr !== undefined) {
    const key = encryptionKey(app);

    // load without decryption has failed and there is no encryption key to use for decrypt
    if (key === "") {
      throw new Error(
        `invalid settings db data or missing encryption key ${goQuote(app.encryptionEnv)}`,
      );
    }

    // decrypt
    const cipherText = typeof raw === "string" ? raw : decodeUTF8Bytes(raw);
    const decrypted = await decrypt(cipherText, key);

    // decode again
    unmarshalSettings(decrypted, s);
  }

  s.postScan();
}

// app.Save(settings): validates the settings, writes them to `_params`
// (insert when new, update otherwise) and reloads the app settings from
// the stored row. Throws the validation errors (validation.Errors), the
// encryption error or the db error.
export async function saveSettings(app: App, s: Settings): Promise<void> {
  // run validations
  const validateErr = s.validate();
  if (validateErr !== null) {
    throw validateErr;
  }

  // the export (and its encryption) is prepared before the db write
  const data = await s.dbExport(app.clock, encryptionKey(app));

  saveNoValidate(app.databases, new SettingsExportModel(s, data));

  // auto reload the app settings because we don't know whether
  // the Settings model is the app one or a different one
  app.settings.postScan();
  await reloadSettings(app);
}

// The app members the synchronous settings save reads.
export type SettingsSaveApp = Pick<App, "databases" | "clock" | "encryptionEnv" | "getenv"> &
  RateLimitersApp;

// app.Save(settings) from a synchronous save path that may run in a
// transaction (the rate limit rule relabel of a collection rename): the
// validation and db write of saveSettings, with the encryption done
// synchronously. The settings saved are the app ones, changed in place,
// so the reload from the stored row would give the same values and is not
// repeated.
export function saveSettingsSync(app: SettingsSaveApp, s: Settings, withValidations = true): void {
  const validateErr = withValidations ? s.validate() : null;
  if (validateErr !== null) {
    throw validateErr;
  }

  const data = s.dbExportSync(app.clock, app.getenv(app.encryptionEnv));

  saveNoValidate(app.databases, new SettingsExportModel(s, data));

  s.postScan();

  // what the skipped reload's settingsReloaded does for the rate limiters
  destroyRateLimitersStore(app);
}

// The collection update part of registerSettingsHooks
// (core/settings_model.go): after a collection rename, the rate limit rules
// labeled "<old name>:..." are relabeled "<new name>:..." and the settings
// saved. The rules are changed in place, as upstream changes the app
// settings' rules slice.
export function relabelRateLimitRules(
  app: SettingsSaveApp,
  settings: Settings,
  oldName: string,
  newName: string,
): void {
  if (oldName === newName) {
    return;
  }

  let hasChange = false;

  const rules = settings.settings.RateLimits.Rules ?? [];
  for (const rule of rules) {
    if (rule.Label.startsWith(oldName + ":")) {
      rule.Label = rule.Label.replace(oldName + ":", () => newName + ":");
      hasChange = true;
    }
  }

  if (hasChange) {
    saveSettingsSync(app, settings);
  }
}

// The db write of the Settings model with its prepared export
// (DBExporter).
class SettingsExportModel implements Model {
  constructor(
    private readonly s: Settings,
    private readonly data: SettingsExport,
  ) {}

  tableName(): string {
    return this.s.tableName();
  }
  pk(): string {
    return this.s.pk();
  }
  lastSavedPK(): string {
    return this.s.lastSavedPK();
  }
  isNew(): boolean {
    return this.s.isNew();
  }
  markAsNew(): void {
    this.s.markAsNew();
  }
  markAsNotNew(): void {
    this.s.markAsNotNew();
  }
  dbExport(): Row {
    return { ...this.data };
  }
}

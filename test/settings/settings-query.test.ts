// Upstream: core/settings_query_test.go
//
// Through reloadSettings and saveSettings on a bootstrapped fixture copy.
// The hook call counts (testEventCalls) are dropped; "no db update" is
// checked on the stored row instead. The encryption key is generated in
// the test and passed as the app's environment.

import { describe, expect, test } from "bun:test";

import type { App } from "@/app/app";
import { reloadSettings, saveSettings } from "@/settings/settings-query";
import { randomString } from "@/tools/security/random";

import { openFixtureApp } from "@test/app/app";

interface ParamRow {
  value: Uint8Array | string | null;
  created: string;
  updated: string;
}

function settingsRow(app: App): ParamRow | null {
  return app.databases
    .nonconcurrentDB()
    .newQuery("SELECT value, created, updated FROM _params WHERE id = 'settings'")
    .one<ParamRow | null>();
}

function rowText(row: ParamRow | null): string {
  const value = row?.value ?? "";
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

describe("TestReloadSettings", () => {
  test("persists, reloads and loads the stored settings", async () => {
    const app = await openFixtureApp();
    try {
      // cleanup all stored settings
      app.databases.nonconcurrentDB().newQuery("DELETE from _params;").execute();

      // check if the new settings are saved in the db
      app.settings.Meta.AppName = "test_name_after_delete";

      await reloadSettings(app);

      const inserted = settingsRow(app);
      expect(inserted).not.toBeNull();
      expect(rowText(inserted)).toContain("test_name_after_delete");
      // a BLOB, as Go stores the []byte value
      expect(inserted?.value).toBeInstanceOf(Uint8Array);
      expect(inserted?.created).toBe(inserted?.updated as string);

      // change the db entry and reload the app settings (ensure that there was no db update)
      app.databases
        .nonconcurrentDB()
        .newQuery(`UPDATE _params SET value = {:value} WHERE id = 'settings'`)
        .bind({ value: `{"meta": {"appName":"test_name_after_update"}}` })
        .execute();
      const before = settingsRow(app);

      await reloadSettings(app);

      // try to reload again without doing any changes
      await reloadSettings(app);

      expect(settingsRow(app)).toEqual(before);
      expect(app.settings.Meta.AppName).toBe("test_name_after_update");
      // the other values are kept (the stored JSON is merged into them)
      expect(app.settings.Meta.SenderName).toBe("Support");
    } finally {
      await app.cleanup();
    }
  });
});

describe("TestReloadSettingsWithEncryption", () => {
  test("persists and reloads encrypted settings", async () => {
    const key = randomString(32);
    const app = await openFixtureApp({
      encryptionEnv: "pb_test_env",
      getenv: (name) => (name === "pb_test_env" ? key : ""),
    });
    try {
      // cleanup all stored settings
      app.databases.nonconcurrentDB().newQuery("DELETE from _params;").execute();

      // check if the new settings are saved in the db
      app.settings.Meta.AppName = "test_name_after_delete";

      await reloadSettings(app);

      let raw = rowText(settingsRow(app));
      expect(raw).not.toBe("");
      expect(raw).not.toContain("test_name");
      // the encrypted value is TEXT
      expect(typeof settingsRow(app)?.value).toBe("string");

      // change and reload the app settings (ensure that there was no db update)
      app.settings.Meta.AppName = "test_name_after_update";
      await saveSettings(app, app.settings);

      // try to reload again without doing any changes
      const before = settingsRow(app);
      await reloadSettings(app);
      expect(settingsRow(app)).toEqual(before);

      // refetch the settings param to ensure that the new value was stored encrypted
      raw = rowText(settingsRow(app));
      expect(raw).not.toBe("");
      expect(raw).not.toContain("test_name");

      expect(app.settings.Meta.AppName).toBe("test_name_after_update");
    } finally {
      await app.cleanup();
    }
  });
});

describe("loadParam errors", () => {
  test("encrypted settings without the key", async () => {
    const app = await openFixtureApp({ encryptionEnv: "PB_TEST_KEY" });
    try {
      app.databases
        .nonconcurrentDB()
        .newQuery(`UPDATE _params SET value = 'not json' WHERE id = 'settings'`)
        .execute();
      await expect(reloadSettings(app)).rejects.toThrow(
        'invalid settings db data or missing encryption key "PB_TEST_KEY"',
      );
    } finally {
      await app.cleanup();
    }
  });

  test("encrypted settings with a wrong key", async () => {
    const key = randomString(32);
    const app = await openFixtureApp({
      encryptionEnv: "PB_TEST_KEY",
      getenv: () => key,
    });
    try {
      await saveSettings(app, app.settings);
      const wrong = await openFixtureApp({
        dataDir: app.dataDir,
        encryptionEnv: "PB_TEST_KEY",
        getenv: () => randomString(32),
      }).catch((err: unknown) => err);
      expect((wrong as Error).message).toBe("cipher: message authentication failed");
    } finally {
      await app.cleanup();
    }
  });

  test("invalid key size", async () => {
    const app = await openFixtureApp({ encryptionEnv: "PB_TEST_KEY", getenv: () => "short" });
    try {
      // plain settings load without decryption; the save encrypts
      await expect(saveSettings(app, app.settings)).rejects.toThrow(
        "crypto/aes: invalid key size 5",
      );
    } finally {
      await app.cleanup();
    }
  });
});

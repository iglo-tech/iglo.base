// Upstream: core/base.go (NewFilesystem, registerBaseHooks' storage delete
// after a record or collection delete), checked through src/app/filesystem.ts
// and the collection delete path on copies of the vendored fixture.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newAppFilesystem } from "@/app/filesystem";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { deleteCollection } from "@/collections/collection-save";
import { newDefaultSettings } from "@/settings/settings-model";

import { openTestApp } from "@test/collections/app";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-app-fs-"));
  roots.push(root);
  return root;
}

// a pb_data with files under storage/<dir>/<file>
function withFiles(dataDir: string, dirs: string[]): void {
  for (const d of dirs) {
    mkdirSync(join(dataDir, "storage", d), { recursive: true });
    writeFileSync(join(dataDir, "storage", d, "a.txt"), "a");
    writeFileSync(join(dataDir, "storage", d, "a.txt.attrs"), "{}");
  }
}

const fileModel = (path: string) => ({
  baseFilesPath: () => path,
  fieldTypes: () => ["text", "file"],
});

describe("NewFilesystem", () => {
  test("local storage under pb_data/storage", () => {
    const dataDir = newDataDir();
    const fs = newAppFilesystem({
      dataDir,
      settings: () => newDefaultSettings(),
      getenv: () => "",
      logger: { error: () => {} },
    }).newFilesystem();
    try {
      fs.upload(new TextEncoder().encode("hi"), "c/r/f.txt");
    } finally {
      fs.close();
    }
    expect(existsSync(join(dataDir, "storage", "c", "r", "f.txt"))).toBe(true);
    expect(existsSync(join(dataDir, "storage", "c", "r", "f.txt.attrs"))).toBe(true);
  });

  test("S3 enabled fails until M5.4", () => {
    const settings = newDefaultSettings();
    settings.S3.Enabled = true;
    const appFs = newAppFilesystem({
      dataDir: newDataDir(),
      settings: () => settings,
      getenv: () => "",
      logger: { error: () => {} },
    });
    expect(() => appFs.newFilesystem()).toThrow("S3");
  });
});

describe("deleteModelFiles", () => {
  test("deletes the model's directory in the background", async () => {
    const dataDir = newDataDir();
    withFiles(dataDir, ["c1/r1", "c1/r2"]);
    const appFs = newAppFilesystem({
      dataDir,
      settings: () => newDefaultSettings(),
      getenv: () => "",
      logger: { error: () => {} },
    });

    const result = appFs.deleteModelFiles(fileModel("c1/r1"));
    expect(result).toBeUndefined(); // a free worker: the caller does not wait
    // not yet: the delete runs after the caller
    expect(existsSync(join(dataDir, "storage", "c1", "r1", "a.txt"))).toBe(true);

    await Bun.sleep(50);
    expect(existsSync(join(dataDir, "storage", "c1", "r1"))).toBe(false);
    expect(existsSync(join(dataDir, "storage", "c1", "r2", "a.txt"))).toBe(true);
  });

  test("a model without a file field or path deletes nothing", async () => {
    const dataDir = newDataDir();
    withFiles(dataDir, ["c1/r1"]);
    const appFs = newAppFilesystem({
      dataDir,
      settings: () => newDefaultSettings(),
      getenv: () => "",
      logger: { error: () => {} },
    });

    appFs.deleteModelFiles({ baseFilesPath: () => "c1/r1", fieldTypes: () => ["text"] });
    appFs.deleteModelFiles({ baseFilesPath: () => "", fieldTypes: () => ["file"] });
    await Bun.sleep(50);
    expect(existsSync(join(dataDir, "storage", "c1", "r1", "a.txt"))).toBe(true);
  });

  test("PB_FILES_DELETE_MAX_WORKERS bounds the deletes running at once", async () => {
    const dataDir = newDataDir();
    withFiles(dataDir, ["c1/r1", "c1/r2", "c1/r3"]);
    const appFs = newAppFilesystem({
      dataDir,
      settings: () => newDefaultSettings(),
      getenv: (name) => (name === "PB_FILES_DELETE_MAX_WORKERS" ? "1" : ""),
      logger: { error: () => {} },
    });

    expect(appFs.deleteModelFiles(fileModel("c1/r1"))).toBeUndefined();
    // the only worker is busy: the next deletes wait for it
    const second = appFs.deleteModelFiles(fileModel("c1/r2"));
    const third = appFs.deleteModelFiles(fileModel("c1/r3"));
    expect(second).toBeInstanceOf(Promise);
    expect(third).toBeInstanceOf(Promise);

    await second;
    expect(existsSync(join(dataDir, "storage", "c1", "r1"))).toBe(false);
    await third;
    await Bun.sleep(50);
    expect(existsSync(join(dataDir, "storage", "c1"))).toBe(true);
    expect(existsSync(join(dataDir, "storage", "c1", "r2"))).toBe(false);
    expect(existsSync(join(dataDir, "storage", "c1", "r3"))).toBe(false);
  });

  test("a failed delete is logged", async () => {
    const dataDir = newDataDir();
    const settings = newDefaultSettings();
    const logged: string[] = [];
    const appFs = newAppFilesystem({
      dataDir,
      settings: () => settings,
      getenv: () => "",
      logger: { error: (message) => logged.push(message) },
    });
    settings.S3.Enabled = true; // NewFilesystem fails
    appFs.deleteModelFiles(fileModel("c1/r1"));
    await Bun.sleep(50);
    expect(logged).toEqual([
      "Failed to delete storage prefix (non critical error; usually could happen because of S3 api limits): c1/r1/",
    ]);
  });
});

describe("collection delete", () => {
  test("removes the collection's storage directory", async () => {
    const app = openTestApp();
    try {
      const demo5 = findCollectionByNameOrId(app, "demo5");
      const dir = join(app.dataDir, "storage", demo5.id);
      expect(existsSync(dir)).toBe(true);

      deleteCollection(app, demo5);

      await Bun.sleep(100);
      expect(existsSync(dir)).toBe(false);
      // the other collections' files stay
      expect(existsSync(join(app.dataDir, "storage", "wsmn24bux7wo113"))).toBe(true);
    } finally {
      app.cleanup();
    }
  });
});

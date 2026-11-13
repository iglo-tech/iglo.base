// The pre-schema backup's name (D40, S.3). The clock is injected: two backups
// made at the same clock reading must keep both names, so neither replaces the
// other. The rest of the backup and its retention are tested through the CLI in
// test/schema/apply.test.ts.

import { afterEach, describe, expect, test } from "bun:test";

import { makePreSchemaBackup, preSchemaBackupName } from "@/schema/backup";
import { openFixtureApp, type TestApp } from "@test/app/app";

let opened: TestApp[] = [];

afterEach(async () => {
  for (const app of opened) {
    await app.cleanup();
  }
  opened = [];
});

async function open(clock: { now: () => Date }): Promise<TestApp> {
  const app = await openFixtureApp({ clock });
  opened.push(app);
  return app;
}

describe("pre-schema backup names", () => {
  test("the name is the UTC time with milliseconds, without separators", () => {
    expect(preSchemaBackupName(new Date("2026-11-13T17:24:29.123Z"))).toBe(
      "pre-schema-20261113T172429.123Z.zip",
    );
  });

  test("two backups at the same clock reading keep both, the second one millisecond later", async () => {
    const now = new Date("2026-11-13T17:24:29.123Z");
    const app = await open({ now: () => now });

    const first = await makePreSchemaBackup(app);
    const second = await makePreSchemaBackup(app);
    expect(first).toBe("pre-schema-20261113T172429.123Z.zip");
    expect(second).toBe("pre-schema-20261113T172429.124Z.zip");

    const fsys = app.filesystem.newBackupsFilesystem();
    try {
      const keys = (await fsys.list("pre-schema-")).map((file) => file.key).toSorted();
      expect(keys).toEqual([first, second]);
    } finally {
      fsys.close();
    }
  });
});

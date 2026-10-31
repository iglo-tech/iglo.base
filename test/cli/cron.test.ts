// Upstream: core/base.go (__pbCronStart__ on serve), through the CLI
// in-process, on a clock just before midnight: `serve` runs every midnight
// job at the boundary, and the commands that only bootstrap run none.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { type CliContext, runCli } from "@/cli/root";

import { eventually, expiredRow, writeMFAs, writeOTPs } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { freePort, tempDir } from "@test/support/executable";

const midnight = new Date("2030-01-01T00:00:00Z").getTime();

function preparedDataDir(): string {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  writeOTPs(dataDir);
  writeMFAs(dataDir);

  const aux = new Database(join(dataDir, "auxiliary.db"));
  aux.run(`INSERT INTO _logs (id, created) VALUES ('${expiredRow}', '2020-01-01 00:00:00.000Z')`);
  aux.close();
  return dataDir;
}

function expiredRows(dataDir: string): number {
  const count = (file: string, table: string): number => {
    const db = new Database(join(dataDir, file), { readonly: true });
    const row = db.query(`SELECT count(*) AS n FROM ${table} WHERE id = ?`).get(expiredRow);
    db.close();
    return (row as { n: number }).n;
  };
  return count("data.db", "_otps") + count("data.db", "_mfas") + count("auxiliary.db", "_logs");
}

function context(args: string[], msBeforeMidnight: number, shutdown: AbortSignal): CliContext {
  const shift = midnight - msBeforeMidnight - Date.now();
  return {
    args,
    argv0: "iglo-base",
    cwd: tempDir(),
    isCompiled: true,
    out: {
      stdout: () => {},
      stderr: () => {},
      now: () => new Date(Date.now() + shift),
      color: false,
    },
    shutdown,
  };
}

test("serve ticks, and stops on shutdown", async () => {
  const dataDir = preparedDataDir();
  const shutdown = new AbortController();
  const port = await freePort();

  const finished = runCli(
    context(
      ["serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir, "--automigrate=false"],
      100,
      shutdown.signal,
    ),
  );

  expect(await eventually(() => expiredRows(dataDir) === 0)).toBe(true);

  shutdown.abort();
  expect(await finished).toBe(0);
});

test("superuser and migrate never run the jobs", async () => {
  const dataDir = preparedDataDir();
  const never = new AbortController().signal;

  expect(
    await runCli(
      context(
        ["superuser", "upsert", "cron@example.com", "1234567890", "--dir", dataDir],
        1,
        never,
      ),
    ),
  ).toBe(0);
  expect(await runCli(context(["migrate", "up", "--dir", dataDir], 1, never))).toBe(0);

  expect(expiredRows(dataDir)).toBe(3);
});

// Run by cron-logs-zone.test.ts with TZ set: Go (and this port) read the local
// zone once per process. Prints the ids __pbLogsCleanup__ leaves in _logs.
// argv: now (ISO), maxDays, then the rows as id=created.

import { join } from "node:path";

import type { Job } from "@/tools/cron/cron";

import { openFixtureApp } from "@test/app/app";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { tempDir } from "@test/support/executable";

const [now, maxDays, ...rows] = process.argv.slice(2);

const dataDir = join(tempDir(), "pb_data");
copyDataDir(fixtureDir, dataDir);

const app = await openFixtureApp({ dataDir, clock: { now: () => new Date(now as string) } });
app.settings.Logs.MaxDays = Number(maxDays);

// after the bootstrap, whose settings reload clears old logs too
for (const row of rows) {
  const [id, created] = row.split("=");
  app.databases
    .auxNonconcurrentDB()
    .newQuery("INSERT INTO _logs (id, created) VALUES ({:id}, {:created})")
    .bind({ id, created })
    .execute();
}

const job = app.cron.jobs().find((j) => j.id === "__pbLogsCleanup__") as Job;
app.cron.fireAndForget(job);
await app.cron.waitForRunning(5000);

const left = app.databases
  .auxDB()
  .newQuery("SELECT id FROM _logs WHERE id LIKE 'probe%' ORDER BY id")
  .column<string>();
await app.cleanup();
console.log(JSON.stringify(left));

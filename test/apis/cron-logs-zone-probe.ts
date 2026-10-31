// Run by cron-logs-zone.test.ts with TZ set: Go (and this port) read the local
// zone once per process. Prints the ids __pbLogsCleanup__ leaves in _logs.
// argv: now (ISO), maxDays, then the rows as id=created.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { openFixtureApp } from "@test/app/app";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { tempDir } from "@test/support/executable";

const [now, maxDays, ...rows] = process.argv.slice(2);

const dataDir = join(tempDir(), "pb_data");
copyDataDir(fixtureDir, dataDir);

const db = new Database(join(dataDir, "auxiliary.db"));
for (const row of rows) {
  const [id, created] = row.split("=");
  db.query("INSERT INTO _logs (id, created) VALUES (?, ?)").run(id!, created!);
}
db.close();

const app = await openFixtureApp({ dataDir, clock: { now: () => new Date(now!) } });
app.settings.Logs.MaxDays = Number(maxDays);

const job = app.cron.jobs().find((j) => j.id === "__pbLogsCleanup__")!;
app.cron.fireAndForget(job);
await app.cron.waitForRunning(5000);

const left = app.databases
  .auxDB()
  .newQuery("SELECT id FROM _logs WHERE id LIKE 'probe%' ORDER BY id")
  .column<string>();
await app.cleanup();
console.log(JSON.stringify(left));

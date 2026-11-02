// What one log costs on the main thread, part by part (docs/perf/M5.5-logs.md).
import { BatchHandler, type Log } from "@/logs/batch-handler";
import { logDBExport } from "@/logs/log-model";
import { generateDefaultRandomId } from "@/db/db";
import { auxRunInTransaction } from "@/db/tx";

import { openFixtureApp } from "@test/app/app";

const attrs = () => ({
  type: "request",
  execTime: 0.123456,
  url: "/api/health",
  method: "GET",
  status: 200,
  referer: "",
  userAgent: "Bun/1.4.4",
  auth: "",
  userIP: "127.0.0.1",
  remoteIP: "127.0.0.1",
});

function time(name: string, n: number, fn: () => void): void {
  const start = performance.now();
  fn();
  console.log(name, (((performance.now() - start) / n) * 1000).toFixed(2), "us/log");
}

const n = 200_000;
const h = new BatchHandler({ batchSize: 1e9, writeFunc: () => {} });
time("handle", n, () => {
  for (let i = 0; i < n; i++) {
    h.handle({ time: new Date(), level: 0, message: "GET /api/health", attrs: attrs() });
  }
});
time("random id", n, () => {
  for (let i = 0; i < n; i++) {
    generateDefaultRandomId();
  }
});
const rows: { [key: string]: unknown }[] = [];
time("export", n, () => {
  for (const log of h.logs as Log[]) {
    rows.push(logDBExport("id", log, 0));
  }
});

const app = await openFixtureApp();
const m = 20_000;
time("insert, one statement per log", m, () => {
  for (let batch = 0; batch < m / 200; batch++) {
    auxRunInTransaction(app.databases, (tx) => {
      const db = tx.auxNonconcurrentDB();
      for (let i = 0; i < 200; i++) {
        db.insert("_logs", { ...rows[i], id: generateDefaultRandomId() } as never).execute();
      }
    });
  }
});
time("insert, one prepared statement", m, () => {
  for (let batch = 0; batch < m / 200; batch++) {
    auxRunInTransaction(app.databases, (tx) => {
      const q = tx
        .auxNonconcurrentDB()
        .newQuery(
          "INSERT INTO _logs (id, created, level, message, data) VALUES ({:id}, {:created}, {:level}, {:message}, {:data})",
        )
        .prepare();
      for (let i = 0; i < 200; i++) {
        q.bind({ ...rows[i], id: generateDefaultRandomId() } as never).execute();
      }
      q.close();
    });
  }
});
time("insert, one statement per batch", m, () => {
  for (let batch = 0; batch < m / 200; batch++) {
    auxRunInTransaction(app.databases, (tx) => {
      const params: { [key: string]: unknown } = {};
      const values: string[] = [];
      for (let i = 0; i < 200; i++) {
        const row = rows[i]!;
        values.push(`({:i${i}},{:c${i}},{:l${i}},{:m${i}},{:d${i}})`);
        params[`i${i}`] = generateDefaultRandomId();
        params[`c${i}`] = row.created;
        params[`l${i}`] = row.level;
        params[`m${i}`] = row.message;
        params[`d${i}`] = row.data;
      }
      tx.auxNonconcurrentDB()
        .newQuery(`INSERT INTO _logs (id, created, level, message, data) VALUES ${values.join()}`)
        .bind(params as never)
        .execute();
    });
  }
});
await app.cleanup();

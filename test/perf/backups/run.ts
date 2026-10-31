// Backup and restore on a generated pb_data of about 1 GiB, on iglo.base and
// upstream, for docs/perf/M5.3-backups.md. Measures the time, the peak RSS
// (VmHWM, and sampled before the restart replaces the image) and request
// latency during a backup. Run by hand; a work directory on a disk, not tmpfs:
//
//   bun run upstream:prepare && bun run build
//   TMPDIR=<dir> bun test/perf/backups/run.ts <dir> [dataMiB] [storageMiB]

import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const workDir = resolve(process.argv[2] ?? ".");
const dataMiB = Number(process.argv[3] ?? 500);
const storageMiB = Number(process.argv[4] ?? 500);

const token =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";
const asSuperuser = { Authorization: token };
const repo = resolve(import.meta.dir, "../../..");

function generate(dataDir: string): void {
  cpSync(join(repo, "test/fixtures/pocketbase"), dataDir, { recursive: true });
  const db = new Database(join(dataDir, "data.db"));
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE perf_rows (id INTEGER PRIMARY KEY, body TEXT)");
  const insert = db.query("INSERT INTO perf_rows (body) VALUES (?)");
  const rows = dataMiB * 1024;
  db.run("BEGIN");
  for (let i = 0; i < rows; i++) {
    insert.run(Buffer.from(crypto.getRandomValues(new Uint8Array(750))).toString("base64"));
    if (i % 10_000 === 9_999) {
      db.run("COMMIT");
      db.run("BEGIN");
    }
  }
  db.run("COMMIT");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  // half random, half text
  const dir = join(dataDir, "storage", "perf");
  mkdirSync(dir, { recursive: true });
  const fileSize = 200 << 10;
  const text = Buffer.alloc(fileSize, "the quick brown fox jumps over the lazy dog ");
  for (let i = 0; i < (storageMiB << 20) / fileSize; i++) {
    const name = join(dir, `file${i}.bin`);
    writeFileSync(name, i % 2 === 0 ? crypto.getRandomValues(new Uint8Array(fileSize)) : text);
    writeFileSync(`${name}.attrs`, `{"user.content_type":"application/octet-stream"}`);
  }
}

function vm(pid: number, key: string): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? 0) / 1024;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

interface Latency {
  count: number;
  p50: number;
  p99: number;
  max: number;
}

// requests one after the other, and the event loop of the server shows in
// their latency
function sampleLatency(url: string): { stop: () => Promise<Latency> } {
  const times: number[] = [];
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      const start = performance.now();
      await fetch(`${url}/api/collections/demo1/records?perPage=1`, {
        headers: asSuperuser,
      }).then((r) => r.arrayBuffer());
      times.push(performance.now() - start);
      await Bun.sleep(5);
    }
  })();
  return {
    stop: async () => {
      state.running = false;
      await loop;
      const sorted = times.toSorted((a, b) => a - b);
      return {
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p99: percentile(sorted, 0.99),
        max: sorted.at(-1) ?? 0,
      };
    },
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

async function measure(
  name: string,
  command: string[],
  dataDir: string,
  port: number,
): Promise<void> {
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(
    [...command, "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir, "--automigrate=false"],
    { stdout: "ignore", stderr: "inherit", cwd: workDir, env: { ...process.env, NO_COLOR: "1" } },
  );
  const { pid } = proc;

  const ready = async (): Promise<boolean> => {
    try {
      return (await fetch(`${url}/api/health`)).ok;
    } catch {
      return false;
    }
  };
  while (!(await ready())) {
    await Bun.sleep(50);
  }

  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, vm(pid, "VmRSS"));
  }, 20);
  const resetPeak = (): void => {
    peak = vm(pid, "VmRSS");
  };

  const idle = await sampleBaseline(url);

  resetPeak();
  const startRSS = peak;
  const latency = sampleLatency(url);
  let start = performance.now();
  const created = await fetch(`${url}/api/backups`, {
    method: "POST",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: `{"name":"perf.zip"}`,
  });
  if (created.status !== 204) {
    throw new Error(`backup: ${created.status} ${await created.text()}`);
  }
  const backupSeconds = (performance.now() - start) / 1000;
  const backupPeak = peak;
  const during = await latency.stop();
  const zipPath = join(dataDir, "backups", "perf.zip");
  const zipSize = statSync(zipPath).size / (1 << 20);

  // download and upload, through curl so that this process holds no bytes
  const fileToken = (
    (await (
      await fetch(`${url}/api/files/token`, { method: "POST", headers: asSuperuser })
    ).json()) as { token: string }
  ).token;
  const downloaded = join(workDir, `${name}-downloaded.zip`);
  resetPeak();
  start = performance.now();
  Bun.spawnSync([
    "curl",
    "-sS",
    "-o",
    downloaded,
    `${url}/api/backups/perf.zip?token=${fileToken}`,
  ]);
  const downloadSeconds = (performance.now() - start) / 1000;
  const downloadPeak = peak;

  resetPeak();
  start = performance.now();
  const up = Bun.spawnSync([
    "curl",
    "-sS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-H",
    `Authorization: ${token}`,
    "-F",
    `file=@${downloaded};filename=uploaded.zip;type=application/zip`,
    `${url}/api/backups/upload`,
  ]);
  const uploadSeconds = (performance.now() - start) / 1000;
  const uploadPeak = peak;
  rmSync(downloaded);
  if (up.stdout.toString() !== "204") {
    throw new Error(`upload: ${up.stdout.toString()}`);
  }

  // a marker that the restore takes away
  const marker = await fetch(`${url}/api/collections/demo1/records`, {
    method: "POST",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: `{"text":"marker"}`,
  });
  const { id } = (await marker.json()) as { id: string };
  const gone = async (): Promise<boolean> => {
    try {
      const r = await fetch(`${url}/api/collections/demo1/records/${id}`, { headers: asSuperuser });
      return r.status === 404;
    } catch {
      return false;
    }
  };

  resetPeak();
  start = performance.now();
  const restore = await fetch(`${url}/api/backups/perf.zip/restore`, {
    method: "POST",
    headers: asSuperuser,
  });
  if (restore.status !== 204) {
    throw new Error(`restore: ${restore.status}`);
  }
  while (!(await gone())) {
    await Bun.sleep(20);
  }
  // upstream's 1 second before it starts is not work
  const restoreSeconds = (performance.now() - start) / 1000 - 1;
  const restorePeak = peak;

  clearInterval(sampler);
  proc.kill("SIGTERM");
  await proc.exited;

  console.log(
    JSON.stringify({
      name,
      zipMiB: round(zipSize),
      startRSSMiB: round(startRSS),
      backupSeconds: round(backupSeconds),
      backupPeakMiB: round(backupPeak),
      idleLatencyMs: idle,
      backupLatencyMs: {
        count: during.count,
        p50: round(during.p50),
        p99: round(during.p99),
        max: round(during.max),
      },
      downloadSeconds: round(downloadSeconds),
      downloadPeakMiB: round(downloadPeak),
      uploadSeconds: round(uploadSeconds),
      uploadPeakMiB: round(uploadPeak),
      restoreSeconds: round(restoreSeconds),
      restorePeakMiB: round(restorePeak),
    }),
  );
}

async function sampleBaseline(url: string): Promise<Latency> {
  const latency = sampleLatency(url);
  await Bun.sleep(1000);
  const r = await latency.stop();
  return { count: r.count, p50: round(r.p50), p99: round(r.p99), max: round(r.max) };
}

const source = join(workDir, "source");
generate(source);
console.log(`generated: data.db ${statSync(join(source, "data.db")).size >> 20} MiB`);

for (const [name, command, port] of [
  ["iglo.base", [join(repo, "dist/iglo-base")], 48231],
  ["upstream", [join(repo, ".upstream/bin/pocketbase")], 48232],
] as const) {
  const dataDir = join(workDir, name, "pb_data");
  cpSync(source, dataDir, { recursive: true });
  await measure(name, [...command], dataDir, port);
  rmSync(join(workDir, name), { recursive: true, force: true });
}
rmSync(source, { recursive: true, force: true });

// A backup of about 1 GiB through versitygw, on iglo.base and upstream, for
// docs/perf/M5.4a-s3-backups.md: create, download, upload and restore, with
// their time and peak RSS, and request latency during the transfers. Each
// server has its own copy and its own bucket. Run by hand; a work directory
// on a disk, not tmpfs:
//
//   bun run upstream:prepare && bun run build
//   TMPDIR=<dir> bun test/perf/backups/s3.ts <dir> [storageMiB]

import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { freePort } from "@test/support/executable";
import { startVersitygw, testS3Credentials } from "@test/support/versitygw";

const workDir = resolve(process.argv[2] ?? ".");
const storageMiB = Number(process.argv[3] ?? 1024);

const token =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";
const asSuperuser = { Authorization: token };
const repo = resolve(import.meta.dir, "../../..");

// random bytes, which do not compress: the zip is as large as the data
function generate(dataDir: string): void {
  cpSync(join(repo, "test/fixtures/pocketbase"), dataDir, { recursive: true });
  const dir = join(dataDir, "storage", "perf");
  mkdirSync(dir, { recursive: true });
  const count = 64;
  for (let f = 0; f < count; f++) {
    const name = join(dir, `file${f}.bin`);
    writeFileSync(name, randomBytes((storageMiB << 20) / count));
    writeFileSync(`${name}.attrs`, `{"user.content_type":"application/octet-stream"}`);
  }
}

function vm(pid: number, key: string): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function sampleLatency(url: string): { stop: () => Promise<Record<string, number>> } {
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
        p50: round(percentile(sorted, 0.5)),
        p99: round(percentile(sorted, 0.99)),
        max: round(sorted.at(-1) ?? 0),
      };
    },
  };
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    throw new Error(`failed: ${cmd.join(" ")}`);
  }
}

async function measure(name: string, command: string[]): Promise<void> {
  const root = join(workDir, name);
  const dataDir = join(root, "pb_data");
  mkdirSync(root, { recursive: true });
  generate(dataDir);

  const s3 = await startVersitygw("perf");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(
    [...command, "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir, "--automigrate=false"],
    { stdout: "ignore", stderr: "inherit", cwd: root, env: { ...process.env, NO_COLOR: "1" } },
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

  const patched = await fetch(`${url}/api/settings`, {
    method: "PATCH",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: JSON.stringify({
      backups: {
        s3: {
          enabled: true,
          bucket: s3.bucket,
          region: testS3Credentials.region,
          endpoint: s3.endpoint,
          accessKey: testS3Credentials.accessKeyId,
          secret: testS3Credentials.secretAccessKey,
          forcePathStyle: true,
        },
      },
    }),
  });
  if (!patched.ok) {
    throw new Error(await patched.text());
  }

  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, vm(pid, "VmRSS"));
  }, 20);

  const step = async (
    label: string,
    work: () => Promise<void>,
    latency = true,
  ): Promise<Record<string, unknown>> => {
    await Bun.sleep(500);
    const before = vm(pid, "VmRSS");
    peak = before;
    const sampling = latency ? sampleLatency(url) : null;
    const start = performance.now();
    await work();
    const seconds = (performance.now() - start) / 1000;
    const stats = await sampling?.stop();
    const out = {
      name,
      step: label,
      seconds: round(seconds),
      rssBefore: Math.round(before),
      rssPeak: Math.round(peak),
      ...stats,
    };
    console.log(JSON.stringify(out));
    return out;
  };

  await step("create", async () => {
    const res = await fetch(`${url}/api/backups`, {
      method: "POST",
      headers: { ...asSuperuser, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "perf.zip" }),
    });
    if (res.status !== 204) {
      throw new Error(await res.text());
    }
  });

  const zipSize = statSync(join(s3.posixRoot, s3.bucket, "perf.zip")).size;
  console.log(JSON.stringify({ name, zipMiB: Math.round(zipSize / (1 << 20)) }));

  const zipPath = join(root, "download.zip");
  const fileToken = (
    (await (
      await fetch(`${url}/api/files/token`, { method: "POST", headers: asSuperuser })
    ).json()) as { token: string }
  ).token;
  await step("download", () =>
    run(["curl", "-sSf", "-o", zipPath, `${url}/api/backups/perf.zip?token=${fileToken}`]),
  );
  if (statSync(zipPath).size !== zipSize) {
    throw new Error("the download's size differs");
  }

  await step("upload", () =>
    run([
      "curl",
      "-sSf",
      "-H",
      `Authorization: ${token}`,
      "-F",
      `file=@${zipPath};filename=perf2.zip;type=application/zip`,
      `${url}/api/backups/upload`,
    ]),
  );
  rmSync(zipPath, { force: true });

  // a marker record is gone once the restored data serves
  const created = await fetch(`${url}/api/collections/_superusers/records`, {
    method: "POST",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "perf-marker@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
    }),
  });
  const { id } = (await created.json()) as { id: string };
  await step(
    "restore",
    async () => {
      await fetch(`${url}/api/backups/perf.zip/restore`, { method: "POST", headers: asSuperuser });
      for (;;) {
        try {
          const r = await fetch(`${url}/api/collections/_superusers/records/${id}`, {
            headers: asSuperuser,
          });
          if (r.status === 404) {
            return;
          }
        } catch {
          // between the two images
        }
        await Bun.sleep(50);
      }
    },
    false,
  );

  clearInterval(sampler);
  proc.kill();
  await proc.exited;
  await s3.stop();
  rmSync(root, { recursive: true, force: true });
}

await measure("iglo", [join(repo, "dist/iglo-base")]);
await measure("upstream", [join(repo, ".upstream/bin/pocketbase")]);

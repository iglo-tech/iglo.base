// A 100 MiB record file through versitygw, on iglo.base and upstream, for
// docs/perf/M5.4b-s3-files.md: the upload and the download, with their time
// and peak RSS, and GET /api/health meanwhile. Each server has its own copy of
// the fixture and its own bucket. Run by hand, with a work directory on a
// disk, not tmpfs:
//
//   bun run upstream:prepare && bun run build
//   TMPDIR=<dir> bun test/perf/files/s3.ts <dir> [runs]

import { randomBytes } from "node:crypto";
import { closeSync, cpSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

import { freePort } from "@test/support/executable";
import { startVersitygw, testS3Credentials } from "@test/support/versitygw";

const workDir = resolve(process.argv[2] ?? ".");
const runs = Number(process.argv[3] ?? 3);
const fileMiB = 100;

const token =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";
const asSuperuser = { Authorization: token };
const repo = resolve(import.meta.dir, "../../..");

function rss(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024;
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

function sampleHealth(url: string): { stop: () => Promise<Record<string, number>> } {
  const times: number[] = [];
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      const start = performance.now();
      await fetch(`${url}/api/health`).then((r) => r.arrayBuffer());
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

async function curl(args: string[]): Promise<string> {
  const proc = Bun.spawn(["curl", "-sSf", ...args], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`curl failed: ${args.join(" ")}`);
  }
  return out;
}

async function measure(name: string, command: string[], source: string): Promise<void> {
  const root = join(workDir, name);
  const dataDir = join(root, "pb_data");
  mkdirSync(root, { recursive: true });
  cpSync(join(repo, "test/fixtures/pocketbase"), dataDir, { recursive: true });

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

  const send = async (method: string, path: string, body: unknown): Promise<void> => {
    const res = await fetch(url + path, {
      method,
      headers: { ...asSuperuser, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
  };
  await send("PATCH", "/api/settings", {
    s3: {
      enabled: true,
      bucket: s3.bucket,
      region: testS3Credentials.region,
      endpoint: s3.endpoint,
      accessKey: testS3Credentials.accessKeyId,
      secret: testS3Credentials.secretAccessKey,
      forcePathStyle: true,
    },
  });
  await send("POST", "/api/collections", {
    name: "perf",
    type: "base",
    viewRule: "",
    fields: [
      { name: "doc", type: "file", maxSelect: 1, maxSize: 200 << 20 },
      { name: "png", type: "file", maxSelect: 1, maxSize: 200 << 20, mimeTypes: ["image/png"] },
    ],
  });

  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, rss(pid));
  }, 20);

  const step = async (label: string, work: () => Promise<void>): Promise<void> => {
    await Bun.sleep(500);
    const before = rss(pid);
    peak = before;
    const sampling = sampleHealth(url);
    const start = performance.now();
    await work();
    const seconds = (performance.now() - start) / 1000;
    const stats = await sampling.stop();
    console.log(
      JSON.stringify({
        name,
        step: label,
        seconds: round(seconds),
        rssBefore: Math.round(before),
        rssPeak: Math.round(peak),
        ...stats,
      }),
    );
  };

  for (let i = 0; i < runs; i++) {
    // the same body, refused by the validation: the multipart intake alone
    await step("intake", async () => {
      await Bun.spawn([
        "curl",
        "-s",
        "-o",
        "/dev/null",
        "-H",
        `Authorization: ${token}`,
        "-F",
        `png=@${source};filename=perf.bin`,
        `${url}/api/collections/perf/records`,
      ]).exited;
    });

    let record = { id: "", doc: "" };
    await step("upload", async () => {
      const out = await curl([
        "-H",
        `Authorization: ${token}`,
        "-F",
        `doc=@${source};filename=perf.bin`,
        `${url}/api/collections/perf/records`,
      ]);
      record = JSON.parse(out) as typeof record;
    });
    await step("download", async () => {
      await curl([
        "-o",
        join(root, "download.bin"),
        `${url}/api/files/perf/${record.id}/${record.doc}`,
      ]);
    });
  }

  clearInterval(sampler);
  proc.kill();
  await proc.exited;
  await s3.stop();
}

mkdirSync(workDir, { recursive: true });
const source = join(workDir, "source.bin");
const fd = openSync(source, "w");
for (let i = 0; i < fileMiB; i++) {
  writeSync(fd, randomBytes(1 << 20));
}
closeSync(fd);

await measure("iglo", [join(repo, "dist/iglo-base")], source);
await measure("upstream", [join(repo, ".upstream/bin/pocketbase")], source);

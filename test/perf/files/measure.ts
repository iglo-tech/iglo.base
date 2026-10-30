// M5.2: memory of thumbnail generation and of serving a large file,
// iglo.base against upstream PocketBase v0.41.0. Not shipped; needs
// `bun run upstream:prepare` and `bun run build` (it runs dist/iglo-base).
//
//   nice -n 10 bun test/perf/files/measure.ts
//
// Upstream stores, on a copy of the vendored fixture, a generated
// 50-megapixel JPEG (8660x5774) and a 160 MiB file of random bytes in a
// collection whose file field lists four thumb sizes. Then each case runs
// on a fresh server on a fresh copy of that pb_data, one at a time:
//
//   - thumb c=1: GET ?thumb=100x100 of the JPEG;
//   - thumb c=4: four GETs at once, each a different size (100x100,
//     200x200, 300x300 and 400x400f), so all four thumbs are made at once;
//   - download: GET of the 160 MiB file, the body read to the end.
//
// The server's RSS is read from /proc/<pid>/status before the case
// (VmRSS) and after it (VmHWM, the peak of the whole process, worker
// threads included). The script stops when MemAvailable falls under
// 1.5 GiB. Everything it writes is under one temporary directory, removed
// at the end.

import { closeSync, cpSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePng } from "@/files/png-raw";

import { synthetic } from "@test/differential/files/images";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { freePort } from "@test/support/executable";
import { defaultLayout, repoRoot, requireTool } from "@test/support/reference-tools";
import { startUpstream } from "@test/support/upstream";

const mib = 1024 * 1024;

function memAvailableMiB(): number {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return Number(m?.[1] ?? 0) / 1024;
}

function guard(): void {
  const avail = memAvailableMiB();
  if (avail < 1536) {
    throw new Error(`MemAvailable is ${avail.toFixed(0)} MiB: stopping`);
  }
}

function procMiB(pid: number, field: "VmRSS" | "VmHWM"): number {
  const m = new RegExp(`${field}:\\s+(\\d+) kB`).exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return Number(m?.[1] ?? 0) / 1024;
}

const root = mkdtempSync(join(tmpdir(), "iglo-base-m52-perf-"));

interface Server {
  url: string;
  pid: number;
  stop(): Promise<void>;
}

async function start(kind: "upstream" | "iglo", dataDir: string): Promise<Server> {
  const port = await freePort();
  const exe =
    kind === "upstream"
      ? requireTool("pocketbase", defaultLayout)
      : join(repoRoot, "dist/iglo-base");
  const proc = Bun.spawn([exe, "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url + "/api/health")).ok) {
        break;
      }
    } catch {
      // not listening yet
    }
    if (i > 200) {
      proc.kill();
      throw new Error(`${kind} did not start`);
    }
    await Bun.sleep(50);
  }
  return {
    url,
    pid: proc.pid,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

async function prepare(): Promise<{ dataDir: string; jpegPath: string; bigPath: string }> {
  // the 50 MP JPEG: a synthetic image scaled up by Bun.Image
  const small = encodePng(synthetic(866, 577, 21), 0);
  const jpeg = await new Bun.Image(small)
    .resize(8660, 5774, { filter: "linear" })
    .jpeg({ quality: 90 })
    .bytes();
  const jpegPath = join(root, "large.jpg");
  await Bun.write(jpegPath, jpeg);

  // 160 MiB of random bytes, written in 1 MiB blocks
  const bigPath = join(root, "big.bin");
  const fd = openSync(bigPath, "w");
  const block = new Uint8Array(mib);
  for (let i = 0; i < 160; i++) {
    crypto.getRandomValues(block.subarray(0, 65536));
    for (let o = 65536; o < mib; o += 65536) {
      block.copyWithin(o, 0, 65536);
    }
    writeSync(fd, block);
  }
  closeSync(fd);

  const dataDir = join(root, "base", "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const setup = await startUpstream({ dataDir });
  try {
    const created = await fetch(setup.url + "/api/collections", {
      method: "POST",
      headers: { authorization: superuserToken, "content-type": "application/json" },
      body: JSON.stringify({
        name: "perf",
        type: "base",
        listRule: "",
        viewRule: "",
        fields: [
          {
            name: "file",
            type: "file",
            maxSelect: 1,
            maxSize: 200 * mib,
            thumbs: ["200x200", "300x300", "400x400f"],
          },
        ],
      }),
    });
    if (created.status !== 200) {
      throw new Error(`collection: ${created.status} ${await created.text()}`);
    }
    const ids: Record<string, { id: string; name: string }> = {};
    for (const [key, path, name] of [
      ["jpeg", jpegPath, "large.jpg"],
      ["big", bigPath, "big.bin"],
    ] as const) {
      const form = new FormData();
      form.append("file", Bun.file(path), name);
      const res = await fetch(setup.url + "/api/collections/perf/records", {
        method: "POST",
        headers: { authorization: superuserToken },
        body: form,
      });
      const record = (await res.json()) as { id: string; file: string };
      if (res.status !== 200) {
        throw new Error(`upload ${name}: ${res.status} ${JSON.stringify(record)}`);
      }
      ids[key] = { id: record.id, name: record.file };
    }
    await Bun.write(join(root, "ids.json"), JSON.stringify(ids));
  } finally {
    await setup.stop();
  }
  return { dataDir, jpegPath, bigPath };
}

interface Row {
  server: string;
  label: string;
  status: string;
  before: number;
  peak: number;
  ms: number;
}

async function runCase(
  kind: "upstream" | "iglo",
  baseDir: string,
  label: string,
  paths: string[],
): Promise<Row> {
  guard();
  const dataDir = join(root, `${kind}-${label.replaceAll(/\W+/g, "-")}`, "pb_data");
  cpSync(baseDir, dataDir, { recursive: true });
  const server = await start(kind, dataDir);
  try {
    await Bun.sleep(1000);
    const before = procMiB(server.pid, "VmRSS");
    const started = performance.now();
    const statuses = await Promise.all(
      paths.map(async (p) => {
        const res = await fetch(server.url + p);
        // read the body to the end without keeping it
        const reader = res.body?.getReader();
        for (;;) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) {
            break;
          }
        }
        // a thumb is served under its size prefix (Content-Disposition)
        const name = /filename="([^"]*)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
        const served = /^\d+x\d+f?_/.test(name ?? "") ? "thumb" : "original";
        return `${res.status} ${served}`;
      }),
    );
    const ms = performance.now() - started;
    const peak = procMiB(server.pid, "VmHWM");
    return {
      server: kind === "iglo" ? "iglo.base" : "upstream",
      label,
      status: statuses.join(","),
      before,
      peak,
      ms,
    };
  } finally {
    await server.stop();
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  }
}

try {
  guard();
  const { dataDir } = await prepare();
  const ids = JSON.parse(readFileSync(join(root, "ids.json"), "utf8")) as Record<
    string,
    { id: string; name: string }
  >;
  const jpeg = ids["jpeg"] as { id: string; name: string };
  const big = ids["big"] as { id: string; name: string };
  const jpegPath = `/api/files/perf/${jpeg.id}/${jpeg.name}`;
  const cases: [string, string[]][] = [
    ["50 MP JPEG thumb, c=1", [`${jpegPath}?thumb=100x100`]],
    [
      "50 MP JPEG thumbs, c=4",
      ["100x100", "200x200", "300x300", "400x400f"].map((s) => `${jpegPath}?thumb=${s}`),
    ],
    ["160 MiB download", [`/api/files/perf/${big.id}/${big.name}`]],
  ];
  const rows: Row[] = [];
  for (const [label, paths] of cases) {
    for (const kind of ["upstream", "iglo"] as const) {
      const row = await runCase(kind, dataDir, label, paths);
      rows.push(row);
      console.error(`${row.server} ${label}: ${JSON.stringify(row)}`);
    }
  }
  console.log(
    "| Case | Server | Status (served) | RSS before (MiB) | Peak RSS (MiB) | Peak − before | ms |",
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.server} | ${r.status} | ${r.before.toFixed(0)} | ${r.peak.toFixed(0)} | ${(r.peak - r.before).toFixed(0)} | ${r.ms.toFixed(0)} |`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

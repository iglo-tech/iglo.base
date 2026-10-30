// M0.7 spike: which library makes upstream's thumbnails in iglo.base (D10).
// Not shipped; needs `bun run upstream:prepare` and the npm registry.
//
// Usage: nice -n 10 bun scripts/spikes/M0.7/run.ts [--skip-perf] [--skip-quality]
//          [--only=bun-imaging,bun-hybrid,...] [--concurrency=1,4]
//
// --only limits the candidates built, compared and measured (to re-run the
// ones a change affects); --concurrency limits the speed measurements.
//
// 1. Installs the candidate packages (package.json here) into
//    scripts/spikes/M0.7/node_modules, removed at the end, and compiles bench.ts with each
//    candidate's worker into its own executable. Executable size minus the
//    "none" build is the size the candidate adds.
// 2. Writes the generated image set (images.ts) and has upstream PocketBase
//    v0.41.0 make every thumb size of every image through the files API.
// 3. Makes the same thumbs with each candidate (one worker) and compares
//    them with upstream's: dimensions, content type, and the mean absolute
//    error per channel after decoding both with the same decoder.
//    The compatibility set (writeCompatSet) is compared the same way: EXIF
//    orientations and GIF logical screens, some at a lower
//    PB_THUMBS_MAX_SOURCE_PIXELS, with a server started with that limit.
// 4. Edge cases: corrupt originals and one over PB_THUMBS_MAX_SOURCE_PIXELS,
//    on upstream and on each candidate.
// 5. Speed and memory: a 50-megapixel JPEG and a 12-megapixel PNG to 100x100
//    and 1200x0, at concurrency 1 and 4, one measurement at a time in a fresh
//    process, upstream included. A measurement is killed when MemAvailable
//    falls under 2 GiB.
//
// Everything generated goes to one temporary root under dist/ and is
// removed at the end, with the installed packages. The results are printed
// as Markdown tables (docs/perf/M0.7-thumbnails.md).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  hostFacts,
  memAvailableMiB,
  procStats,
  repoRoot,
  sampler,
  spikeRoot,
  startUpstreamServer,
  upsertSuperuser,
  type Server,
} from "@/../scripts/spikes/M0.8/common";
import {
  synthetic,
  writeCompatSet,
  writeEdgeSet,
  writeQualitySet,
  type TestImage,
} from "@/../scripts/spikes/M0.7/images";
import { decodePng, encodePng, type Raw } from "@/../scripts/spikes/M0.7/png";
import type { Job, JobResult } from "@/../scripts/spikes/M0.7/workers/serve";

const spikeDir = join(repoRoot, "scripts/spikes/M0.7");
const skipPerf = process.argv.includes("--skip-perf");
const skipQuality = process.argv.includes("--skip-quality");
const arg = (name: string): string[] | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(",");
const only = arg("only");
const candidates = [
  "bun-native",
  "bun-imaging",
  "bun-hybrid",
  "bun-hybrid2",
  "jsquash",
  "vips",
  "sharp",
].filter((c) => !only || only.includes(c));
const concurrencies = (arg("concurrency") ?? ["1", "4"]).map(Number);
const sizes = [
  "100x100",
  "70x50",
  "70x50t",
  "70x50b",
  "70x50f",
  "0x50",
  "70x0",
  "500x500f",
  "800x0",
  "1200x0",
];
const maxPixels = 100 << 20;

// The packages are installed first and the spike runs in a new process:
// Bun's resolver keeps a directory it found missing missing.
if (!process.argv.includes("--installed")) {
  const install = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], {
    cwd: spikeDir,
    stderr: "inherit",
  });
  const spike = install.success
    ? Bun.spawnSync([process.execPath, ...process.argv.slice(1), "--installed"], {
        stdio: ["inherit", "inherit", "inherit"],
      })
    : install;
  rmSync(join(spikeDir, "node_modules"), { recursive: true, force: true });
  process.exit(spike.exitCode ?? 1);
}

const { root, cleanup } = spikeRoot("M0.7");
const log = (s: string): void => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const tables: string[] = [`Host: ${hostFacts()}`];
const table = (head: string[], rows: (string | number)[][]): void => {
  tables.push(
    [
      `| ${head.join(" | ")} |`,
      `|${head.map(() => "---").join("|")}|`,
      ...rows.map((r) => `| ${r.join(" | ")} |`),
    ].join("\n"),
  );
};

async function run(cmd: string[], cwd = repoRoot): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [
    await new Response(proc.stdout).text(),
    await new Response(proc.stderr).text(),
  ];
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed:\n${out}\n${err}`);
  }
  return out;
}

// --- 1. packages and executables

async function build(): Promise<Map<string, string>> {
  const bins = new Map<string, string>();
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const rows: (string | number)[][] = [];
  let base = 0;
  for (const c of ["none", ...candidates]) {
    const outfile = join(binDir, `bench-${c}`);
    try {
      await run([
        process.execPath,
        "build",
        "--compile",
        join(spikeDir, "bench.ts"),
        join(spikeDir, `workers/worker-${c}.ts`),
        "--outfile",
        outfile,
      ]);
      const size = statSync(outfile).size;
      if (c === "none") {
        base = size;
      }
      bins.set(c, outfile);
      rows.push([
        c,
        (size / 2 ** 20).toFixed(1),
        c === "none" ? "" : ((size - base) / 2 ** 20).toFixed(2),
      ]);
    } catch (err) {
      rows.push([c, "build failed", String(err).split("\n").slice(1, 3).join(" ")]);
    }
  }
  table(["build", "executable MiB", "added MiB"], rows);
  return bins;
}

// --- bench runs, one process at a time, killed on low memory

interface BenchResult {
  warmMs: number[];
  rssBeforeMiB: number;
  hwmMiB: number;
  wallMs: number;
  results: JobResult[];
}

let jobFile = 0;

async function bench(
  bins: Map<string, string>,
  candidate: string,
  concurrency: number,
  jobs: Job[],
  timeoutMs = 300_000,
): Promise<BenchResult | string> {
  const bin = bins.get(candidate);
  if (!bin && candidate !== "sharp") {
    return "not built";
  }
  if (memAvailableMiB() < 2560) {
    return `skipped: MemAvailable ${memAvailableMiB().toFixed(0)} MiB`;
  }
  const path = join(root, `jobs-${++jobFile}.json`);
  writeFileSync(path, JSON.stringify({ concurrency, jobs }));
  // sharp's native addon is not embedded by bun build --compile, so the
  // baseline runs from source
  const cmd =
    candidate === "sharp"
      ? [process.execPath, join(spikeDir, "bench.ts"), candidate, path]
      : [bin ?? "", candidate, path];
  const proc = Bun.spawn(cmd, {
    cwd: candidate === "sharp" ? spikeDir : root,
    stdout: "pipe",
    stderr: "pipe",
  });
  let killed = "";
  const watch = sampler(
    proc.pid,
    () => {
      killed = "killed: MemAvailable under 2 GiB";
      proc.kill("SIGKILL");
    },
    20,
    2048,
  );
  const timer = setTimeout(() => {
    killed = `killed: no result after ${timeoutMs / 1000} s`;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const stderr = new Response(proc.stderr).text();
  void new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  const { peakMiB } = watch.stop();
  if (killed) {
    return `${killed} (peak RSS seen ${peakMiB.toFixed(0)} MiB)`;
  }
  if (code !== 0 || !existsSync(`${path}.result.json`)) {
    return `exit ${code}: ${(await stderr).trim().split("\n").slice(-2).join(" ").slice(0, 200)}`;
  }
  return JSON.parse(readFileSync(`${path}.result.json`, "utf8")) as BenchResult;
}

// --- decoding thumbs for the comparison: Bun.Image for every format

async function decode(bytes: Uint8Array): Promise<Raw> {
  return decodePng(
    await new Bun.Image(bytes, { autoOrient: false }).png({ compressionLevel: 0 }).bytes(),
  );
}

// mean absolute error per channel (R, G, B premultiplied by alpha, then A)
function mae(a: Raw, b: Raw): number[] {
  const sum = [0, 0, 0, 0];
  const n = a.width * a.height;
  for (let i = 0; i < n * 4; i += 4) {
    const aa = a.pix[i + 3] as number;
    const ba = b.pix[i + 3] as number;
    for (let c = 0; c < 3; c++) {
      sum[c] =
        (sum[c] as number) +
        Math.abs(((a.pix[i + c] as number) * aa) / 255 - ((b.pix[i + c] as number) * ba) / 255);
    }
    sum[3] = (sum[3] as number) + Math.abs(aa - ba);
  }
  return sum.map((s) => s / n);
}

// a 3x3 box blur, premultiplied
function blur(r: Raw): Float64Array {
  const out = new Float64Array(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= r.width || yy >= r.height) {
            continue;
          }
          const i = (yy * r.width + xx) * 4;
          const al = r.pix[i + 3] as number;
          for (let c = 0; c < 3; c++) {
            acc[c] = (acc[c] as number) + ((r.pix[i + c] as number) * al) / 255;
          }
          acc[3] = (acc[3] as number) + al;
          n++;
        }
      }
      for (let c = 0; c < 4; c++) {
        out[(y * r.width + x) * 4 + c] = (acc[c] as number) / n;
      }
    }
  }
  return out;
}

// the mean absolute error after a 3x3 box blur of both: Floyd-Steinberg
// dithering turns a small input difference into a different dot pattern
// that the plain per-pixel error counts in full
function blurredMae(a: Raw, b: Raw): number[] {
  const ba = blur(a);
  const bb = blur(b);
  const sum = [0, 0, 0, 0];
  for (let i = 0; i < ba.length; i++) {
    sum[i % 4] = (sum[i % 4] as number) + Math.abs((ba[i] as number) - (bb[i] as number));
  }
  return sum.map((v) => v / (a.width * a.height));
}

// --- upstream

interface Upstream {
  server: Server;
  dataDir: string;
  token: string;
}

async function startUpstream(dataDir: string): Promise<Upstream> {
  const server = await startUpstreamServer(dataDir, root);
  const res = await fetch(`${server.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: "spike@example.com", password: "spike-password-123" }),
  });
  const { token } = (await res.json()) as { token: string };
  return { server, dataDir, token };
}

async function upload(
  u: Upstream,
  dir: string,
  name: string,
  contentType: string,
): Promise<{ id: string; file: string }> {
  const form = new FormData();
  form.append("file", new File([readFileSync(join(dir, name))], name, { type: contentType }));
  const res = await fetch(`${u.server.url}/api/collections/thumbs/records`, {
    method: "POST",
    headers: { authorization: u.token },
    body: form,
  });
  const json = (await res.json()) as { id: string; file: string };
  if (res.status !== 200) {
    throw new Error(`upload ${name}: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function thumb(
  u: Upstream,
  rec: { id: string; file: string },
  size: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetch(`${u.server.url}/api/files/thumbs/${rec.id}/${rec.file}?thumb=${size}`);
  if (res.status !== 200) {
    throw new Error(`thumb ${rec.file} ${size}: ${res.status}`);
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "",
  };
}

// runs fn on the same data with PB_THUMBS_MAX_SOURCE_PIXELS set, then
// restarts u's server without it
async function withLimit<T>(
  u: Upstream,
  limit: number,
  fn: (limited: Upstream) => Promise<T>,
): Promise<T> {
  await u.server.stop();
  process.env.PB_THUMBS_MAX_SOURCE_PIXELS = String(limit);
  let limited: Upstream | undefined;
  try {
    limited = await startUpstream(u.dataDir);
    return await fn(limited);
  } finally {
    await limited?.server.stop();
    delete process.env.PB_THUMBS_MAX_SOURCE_PIXELS;
    const restarted = await startUpstream(u.dataDir);
    u.server = restarted.server;
    u.token = restarted.token;
  }
}

async function newUpstreamData(dataDir: string): Promise<Upstream> {
  await upsertSuperuser(dataDir, root, "spike@example.com", "spike-password-123");
  const u = await startUpstream(dataDir);
  const res = await fetch(`${u.server.url}/api/collections`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: u.token },
    body: JSON.stringify({
      name: "thumbs",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        {
          name: "file",
          type: "file",
          maxSelect: 1,
          maxSize: 300 << 20,
          thumbs: sizes.filter((s) => s !== "100x100"),
        },
      ],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`collection: ${res.status} ${await res.text()}`);
  }
  return u;
}

// --- 2./3. quality

interface Ref {
  image: TestImage;
  size: string;
  original: boolean;
  bytes: Uint8Array;
  contentType: string;
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function quality(
  bins: Map<string, string>,
  u: Upstream,
  qDir: string,
  images: TestImage[],
  compat: TestImage[],
  edges: TestImage[],
): Promise<void> {
  log("upstream thumbs of the image set");
  const refs: Ref[] = [];
  for (const image of [...images, ...edges]) {
    const rec = await upload(u, qDir, image.name, image.contentType);
    const original = readFileSync(join(qDir, image.name));
    for (const size of image.width === 0 ? ["100x100"] : sizes) {
      const t = await thumb(u, rec, size);
      refs.push({ image, size, original: same(t.bytes, original), ...t });
    }
  }
  log("upstream thumbs of the compatibility set");
  const compatRefs = async (target: Upstream, list: TestImage[]): Promise<void> => {
    for (const image of list) {
      const rec = await upload(target, qDir, image.name, image.contentType);
      const original = readFileSync(join(qDir, image.name));
      for (const size of image.sizes ?? sizes) {
        const t = await thumb(target, rec, size);
        refs.push({ image, size, original: same(t.bytes, original), ...t });
      }
    }
  };
  await compatRefs(
    u,
    compat.filter((i) => !i.limit),
  );
  const limited = compat.filter((i) => i.limit);
  const limit = limited[0]?.limit;
  if (limit) {
    if (limited.some((i) => i.limit !== limit)) {
      throw new Error("one PB_THUMBS_MAX_SOURCE_PIXELS for the compatibility set");
    }
    await withLimit(u, limit, (l) => compatRefs(l, limited));
  }
  const thumbable = images.filter((i) => !["image/bmp", "image/tiff"].includes(i.contentType));
  const rows: (string | number)[][] = [];
  const perImage: (string | number)[][] = [];
  const decodeRows: (string | number)[][] = [];
  const edgeRows: (string | number)[][] = [];
  const compatRows: (string | number)[][] = [];
  const compatImageRows: (string | number)[][] = [];
  for (const c of candidates) {
    log(`quality: ${c}`);
    const outDir = join(root, `out-${c}`);
    mkdirSync(outDir);
    const jobs: Job[] = [];
    const meta: {
      ref?: Ref;
      image: TestImage;
      size: string;
      kind: "set" | "compat" | "decode" | "edge";
    }[] = [];
    for (const image of thumbable) {
      for (const size of sizes) {
        meta.push({
          ref: refs.find((r) => r.image === image && r.size === size),
          image,
          size,
          kind: "set",
        });
      }
    }
    for (const image of compat) {
      for (const size of image.sizes ?? sizes) {
        meta.push({
          ref: refs.find((r) => r.image === image && r.size === size),
          image,
          size,
          kind: "compat",
        });
      }
    }
    for (const image of images.filter((i) => !thumbable.includes(i))) {
      meta.push({ image, size: "70x50", kind: "decode" });
    }
    for (const image of edges) {
      meta.push({ ref: refs.find((r) => r.image === image), image, size: "100x100", kind: "edge" });
    }
    meta.forEach((m, id) =>
      jobs.push({
        id,
        input: join(qDir, m.image.name),
        // BMP and TIFF are never thumbed by the API; the decode test asks for PNG
        contentType: m.kind === "decode" ? "image/png" : m.image.contentType,
        size: m.size,
        maxPixels: m.image.limit ?? maxPixels,
        out: join(outDir, `${id}`),
      }),
    );
    const res = await bench(bins, c, 1, jobs, c === "vips" ? 30_000 : 120_000);
    if (typeof res === "string") {
      rows.push([c, res, "", "", "", ""]);
      continue;
    }
    const bySize = new Map<string, number[][]>();
    let dimsOk = 0;
    let typeOk = 0;
    let total = 0;
    const failures: string[] = [];
    // per compatibility image: sizes, same outcome, same dimensions and
    // content type, the largest MAE channel, the first difference
    const compatByImage = new Map<
      string,
      { n: number; outcome: number; dims: number; types: number; worst: number; diff: string }
    >();
    for (const r of res.results) {
      const m = meta[r.id];
      if (!m) {
        continue;
      }
      if (m.kind === "compat") {
        const row = compatByImage.get(m.image.name) ?? {
          n: 0,
          outcome: 0,
          dims: 0,
          types: 0,
          worst: 0,
          diff: "",
        };
        compatByImage.set(m.image.name, row);
        row.n++;
        const upOriginal = m.ref?.original ?? false;
        const note = (d: string): void => {
          row.diff ||= `${m.size}: ${d}`;
        };
        if (!m.ref) {
          note("no upstream result");
        } else if (upOriginal !== Boolean(r.error)) {
          note(
            upOriginal ? "made a thumb, upstream served the original" : `error: ${r.error ?? ""}`,
          );
        } else if (upOriginal) {
          row.outcome++;
          row.dims++;
          row.types++;
        } else {
          row.outcome++;
          const a = await decode(m.ref.bytes);
          const b = await decode(readFileSync(join(outDir, `${r.id}`)));
          if (r.contentType === m.ref.contentType) {
            row.types++;
          } else {
            note(`${r.contentType}, upstream ${m.ref.contentType}`);
          }
          if (a.width !== b.width || a.height !== b.height) {
            note(`${b.width}x${b.height}, upstream ${a.width}x${a.height}`);
          } else {
            row.dims++;
            row.worst = Math.max(row.worst, ...mae(a, b));
          }
        }
        continue;
      }
      if (m.kind === "decode") {
        decodeRows.push([c, m.image.name, r.error ? `error: ${r.error.slice(0, 80)}` : "decodes"]);
        continue;
      }
      if (m.kind === "edge") {
        const up = m.ref?.original ? "original served" : "thumb";
        edgeRows.push([
          c,
          m.image.name,
          up,
          r.error ? `error (original): ${r.error.slice(0, 90)}` : "made a thumb",
          r.ms.toFixed(1),
        ]);
        continue;
      }
      total++;
      if (r.error || !m.ref) {
        failures.push(`${m.image.name} ${m.size}: ${r.error?.slice(0, 80)}`);
        continue;
      }
      const a = await decode(m.ref.bytes);
      const b = await decode(readFileSync(join(outDir, `${r.id}`)));
      if (r.contentType === m.ref.contentType) {
        typeOk++;
      }
      if (a.width !== b.width || a.height !== b.height) {
        failures.push(
          `${m.image.name} ${m.size}: ${b.width}x${b.height}, upstream ${a.width}x${a.height}`,
        );
        continue;
      }
      dimsOk++;
      const e = mae(a, b);
      const mode =
        m.size.endsWith("t") || m.size.endsWith("b") || m.size.endsWith("f")
          ? m.size.slice(-1)
          : m.size.startsWith("0x") || m.size.endsWith("x0")
            ? "aspect"
            : "fill";
      for (const key of [mode, "all"]) {
        bySize.set(key, [...(bySize.get(key) ?? []), e]);
      }
      const blurred = blurredMae(a, b);
      bySize.set("blurred", [...(bySize.get("blurred") ?? []), blurred]);
      perImage.push([
        c,
        m.image.name,
        m.size,
        e.map((v) => v.toFixed(2)).join(" / "),
        blurred.map((v) => v.toFixed(2)).join(" / "),
      ]);
    }
    const fmt = (key: string): string => {
      const list = bySize.get(key) ?? [];
      if (list.length === 0) {
        return "";
      }
      const mean = [0, 1, 2, 3].map(
        (ch) => list.reduce((s, e) => s + (e[ch] as number), 0) / list.length,
      );
      const worst = Math.max(...list.map((e) => Math.max(...e)));
      return `${mean.map((v) => v.toFixed(2)).join(" / ")} (max ${worst.toFixed(1)})`;
    };
    rows.push([
      c,
      `${dimsOk}/${total}`,
      `${typeOk}/${total}`,
      fmt("fill"),
      fmt("t"),
      fmt("b"),
      fmt("f"),
      fmt("aspect"),
      fmt("all"),
      fmt("blurred"),
      failures.slice(0, 6).join("; "),
    ]);
    const sum = [...compatByImage.values()].reduce(
      (t, x) => ({
        n: t.n + x.n,
        outcome: t.outcome + x.outcome,
        dims: t.dims + x.dims,
        types: t.types + x.types,
        worst: Math.max(t.worst, x.worst),
      }),
      { n: 0, outcome: 0, dims: 0, types: 0, worst: 0 },
    );
    compatRows.push([
      c,
      `${sum.outcome}/${sum.n}`,
      `${sum.dims}/${sum.n}`,
      `${sum.types}/${sum.n}`,
      sum.worst.toFixed(1),
    ]);
    for (const [name, x] of compatByImage) {
      compatImageRows.push([
        c,
        name,
        `${x.outcome}/${x.n}`,
        `${x.dims}/${x.n}`,
        x.worst.toFixed(2),
        x.diff.slice(0, 100),
      ]);
    }
  }
  table(
    [
      "candidate",
      "dimensions equal",
      "content type equal",
      "MAE fill (WxH)",
      "MAE t",
      "MAE b",
      "MAE f",
      "MAE 0xH/Wx0",
      "MAE all",
      "MAE all, 3x3 blurred",
      "failures",
    ],
    rows,
  );
  table(
    [
      "candidate",
      "compatibility set: same outcome (thumb or original)",
      "same dimensions",
      "same content type",
      "largest MAE channel",
    ],
    compatRows,
  );
  table(
    [
      "candidate",
      "original",
      "same outcome",
      "same dimensions",
      "largest MAE channel",
      "first difference",
    ],
    compatImageRows,
  );
  // what upstream did with each compatibility image
  const upstreamRows: (string | number)[][] = [];
  for (const image of compat) {
    const cells: string[] = [];
    for (const r of refs.filter((x) => x.image === image)) {
      const d = r.original ? undefined : await decode(r.bytes);
      cells.push(`${r.size}: ${d ? `${d.width}x${d.height}` : "original"}`);
    }
    upstreamRows.push([image.name, image.note, cells.join(", ")]);
  }
  table(["original", "note", "upstream, per size"], upstreamRows);
  table(["candidate", "original", "decode as PNG"], decodeRows);
  table(["candidate", "original", "upstream", "candidate", "ms"], edgeRows);
  writeFileSync(join(root, "per-image.json"), JSON.stringify(perImage));
  // per original: the mean over all sizes, and the worst size
  for (const c of candidates) {
    const mine = perImage.filter((r) => r[0] === c);
    if (mine.length === 0) {
      continue;
    }
    const names = [...new Set(mine.map((r) => r[1] as string))];
    table(
      [
        `${c}: original`,
        "mean MAE R / G / B / A over the sizes",
        "3x3 blurred",
        "worst size (largest channel)",
      ],
      names.map((n) => {
        const list = mine
          .filter((r) => r[1] === n)
          .map((r) => ({
            size: r[2] as string,
            e: String(r[3]).split(" / ").map(Number),
            b: String(r[4]).split(" / ").map(Number),
          }));
        const mean = (key: "e" | "b"): string =>
          [0, 1, 2, 3]
            .map((ch) =>
              (list.reduce((s, x) => s + (x[key][ch] as number), 0) / list.length).toFixed(2),
            )
            .join(" / ");
        const worst = list.reduce((w, x) => (Math.max(...x.e) > Math.max(...w.e) ? x : w));
        return [n, mean("e"), mean("b"), `${worst.size}: ${Math.max(...worst.e).toFixed(2)}`];
      }),
    );
  }
}

// --- 5. speed and memory

async function perf(bins: Map<string, string>, u: Upstream): Promise<void> {
  const bigDir = join(root, "big");
  mkdirSync(bigDir);
  log("generating the 50 MP JPEG");
  {
    const raw = synthetic(8660, 5773, 11);
    let png: Uint8Array | undefined = encodePng(raw, 0);
    raw.pix = new Uint8Array();
    writeFileSync(
      join(bigDir, "big.jpg"),
      await new Bun.Image(png, { maxPixels: 1 << 30 }).jpeg({ quality: 90 }).bytes(),
    );
    png = undefined;
    Bun.gc(true);
  }
  log("generating the 12 MP PNG");
  writeFileSync(join(bigDir, "big.png"), encodePng(synthetic(4240, 2832, 12), 6));
  Bun.gc(true);
  const bigs = [
    { name: "big.jpg", contentType: "image/jpeg", label: "50 MP JPEG (8660x5773)" },
    { name: "big.png", contentType: "image/png", label: "12 MP PNG (4240x2832)" },
  ];
  tables.push(
    `Inputs: big.jpg ${(statSync(join(bigDir, "big.jpg")).size / 2 ** 20).toFixed(1)} MiB, big.png ${(statSync(join(bigDir, "big.png")).size / 2 ** 20).toFixed(1)} MiB`,
  );

  // upstream: four records per image, a fresh server per measurement
  log("upstream: uploading the large images");
  const recs = new Map<string, { id: string; file: string }[]>();
  for (const b of bigs) {
    const list = [];
    for (let i = 0; i < 4; i++) {
      list.push(await upload(u, bigDir, b.name, b.contentType));
    }
    recs.set(b.name, list);
  }
  await u.server.stop();
  const rows: (string | number)[][] = [];
  const upstreamThumbs = new Map<string, Uint8Array>();
  for (const b of bigs) {
    for (const size of ["100x100", "1200x0"]) {
      for (const conc of concurrencies) {
        // drop the thumbs the previous measurement made
        const storage = join(u.dataDir, "storage");
        for (const col of readdirSync(storage)) {
          for (const rec of readdirSync(join(storage, col))) {
            for (const f of readdirSync(join(storage, col, rec))) {
              if (f.startsWith("thumbs_")) {
                rmSync(join(storage, col, rec, f), { recursive: true });
              }
            }
          }
        }
        const up = await startUpstream(u.dataDir);
        const before = procStats(up.server.pid).rssMiB;
        const watch = sampler(up.server.pid, () => void up.server.stop(), 20, 2048);
        const started = performance.now();
        const times: number[] = [];
        let note = "";
        await Promise.all(
          (recs.get(b.name) ?? []).slice(0, conc).map(async (rec, i) => {
            const t0 = performance.now();
            try {
              const t = await thumb(up, rec, size);
              times.push(performance.now() - t0);
              if (i === 0 && conc === 1) {
                upstreamThumbs.set(`${b.name} ${size}`, t.bytes);
              }
            } catch (err) {
              note = String(err);
            }
          }),
        );
        const wall = performance.now() - started;
        const { peakMiB, lowMem } = watch.stop();
        const hwm = lowMem ? 0 : procStats(up.server.pid).hwmMiB;
        await up.server.stop();
        rows.push([
          "upstream (Go)",
          b.label,
          size,
          conc,
          lowMem ? "killed: low memory" : wall.toFixed(0),
          times.map((t) => t.toFixed(0)).join(", "),
          `${Math.max(hwm, peakMiB).toFixed(0)} (idle ${before.toFixed(0)})`,
          note,
        ]);
        log(
          `upstream ${b.name} ${size} c${conc}: ${wall.toFixed(0)} ms, peak ${hwm.toFixed(0)} MiB`,
        );
      }
    }
  }

  const compareRows: (string | number)[][] = [];
  for (const c of candidates) {
    for (const b of bigs) {
      for (const size of ["100x100", "1200x0"]) {
        for (const conc of concurrencies) {
          const outBase = join(root, `big-${c}-${b.name}-${size}`);
          const jobs: Job[] = Array.from({ length: conc }, (_, id) => ({
            id,
            input: join(bigDir, b.name),
            contentType: b.contentType,
            size,
            maxPixels,
            out: id === 0 ? outBase : undefined,
          }));
          const res = await bench(bins, c, conc, jobs, c === "vips" ? 60_000 : 300_000);
          if (typeof res === "string") {
            rows.push([c, b.label, size, conc, res, "", "", ""]);
            log(`${c} ${b.name} ${size} c${conc}: ${res}`);
            continue;
          }
          const errors = res.results.filter((r) => r.error).map((r) => r.error);
          rows.push([
            c,
            b.label,
            size,
            conc,
            res.wallMs.toFixed(0),
            res.results.map((r) => r.ms.toFixed(0)).join(", "),
            `${res.hwmMiB.toFixed(0)} (idle ${res.rssBeforeMiB.toFixed(0)})`,
            errors.length > 0 ? String(errors[0]).slice(0, 100) : "",
          ]);
          log(
            `${c} ${b.name} ${size} c${conc}: ${res.wallMs.toFixed(0)} ms, peak ${res.hwmMiB.toFixed(0)} MiB`,
          );
          const ref = upstreamThumbs.get(`${b.name} ${size}`);
          if (conc === 1 && ref && existsSync(outBase)) {
            const a = await decode(ref);
            const o = await decode(readFileSync(outBase));
            compareRows.push([
              c,
              b.label,
              size,
              `${o.width}x${o.height}${a.width === o.width && a.height === o.height ? "" : ` (upstream ${a.width}x${a.height})`}`,
              a.width === o.width && a.height === o.height
                ? mae(a, o)
                    .map((v) => v.toFixed(2))
                    .join(" / ")
                : "",
            ]);
          }
        }
      }
    }
  }
  table(
    [
      "backend",
      "original",
      "thumb",
      "concurrency",
      "wall ms",
      "per thumb ms",
      "peak RSS MiB",
      "note",
    ],
    rows,
  );
  table(["candidate", "original", "thumb", "size", "MAE vs upstream R / G / B / A"], compareRows);
}

// --- main

try {
  const bins = await build();
  const qDir = join(root, "q");
  mkdirSync(qDir);
  const images = await writeQualitySet(qDir, join(spikeDir, "node_modules/sharp"));
  const compat = await writeCompatSet(qDir);
  const edges = await writeEdgeSet(
    qDir,
    readFileSync(join(qDir, "photo.jpg")),
    readFileSync(join(qDir, "photo.png")),
  );
  const u = await newUpstreamData(join(root, "pb_data"));
  try {
    if (!skipQuality) {
      await quality(bins, u, qDir, images, compat, edges);
    }
    if (!skipPerf) {
      await perf(bins, u);
    }
  } finally {
    await u.server.stop();
  }
  console.log(tables.join("\n\n"));
} finally {
  cleanup();
}

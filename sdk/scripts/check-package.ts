// Checks the built package from the outside, the way a consumer uses it:
// `npm pack`, install the tarball into a temporary project, then
//   - import it as ESM and require it as CommonJS, with Node and with Bun,
//   - evaluate the ./umd file in a fake `window`,
//   - type check ESM, CommonJS and bundler-style imports against the declarations.
// Run `bun run sdk:build` first.
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdkRoot = join(import.meta.dirname, "..");
const consumerSources = join(import.meta.dirname, "consumer");
const tsc = join(sdkRoot, "..", "node_modules", "typescript", "lib", "tsc.js");

const tmp = await mkdtemp(join(tmpdir(), "iglo-sdk-consumer-"));
let failed = false;

function run(name: string, cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { cwd: tmp, stdout: "pipe", stderr: "pipe" });
  const out = (result.stdout.toString() + result.stderr.toString()).trim();
  if (result.exitCode === 0) {
    console.log(`ok   ${name}${out ? `: ${out.split("\n").join(" | ")}` : ""}`);
  } else {
    failed = true;
    console.log(`FAIL ${name}\n${out}`);
  }
}

try {
  const pack = Bun.spawnSync(["npm", "pack", "--pack-destination", tmp, "--json"], {
    cwd: sdkRoot,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (pack.exitCode !== 0) {
    throw new Error("npm pack failed");
  }
  const packed = JSON.parse(pack.stdout.toString())[0] as {
    filename: string;
    files: Array<{ path: string }>;
  };
  const files = packed.files.map((f) => f.path);
  for (const required of ["LICENSE", "README.md", "CHANGELOG.md", "package.json"]) {
    if (!files.includes(required)) {
      throw new Error(`${required} is missing from the package`);
    }
  }
  if (
    files.some((f: string) => !/^(dist\/|LICENSE|README\.md|CHANGELOG\.md|package\.json)/.test(f))
  ) {
    throw new Error(`unexpected files in the package: ${files.join(", ")}`);
  }
  console.log(`ok   package files (${files.length}): ${files.join(" ")}`);

  await writeFile(
    join(tmp, "package.json"),
    '{"name":"consumer","private":true,"version":"0.0.0"}',
  );
  run("npm install tarball", [
    "npm",
    "install",
    "--no-audit",
    "--no-fund",
    join(tmp, packed.filename),
  ]);
  await cp(consumerSources, tmp, { recursive: true });

  for (const runtime of ["node", "bun"]) {
    run(`${runtime} import (ESM)`, [runtime, "esm.mjs"]);
    run(`${runtime} require (CommonJS)`, [runtime, "cjs.cjs"]);
    run(`${runtime} ./umd in a fake window`, [runtime, "umd.cjs"]);
  }

  const base = [
    "node",
    tsc,
    "--noEmit",
    "--strict",
    "--target",
    "es2021",
    "--lib",
    "es2021,dom",
    "--types",
    "",
  ];
  run("tsc module=node16", [
    ...base,
    "--module",
    "node16",
    "--moduleResolution",
    "node16",
    "esm-types.mts",
    "cjs-types.cts",
  ]);
  run("tsc module=nodenext", [
    ...base,
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "esm-types.mts",
    "cjs-types.cts",
  ]);
  run("tsc moduleResolution=bundler", [
    ...base,
    "--module",
    "esnext",
    "--moduleResolution",
    "bundler",
    "bundler-types.ts",
    "esm-types.mts",
  ]);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
}

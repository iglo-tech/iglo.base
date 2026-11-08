// Checks the built package from the outside, the way a consumer uses it:
// `npm pack`, install the tarball into a temporary project, then
//   - import it as ESM with Node and with Bun,
//   - bun build of `import PocketBase from "iglo.base"`,
//   - type check ESM and bundler-style imports against the declarations (node16, nodenext, bundler),
//   - verify npm pack --dry-run contains no CJS/UMD files.
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
  // 1. Verify npm pack --dry-run contains no CJS/UMD files
  const packDry = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
    cwd: sdkRoot,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (packDry.exitCode !== 0) {
    throw new Error("npm pack --dry-run failed");
  }
  const dryPacked = JSON.parse(packDry.stdout.toString())[0] as {
    files: Array<{ path: string }>;
  };
  const dryFiles = dryPacked.files.map((f) => f.path);
  const badFiles = dryFiles.filter((f) => /\b(cjs|umd)\b/i.test(f) || /\.c[jt]s$/i.test(f));
  if (badFiles.length > 0) {
    throw new Error(`npm pack --dry-run contains CJS/UMD files: ${badFiles.join(", ")}`);
  }
  console.log(`ok   npm pack --dry-run contains no CJS/UMD files (${dryFiles.length} files)`);

  // 2. Build tarball
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

  // 3. Install in consumer project
  await writeFile(
    join(tmp, "package.json"),
    '{"name":"consumer","private":true,"type":"module","version":"0.0.0"}',
  );
  run("npm install tarball", [
    "npm",
    "install",
    "--no-audit",
    "--no-fund",
    join(tmp, packed.filename),
  ]);
  await cp(consumerSources, tmp, { recursive: true });

  // 4. Node ESM import and Bun import
  for (const runtime of ["node", "bun"]) {
    run(`${runtime} import (ESM)`, [runtime, "esm.mjs"]);
  }

  // 5. bun build of import PocketBase from "iglo.base"
  const buildResult = Bun.spawnSync(
    ["bun", "build", "bundle-entry.js", "--outfile", "bundle-out.js", "--target", "node"],
    { cwd: tmp, stdout: "pipe", stderr: "pipe" },
  );
  if (buildResult.exitCode !== 0) {
    failed = true;
    console.log(
      `FAIL bun build of import PocketBase from "iglo.base"\n${buildResult.stderr.toString()}`,
    );
  } else {
    const runNode = Bun.spawnSync(["node", "bundle-out.js"], {
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    const runBun = Bun.spawnSync(["bun", "bundle-out.js"], {
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (runNode.exitCode === 0 && runBun.exitCode === 0) {
      console.log(
        `ok   bun build of import PocketBase from "iglo.base": ${runNode.stdout.toString().trim()}`,
      );
    } else {
      failed = true;
      console.log(
        `FAIL run bundled output: node=${runNode.stderr.toString()} bun=${runBun.stderr.toString()}`,
      );
    }
  }

  // 6. Bundler build with the browser condition must fail at build time
  const browserBuild = Bun.spawnSync(
    [
      "bun",
      "build",
      "browser-ssr-entry.js",
      "--outfile",
      "browser-ssr-out.js",
      "--target",
      "browser",
    ],
    { cwd: tmp, stdout: "pipe", stderr: "pipe" },
  );
  if (browserBuild.exitCode !== 0) {
    console.log("ok   bundler build with browser condition failed as expected");
  } else {
    failed = true;
    console.log("FAIL bundler build with browser condition should have failed at build time");
  }

  // The browser subpath bundles for the browser target (it is the browser-safe entry)
  const browserSubpathBuild = Bun.spawnSync(
    [
      "bun",
      "build",
      "browser-entry.js",
      "--outfile",
      "browser-subpath-out.js",
      "--target",
      "browser",
    ],
    { cwd: tmp, stdout: "pipe", stderr: "pipe" },
  );
  if (browserSubpathBuild.exitCode === 0) {
    console.log("ok   bun build of iglo.base/ssr/browser with browser target succeeded");
  } else {
    failed = true;
    console.log(
      `FAIL bun build of iglo.base/ssr/browser with browser target: ${browserSubpathBuild.stderr.toString()}`,
    );
  }

  // Bundler build with node target for iglo.base/ssr must succeed
  const nodeSsrBuild = Bun.spawnSync(
    ["bun", "build", "browser-ssr-entry.js", "--outfile", "node-ssr-out.js", "--target", "node"],
    { cwd: tmp, stdout: "pipe", stderr: "pipe" },
  );
  if (nodeSsrBuild.exitCode === 0) {
    console.log("ok   bun build of iglo.base/ssr with node target succeeded");
  } else {
    failed = true;
    console.log(
      `FAIL bun build of iglo.base/ssr with node target: ${nodeSsrBuild.stderr.toString()}`,
    );
  }

  // 6. Type checks: tsc resolves declarations under node16, nodenext and bundler
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
  ]);
  run("tsc module=nodenext", [
    ...base,
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "esm-types.mts",
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

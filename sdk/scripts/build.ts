// Builds sdk/dist: the ES, CommonJS and browser (UMD-style) bundles, source maps and
// declaration files. Replaces js-sdk v0.28.1's rollup.config.mjs.
//
// 1. `tsc` emits ES2021 JavaScript (Bun.build does not lower syntax such as class fields)
//    and the declaration files.
// 2. The `@sdk/` alias is rewritten to relative `.js` specifiers in the declarations, so
//    consumers resolve them without any alias.
// 3. `Bun.build` bundles and minifies the emitted JavaScript.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const sdkRoot = join(import.meta.dirname, "..");
const dist = join(sdkRoot, "dist");
const jsDir = join(dist, ".js");
const typesDir = join(dist, "types");

await rm(dist, { recursive: true, force: true });

// 1. tsc
const tsc = Bun.spawnSync(
  [process.execPath, "x", "tsc", "-p", join(sdkRoot, "tsconfig.build.json")],
  { cwd: sdkRoot, stdout: "inherit", stderr: "inherit" },
);
if (tsc.exitCode !== 0) {
  throw new Error("tsc failed");
}

// 2. declarations without the @sdk/ alias
async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

const srcTypes = join(typesDir, "src");
for await (const file of walk(typesDir)) {
  if (!file.endsWith(".d.ts")) {
    continue;
  }
  const text = await readFile(file, "utf8");
  const rewritten = text.replace(
    /(from\s*|import\s*\(\s*)(["'])@sdk\/([^"']+)\2/g,
    (_m, pre, q, spec) => {
      let rel = relative(dirname(file), join(srcTypes, spec)).split("\\").join("/");
      if (!rel.startsWith(".")) {
        rel = "./" + rel;
      }
      return `${pre}${q}${rel}.js${q}`;
    },
  );
  if (rewritten.includes("@sdk/")) {
    throw new Error(`unresolved @sdk/ alias left in ${file}`);
  }
  if (rewritten !== text) {
    await writeFile(file, rewritten);
  }
}
// the entry helpers only exist to build the cjs and umd bundles
await rm(join(typesDir, "scripts"), { recursive: true, force: true });

await writeFile(
  join(dist, "cjs.d.cts"),
  [
    "// The CommonJS build is the client class itself (`module.exports = Client`).",
    "// The declarations are ES modules, so they are imported with resolution-mode `import`.",
    'type ClientModule = typeof import("./types/src/Client.js", { with: { "resolution-mode": "import" } });',
    'declare const Client: ClientModule["default"];',
    'type Client = InstanceType<ClientModule["default"]>;',
    "export = Client;",
    "",
  ].join("\n"),
);
await writeFile(
  join(dist, "umd.d.ts"),
  `import Client from "./types/src/Client.js";\nexport default Client;\n`,
);

// 3. bundles
await writeFile(
  join(jsDir, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { paths: { "@sdk/*": ["./src/*"] } } }),
);

const common = {
  target: "browser",
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "linked",
  tsconfig: join(jsDir, "tsconfig.json"),
  root: jsDir,
} as const;

async function bundle(entry: string, format: "esm" | "cjs" | "iife", name: string): Promise<void> {
  const out = await Bun.build({
    ...common,
    entrypoints: [join(jsDir, entry)],
    format,
    outdir: dist,
    naming: name,
  });
  if (!out.success) {
    throw new Error(`Bun.build ${name} failed:\n${out.logs.map(String).join("\n")}`);
  }
}

await bundle("src/index.js", "esm", "iglo-base.es.mjs");
await bundle("scripts/cjs-entry.js", "cjs", "iglo-base.cjs");
await bundle("scripts/umd-entry.js", "iife", "iglo-base.umd.js");

// React Native does not recognize the .mjs extension by default
// (js-sdk issue #47), so the ES bundle is also shipped as .js.
await cp(join(dist, "iglo-base.es.mjs"), join(dist, "iglo-base.es.js"));
await mkdir(dist, { recursive: true });
await cp(join(dist, "iglo-base.es.mjs.map"), join(dist, "iglo-base.es.js.map"));
const esJs = join(dist, "iglo-base.es.js");
await writeFile(
  esJs,
  (await readFile(esJs, "utf8")).replace("iglo-base.es.mjs.map", "iglo-base.es.js.map"),
);

await rm(jsDir, { recursive: true, force: true });

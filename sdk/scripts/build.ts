// Builds sdk/dist: the ESM bundle, source maps and declaration files.
// Replaces js-sdk v0.28.1's rollup.config.mjs.
//
// 1. `tsc` emits ES2021 JavaScript (Bun.build does not lower syntax such as class fields)
//    and the declaration files.
// 2. The `@sdk/` alias is rewritten to relative `.js` specifiers in the declarations, so
//    consumers resolve them without any alias.
// 3. `Bun.build` bundles and minifies the emitted JavaScript into ESM format.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// 3. ESM bundles
await writeFile(
  join(jsDir, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { paths: { "@sdk/*": ["./src/*"] } } }),
);

const out = await Bun.build({
  target: "browser",
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "linked",
  tsconfig: join(jsDir, "tsconfig.json"),
  root: jsDir,
  entrypoints: [join(jsDir, "src/index.js")],
  format: "esm",
  outdir: dist,
  naming: "iglo-base.es.mjs",
});
if (!out.success) {
  throw new Error(`Bun.build failed:\n${out.logs.map(String).join("\n")}`);
}

const ssrOut = await Bun.build({
  target: "node",
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "linked",
  tsconfig: join(jsDir, "tsconfig.json"),
  root: jsDir,
  entrypoints: [join(jsDir, "src/ssr/index.js")],
  format: "esm",
  outdir: dist,
  naming: "ssr.es.mjs",
  plugins: [
    {
      name: "external-iglo-base",
      setup(build) {
        build.onResolve(
          { filter: /^@sdk\/(Client|ClientResponseError|stores\/BaseAuthStore)$/ },
          () => ({ path: "./iglo-base.es.mjs", external: true }),
        );
      },
    },
  ],
});
if (!ssrOut.success) {
  throw new Error(`Bun.build (ssr) failed:\n${ssrOut.logs.map(String).join("\n")}`);
}

const ssrBrowserOut = await Bun.build({
  target: "browser",
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "linked",
  tsconfig: join(jsDir, "tsconfig.json"),
  root: jsDir,
  entrypoints: [join(jsDir, "src/ssr/browser.js")],
  format: "esm",
  outdir: dist,
  naming: "ssr-browser.es.mjs",
});
if (!ssrBrowserOut.success) {
  throw new Error(`Bun.build (ssr-browser) failed:\n${ssrBrowserOut.logs.map(String).join("\n")}`);
}

// the browser client (iglo.base/ssr/browser): the SDK classes come from the main entry, as above
const browserClientOut = await Bun.build({
  target: "browser",
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "linked",
  tsconfig: join(jsDir, "tsconfig.json"),
  root: jsDir,
  entrypoints: [join(jsDir, "src/ssr/browser-client.js")],
  format: "esm",
  outdir: dist,
  naming: "ssr-browser-client.es.mjs",
  plugins: [
    {
      name: "external-iglo-base",
      setup(build) {
        build.onResolve(
          { filter: /^@sdk\/(Client|ClientResponseError|stores\/BaseAuthStore)$/ },
          () => ({ path: "./iglo-base.es.mjs", external: true }),
        );
      },
    },
  ],
});
if (!browserClientOut.success) {
  throw new Error(
    `Bun.build (ssr-browser-client) failed:\n${browserClientOut.logs.map(String).join("\n")}`,
  );
}

// the framework adapters (iglo.base/ssr/next, /sveltekit, /nuxt, /astro, /react-router): each
// one is an edge-safe bundle of its own code. The core (`@sdk/ssr/index`) is external, so every
// adapter shares the one ssr.es.mjs with iglo.base/ssr, and the SDK classes come from the main
// entry as above.
for (const adapter of ["next", "sveltekit", "nuxt", "astro", "react-router"]) {
  const adapterOut = await Bun.build({
    target: "browser",
    minify: { whitespace: true, syntax: true, identifiers: false },
    sourcemap: "linked",
    tsconfig: join(jsDir, "tsconfig.json"),
    root: jsDir,
    entrypoints: [join(jsDir, `src/ssr/${adapter}.js`)],
    format: "esm",
    outdir: dist,
    naming: `ssr-${adapter}.es.mjs`,
    plugins: [
      {
        name: "external-iglo-base",
        setup(build) {
          build.onResolve(
            { filter: /^@sdk\/(Client|ClientResponseError|stores\/BaseAuthStore)$/ },
            () => ({ path: "./iglo-base.es.mjs", external: true }),
          );
          build.onResolve({ filter: /^@sdk\/ssr\/index$/ }, () => ({
            path: "./ssr.es.mjs",
            external: true,
          }));
        },
      },
    ],
  });
  if (!adapterOut.success) {
    throw new Error(
      `Bun.build (ssr-${adapter}) failed:\n${adapterOut.logs.map(String).join("\n")}`,
    );
  }
}

await rm(jsDir, { recursive: true, force: true });

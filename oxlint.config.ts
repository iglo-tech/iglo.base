import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

// `bun run lint` builds the SDK declarations (sdk/dist) before oxlint runs: the
// type-aware rules resolve @iglo.tech/iglo.base through sdk/package.json "types",
// so without them the rules misreport test code on a fresh checkout (L.1).

// No React or JSX in this project (owner, 2026-11-21): drop the React and
// jsx-a11y plugins, their rules, and the React-only rules of the nkzw preset
// (hooks and Relay).
const reactOnlyRules = new Set(["@nkzw/require-use-effect-arguments", "@nkzw/ensure-relay-types"]);
const isProjectRule = (name: string) =>
  !/^(react|jsx-a11y)\//.test(name) && !reactOnlyRules.has(name);
const keepProjectRules = <T>(rules: Record<string, T> | undefined) =>
  Object.fromEntries(Object.entries(rules ?? {}).filter(([name]) => isProjectRule(name)));
const preset = {
  ...cloudflare,
  plugins: cloudflare.plugins?.filter((plugin) => plugin !== "react" && plugin !== "jsx-a11y"),
  rules: keepProjectRules(cloudflare.rules),
  overrides: (cloudflare.overrides ?? []).map((override) => ({
    ...override,
    rules: keepProjectRules(override.rules),
  })),
};

// Test support files (harnesses, fixtures, scenario data) get the no-explicit-any
// relaxation the preset gives *.test.ts files. The preset's other test relaxations
// (non-null, unsafe flows, unbound methods, throws) stay on *.test.ts only: L.2 (D44)
// fixed their findings in these files, so they are not relaxed here.
const testSupportFiles = ["test/**/*.ts", "sdk/test/**/*.ts"];

export default defineConfig({
  ...preset,
  ignorePatterns: ["**/node_modules/**", "dist/**", "sdk/dist/**", "ui/**", "examples/**"],
  overrides: [
    ...preset.overrides,
    {
      files: testSupportFiles,
      rules: {
        "typescript/no-explicit-any": "off",
      },
    },
    {
      files: ["sdk/**"],
      rules: {
        eqeqeq: "off",
        "no-underscore-dangle": "off",
      },
    },
    // Off for the repo, each for a reason that the rewrite would break (L.1, D44):
    // - encoding names are data: MIME charsets ("utf-8", "UTF-8") and the charset switch
    //   in mediatype.ts; the rule rewrites them to "utf8", changing what is sent and compared;
    // - String.raw: Bun 1.4.5 lowers a raw template with non-ASCII text to \u escapes;
    // - \xNN is one byte in a Go literal g`...`, while \u00NN is a rune.
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      rules: {
        "unicorn/no-hex-escape": "off",
        "unicorn/prefer-string-raw": "off",
        "unicorn/text-encoding-identifier-case": "off",
      },
    },
    // Console output is allowed where it is the product: CLI tools, benchmarks,
    // probes and crash or fuzz reports (L.1). The SDK keeps upstream's
    // console.warn deprecation messages (behavior parity, D36). The counting proxy
    // prints its port on stdout, which its parent process reads.
    {
      files: [
        "scripts/**",
        "sdk/scripts/**",
        "sdk/src/**",
        "test/perf/**",
        "**/bench*.ts",
        "**/*-probe.ts",
        "test/differential/fuzz/**",
        "test/differential/roundtrip/large.ts",
        "test/differential/crash/**",
        "test/differential/scenarios.test.ts",
        "test/scenarios/scenarios.test.ts",
        "test/differential/sdk-ssr/counting-proxy.ts",
      ],
      rules: {
        "no-console": "off",
      },
    },
    // src/tools/html is a port of the x/net/html tree with its own Node class
    // (appendChild, no append): the DOM rule does not apply to it.
    {
      files: ["src/tools/html/**", "test/tools/html/**"],
      rules: {
        "unicorn/prefer-dom-node-append": "off",
      },
    },
    // The SDK targets ES2021 (sdk/tsconfig.json), which has no Object.hasOwn:
    // it keeps Object.prototype.hasOwnProperty.call (same result, L.1).
    // scripts/spikes/M0.8/bcrypt.ts runs a health probe next to a sign-in batch;
    // top-level await would serialize them, so its async IIFE stays.
    {
      files: ["sdk/**"],
      rules: {
        "prefer-object-has-own": "off",
      },
    },
    {
      files: ["scripts/spikes/M0.8/bcrypt.ts"],
      rules: {
        "unicorn/prefer-top-level-await": "off",
      },
    },
    // The SDK targets ES2021 (sdk/tsconfig.json): Array#at is not in its lib or in
    // older browsers, so the SDK keeps the index form (D36, L.1).
    {
      files: ["sdk/**"],
      rules: {
        "unicorn/prefer-at": "off",
      },
    },
    // SDK parity (D36): the SDK and its tests keep the instanceof operator as upstream
    // writes it. The isInstance helper walked the prototype chain itself and ignored
    // Symbol.hasInstance, which fetch-blob's Blob and File (the SDK README's polyfills for
    // Node < 17) use, so polyfilled values were detected differently (L.1).
    {
      files: ["sdk/src/**", "sdk/test/**"],
      rules: {
        "@nkzw/no-instanceof": "off",
      },
    },
    // L.1 open items (D44): these rules still report issues and stay off until
    // their task fixes them. L.4 owns no-unsafe-type-assertion. It is removed
    // from this list when its issues are fixed; the list is empty when L.4 is done.
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      rules: {
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
  ],
  rules: {
    ...preset.rules,
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["./*", "../*"],
            message: "Use the @/ path alias instead of a relative import (AGENTS.md).",
          },
        ],
      },
    ],
    "typescript/no-explicit-any": "error",
    eqeqeq: "error",
  },
});

import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

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

// Test support files (harnesses, fixtures, scenario data) get the same
// relaxations the preset gives *.test.ts files.
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
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
      },
    },
    {
      files: ["sdk/**"],
      rules: {
        eqeqeq: "off",
        "no-underscore-dangle": "off",
      },
    },
    // Go-port code writes bytes as \xNN (Go semantics): in a Go literal g`...` \xNN is
    // one byte and \u00NN is a rune, so the rewrite changes data. Off for the repo (L.1, D44).
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      rules: {
        "unicorn/no-hex-escape": "off",
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
    {
      files: ["sdk/test/**"],
      rules: {
        "typescript/no-explicit-any": "off",
      },
    },
    // L.1 open items: these rules still report issues and stay off until the
    // owner decides (PR body, "Open"). Each one is removed from this list when its
    // issues are fixed.
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      rules: {
        "quality/no-known-value-widening": "off",
        "quality/no-unknown-returns": "off",
        "quality/no-unsafe-dictionary-type": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/only-throw-error": "off",
        "typescript/unbound-method": "off",
      },
    },
  ],
  rules: {
    ...cloudflare.rules,
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

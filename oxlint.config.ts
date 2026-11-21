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
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/only-throw-error": "off",
        "typescript/unbound-method": "off",
      },
    },
    {
      files: ["sdk/**"],
      rules: {
        eqeqeq: "off",
        "no-underscore-dangle": "off",
      },
    },
    {
      files: ["sdk/test/**"],
      rules: {
        "typescript/no-explicit-any": "off",
      },
    },
    // L.1 migration: rules that still report issues. Each rule is removed from
    // this list by its own commit when its issues are fixed.
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      rules: {
        "@nkzw/no-instanceof": "off",
        curly: "off",
        "import/no-namespace": "off",
        "no-case-declarations": "off",
        "no-console": "off",
        "no-empty": "off",
        "no-promise-executor-return": "off",
        "no-prototype-builtins": "off",
        "no-regex-spaces": "off",
        "no-useless-assignment": "off",
        "no-var": "off",
        "object-shorthand": "off",
        "oxc/bad-bitwise-operator": "off",
        "prefer-arrow-callback": "off",
        "prefer-const": "off",
        "prefer-promise-reject-errors": "off",
        "promise/no-multiple-resolved": "off",
        "quality/no-array-filter-map": "off",
        "quality/no-chained-type-assertions": "off",
        "quality/no-conditional-empty-object-spread": "off",
        "quality/no-known-value-widening": "off",
        "quality/no-object-parameters": "off",
        "quality/no-reflect-get": "off",
        "quality/no-unknown-returns": "off",
        "quality/no-unknown-type-aliases": "off",
        "quality/no-unsafe-dictionary-type": "off",
        "typescript/await-thenable": "off",
        "typescript/no-array-delete": "off",
        "typescript/no-floating-promises": "off",
        "typescript/no-for-in-array": "off",
        "typescript/no-misused-promises": "off",
        "typescript/no-misused-spread": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-function-type": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/only-throw-error": "off",
        "typescript/require-array-sort-compare": "off",
        "typescript/switch-exhaustiveness-check": "off",
        "typescript/unbound-method": "off",
        "typescript/use-unknown-in-catch-callback-variable": "off",
        "unicorn/catch-error-name": "off",
        "unicorn/no-hex-escape": "off",
        "unicorn/no-typeof-undefined": "off",
        "unicorn/prefer-at": "off",
        "unicorn/prefer-dom-node-append": "off",
        "unicorn/prefer-native-coercion-functions": "off",
        "unicorn/prefer-number-properties": "off",
        "unicorn/prefer-set-has": "off",
        "unicorn/prefer-single-call": "off",
        "unicorn/prefer-string-raw": "off",
        "unicorn/prefer-string-replace-all": "off",
        "unicorn/prefer-string-slice": "off",
        "unicorn/prefer-structured-clone": "off",
        "unicorn/prefer-top-level-await": "off",
        "unicorn/text-encoding-identifier-case": "off",
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

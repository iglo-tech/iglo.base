// Removed extension flags and commands (docs/design/01-scope.md): each one
// exits non-zero with one message that names the scope document.

import { describe, expect, test } from "bun:test";

import { run } from "@test/support/executable";

const scope = "https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md";

function flagMessage(name: string): string {
  return `flag --${name} is not supported: iglo.base has no JavaScript hooks or user migrations. See ${scope}#removed-the-extension-surface`;
}

// log.Fatal output: "2006/01/02 15:04:05 <message>"
const logLine = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} (.*)$/;

async function expectSingleError(args: string[], message: string): Promise<void> {
  const result = await run(args);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  const lines = result.stderr.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(logLine);
  expect(logLine.exec(lines[0] ?? "")?.[1]).toBe(message);
  expect(message).toContain("docs/design/01-scope.md");
}

const removedFlags = [
  { name: "hooksDir", value: "./pb_hooks" },
  { name: "hooksWatch", value: "false" },
  { name: "hooksPool", value: "10" },
  { name: "migrationsDir", value: "./pb_migrations" },
  { name: "automigrate", value: "false" },
];

describe("removed flags", () => {
  for (const { name, value } of removedFlags) {
    const forms = [[`--${name}`], [`--${name}=${value}`], [`--${name}`, value]];
    for (const form of forms) {
      test(`${form.join(" ")} before serve`, async () => {
        await expectSingleError([...form, "serve"], flagMessage(name));
      });
      test(`${form.join(" ")} after serve`, async () => {
        await expectSingleError(["serve", ...form], flagMessage(name));
      });
      test(`${form.join(" ")} without a command`, async () => {
        await expectSingleError(form, flagMessage(name));
      });
    }
  }

  test("after -- it is a positional argument, not a flag", async () => {
    const result = await run(["--", "--hooksDir"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("removed commands", () => {
  const update = `command "update" is not supported: iglo.base does not replace its own executable; deploy a new release instead. See ${scope}#removed-the-update-command`;
  const migrate = `command "migrate" is not supported: iglo.base has no user migrations; system migrations run automatically at startup. See ${scope}#removed-the-extension-surface`;

  for (const args of [
    ["update"],
    ["update", "--dev"],
    ["--dir", "x", "update"],
    ["update", "--help"],
  ]) {
    test(args.join(" "), async () => {
      await expectSingleError(args, update);
    });
  }

  for (const args of [["migrate"], ["migrate", "up"], ["migrate", "create", "x"]]) {
    test(args.join(" "), async () => {
      await expectSingleError(args, migrate);
    });
  }
});

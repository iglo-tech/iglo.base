// Upstream: pocketbase.go and cmd/serve.go, with cobra/pflag's command
// lookup, help, version and flag errors.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { run, startServer, tempDir } from "@test/support/executable";

const logLine = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /;

async function expectError(args: string[], message: string): Promise<void> {
  const result = await run(args);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(logLine);
  expect(result.stderr.replace(logLine, "")).toBe(`${message}\n`);
}

describe("root command", () => {
  test("without arguments prints help", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("iglo-base CLI\n\nUsage:\n  iglo-base [command]\n");
    expect(result.stdout).toContain("\n  serve       Starts the web server");
    expect(result.stdout).not.toContain("hooks");
    expect(result.stdout).not.toContain("migrat");
    expect(result.stderr).toBe("");
  });

  for (const flag of ["--help", "-h"]) {
    test(`${flag} prints help`, async () => {
      const result = await run([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toStartWith("iglo-base CLI\n");
    });
  }

  for (const flag of ["--version", "-v"]) {
    test(`${flag} prints the version`, async () => {
      const result = await run([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("iglo-base version (untracked)\n");
    });
  }

  test("unknown flags are ignored on the root command", async () => {
    const result = await run(["--unknown", "value"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("iglo-base CLI\n");
  });

  test("help shows the data directory next to the executable", async () => {
    const result = await run(["--help"]);
    expect(result.stdout).toMatch(
      /--dir string +the PocketBase data directory \(default ".*\/pb_data"\)/,
    );
  });

  test("unknown command", async () => {
    await expectError(["foo"], 'unknown command "foo" for "iglo-base"');
  });

  test("unknown command with a suggestion", async () => {
    await expectError(
      ["serv"],
      'unknown command "serv" for "iglo-base"\n\nDid you mean this?\n\tserve',
    );
  });

  test("the help command is hidden and unknown", async () => {
    await expectError(["help"], 'unknown command "help" for "iglo-base"');
  });

  test("invalid --queryTimeout prints usage and the error", async () => {
    const result = await run(["--queryTimeout", "abc"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("Usage:\n  iglo-base [command]\n");
    expect(result.stderr).toContain(
      'invalid argument "abc" for "--queryTimeout" flag: strconv.ParseInt: parsing "abc": invalid syntax\n',
    );
  });
});

describe("serve command", () => {
  test("--help", async () => {
    const result = await run(["serve", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith(
      "Starts the web server (default to 127.0.0.1:8090 if no domain is specified)\n\nUsage:\n  iglo-base serve [domain(s)] [flags]\n",
    );
    expect(result.stdout).toContain("--origins strings");
    expect(result.stdout).toContain("Global Flags:");
  });

  test("unknown flag", async () => {
    await expectError(["serve", "--unknown"], "unknown flag: --unknown");
  });

  test("--version is a root flag only", async () => {
    await expectError(["serve", "--version"], "unknown flag: --version");
  });

  test("missing flag value", async () => {
    await expectError(["serve", "--http"], "flag needs an argument: --http");
  });

  test("invalid bool value", async () => {
    await expectError(
      ["serve", "--dev=maybe"],
      'invalid argument "maybe" for "--dev" flag: strconv.ParseBool: parsing "maybe": invalid syntax',
    );
  });

  test("address without a port", async () => {
    await expectError(
      ["serve", "--http", "127.0.0.1", "--dir", join(tempDir(), "pb_data")],
      "listen tcp: address 127.0.0.1: missing port in address",
    );
  });

  const https =
    "HTTPS is not implemented yet: --https and domain arguments are not supported in this build";

  test("--https is parsed but not served yet", async () => {
    await expectError(
      ["serve", "--https", "127.0.0.1:0", "--dir", join(tempDir(), "pb_data")],
      https,
    );
  });

  test("domain arguments default to HTTPS", async () => {
    await expectError(["serve", "example.com", "--dir", join(tempDir(), "pb_data")], https);
  });

  test("persistent flags before the command, value forms, string slices", async () => {
    const dataDir = join(tempDir(), "pb_data");
    const server = await startServer(
      [
        "--dev=false",
        "--queryTimeout=0x10",
        "--origins",
        "https://a.test,https://b.test",
        "--origins=https://c.test",
      ],
      dataDir,
    );
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    const result = await server.stop();
    expect(result.exitCode).toBe(0);
  });

  test("prints the start banner and exits cleanly on SIGTERM", async () => {
    const server = await startServer([], join(tempDir(), "pb_data"));
    const result = await server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(
        `^\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2} Server started at ${server.url}\\n> REST API:  ${server.url}/api/\\n$`,
      ),
    );
    expect(result.stderr).toBe("");
  });
});

describe("pb_hooks and pb_migrations warning", () => {
  const cases: [string, string[]][] = [
    ["neither exists", []],
    ["pb_hooks exists", ["pb_hooks"]],
    ["pb_migrations exists", ["pb_migrations"]],
    ["both exist", ["pb_hooks", "pb_migrations"]],
  ];
  for (const [name, dirs] of cases) {
    test(name, async () => {
      const root = tempDir();
      for (const dir of dirs) {
        mkdirSync(join(root, dir));
      }
      const server = await startServer([], join(root, "pb_data"));
      const result = await server.stop();
      const warnings = result.stderr.split("\n").filter((line) => line.includes("WARN"));
      if (dirs.length === 0) {
        expect(result.stderr).toBe("");
        return;
      }
      expect(warnings).toHaveLength(1);
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
      for (const dir of dirs) {
        expect(warnings[0]).toContain(join(root, dir));
      }
      expect(warnings[0]).toContain("docs/design/01-scope.md");
    });
  }
});

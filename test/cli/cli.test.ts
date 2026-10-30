// Upstream: pocketbase.go and cmd/serve.go, with cobra/pflag's command
// lookup, help, version and flag errors.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { freePort, run, startServer, tempDir } from "@test/support/executable";

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
    expect(result.stdout).toContain("\n  migrate     Executes app DB migration scripts");
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

describe("flag values parsed as pflag does", () => {
  for (const value of ["1_000", "0x_1F", "0b1_0", "0_7", "-1_0"]) {
    test(`--queryTimeout=${value} is accepted`, async () => {
      const result = await run(["serve", `--queryTimeout=${value}`, "--help"]);
      expect(result.exitCode).toBe(0);
    });
  }

  for (const value of ["1__0", "1_", "_1", "0x", "08", "1e3"]) {
    test(`--queryTimeout=${value} is invalid syntax`, async () => {
      const result = await run(["serve", `--queryTimeout=${value}`, "--help"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `strconv.ParseInt: parsing ${JSON.stringify(value)}: invalid syntax`,
      );
    });
  }

  test("--queryTimeout out of int64 range", async () => {
    const result = await run(["serve", "--queryTimeout=9223372036854775808", "--help"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'strconv.ParseInt: parsing "9223372036854775808": value out of range',
    );
  });

  for (const value of [
    '"https://a.test"\r\n',
    "https://a.test\n",
    '\n"https://a.test",b\nc',
    '"a\nb"',
  ]) {
    test(`--origins ${JSON.stringify(value)} is a valid CSV record`, async () => {
      const result = await run(["serve", "--origins", value, "--help"]);
      expect(result.exitCode).toBe(0);
    });
  }

  for (const value of ['"a"b', 'a"b', '"a']) {
    test(`--origins ${JSON.stringify(value)} is invalid CSV`, async () => {
      const result = await run(["serve", "--origins", value, "--help"]);
      expect(result.exitCode).toBe(1);
    });
  }

  test("--origins with only newlines has no record", async () => {
    const result = await run(["serve", "--origins", "\r\n\n", "--help"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("flag: EOF");
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

  test("a signed numeric port is a port, as Go's parsePort", async () => {
    const port = await freePort();
    const server = await startServer([], join(tempDir(), "pb_data"), "127.0.0.1", {
      name: `+${port}`,
      urlPort: port,
    });
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    const result = await server.stop();
    expect(result.exitCode).toBe(0);
  });

  for (const port of ["-1", "65536", "+99999"]) {
    test(`port ${port} is invalid`, async () => {
      await expectError(
        ["serve", "--http", `127.0.0.1:${port}`, "--dir", join(tempDir(), "pb_data")],
        `listen tcp: address ${port}: invalid port`,
      );
    });
  }

  test("an unknown service name as port fails", async () => {
    await expectError(
      ["serve", "--http", "127.0.0.1:no-such-service", "--dir", join(tempDir(), "pb_data")],
      "listen tcp: lookup tcp/no-such-service: unknown port",
    );
  });

  // Go resolves service names through /etc/services (http-alt is 8080 there)
  const hasHttpAlt = (() => {
    try {
      return /^http-alt\s+8080\/tcp/m.test(readFileSync("/etc/services", "utf8"));
    } catch {
      return false;
    }
  })();
  test.skipIf(!hasHttpAlt)("a service name from /etc/services as port", async () => {
    const server = await startServer([], join(tempDir(), "pb_data"), "127.0.0.1", {
      name: "HTTP-ALT",
      urlPort: 8080,
    });
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    const result = await server.stop();
    expect(result.exitCode).toBe(0);
  });

  test("prints the start banner and exits cleanly on SIGTERM", async () => {
    const server = await startServer([], join(tempDir(), "pb_data"));
    // a fresh pb_data: the installer prints its link after the banner
    await server.waitForOutput("superuser upsert EMAIL PASS)");
    const result = await server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(
        `^\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2} Server started at ${server.url}\\n> Dashboard: ${server.url}/_/\\n> REST API:  ${server.url}/api/\\n\\n\\(!\\) Launch the URL below`,
      ),
    );
    expect(result.stderr).toBe("");
  });
});

describe("pb_hooks warning", () => {
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
      if (!dirs.includes("pb_hooks")) {
        expect(result.stderr).toBe("");
        return;
      }
      expect(warnings).toHaveLength(1);
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(warnings[0]).toContain(join(root, "pb_hooks"));
      expect(warnings[0]).not.toContain("pb_migrations");
      expect(warnings[0]).toContain("docs/design/01-scope.md");
    });
  }
});

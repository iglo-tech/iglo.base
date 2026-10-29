// Upstream: cmd/superuser_test.go, as CLI tests through the compiled
// executable on copies of the fixture: exit codes and output, and the
// pb_data effects read back through the HTTP API.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { run, startServer, tempDir } from "@test/support/executable";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

const logLine = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /;

function fixtureCopy(): string {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

async function superuser(
  dataDir: string,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; error: string }> {
  const result = await run(["--dir", dataDir, "superuser", ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    error: result.stderr.replace(logLine, "").trimEnd(),
  };
}

// a superuser token from auth-with-password on a running server
async function login(url: string, email: string, password: string): Promise<string | undefined> {
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  return res.ok ? ((await res.json()) as { token: string }).token : undefined;
}

async function withServer<T>(dataDir: string, fn: (url: string) => Promise<T>): Promise<T> {
  const server = await startServer([], dataDir);
  try {
    return await fn(server.url);
  } finally {
    await server.stop();
  }
}

describe("superuser", () => {
  test("without a subcommand prints help", async () => {
    const result = await superuser(fixtureCopy());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith(
      "Manage superusers\n\nUsage:\n  iglo-base superuser [command]\n\nAvailable Commands:\n  create      Creates a new superuser\n  delete      Deletes an existing superuser\n  ips  ",
    );
    expect(result.stdout).toEndWith(
      '\nUse "iglo-base superuser [command] --help" for more information about a command.\n',
    );
  });

  test("subcommand help has the example", async () => {
    const result = await superuser(fixtureCopy(), "upsert", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith(
      "Creates, or updates if email exists, a single superuser\n\nUsage:\n  iglo-base superuser upsert [flags]\n\nExamples:\nsuperuser upsert test@example.com 1234567890\n\nFlags:\n  -h, --help   help for upsert\n",
    );
  });

  test("a flag error of superuser prints the usage", async () => {
    const result = await run(["--dir", fixtureCopy(), "superuser", "--bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("Usage:\n  iglo-base superuser [command]\n");
    expect(result.stderr).toMatch(/\n\n\d{4}\/\d{2}\/\d{2} [\d:]{8} unknown flag: --bogus\n$/);
  });

  test("a flag error of a subcommand has no usage", async () => {
    const result = await superuser(fixtureCopy(), "upsert", "--bogus");
    expect(result).toEqual({ exitCode: 1, stdout: "", error: "unknown flag: --bogus" });
  });
});

describe("superuser upsert", () => {
  const dataDir = fixtureCopy();
  const scenarios: [string, string, string, string | undefined][] = [
    ["empty email and password", "", "", "missing or invalid email address"],
    ["empty email", "", "1234567890", "missing or invalid email address"],
    ["invalid email", "invalid", "1234567890", "missing or invalid email address"],
    [
      "empty password",
      "test@example.com",
      "",
      "failed to upsert superuser account: password: cannot be blank.",
    ],
    [
      "short password",
      "test_new@example.com",
      "1234567",
      "failed to upsert superuser account: password: Must be at least 8 character(s).",
    ],
    ["existing user", "test@example.com", "1234567890!", undefined],
    ["new user", "test_new@example.com", "1234567890!", undefined],
  ];
  for (const [name, email, password, error] of scenarios) {
    test(name, async () => {
      const result = await superuser(dataDir, "upsert", email, password);
      if (error) {
        expect(result).toEqual({ exitCode: 1, stdout: "", error });
      } else {
        expect(result).toEqual({
          exitCode: 0,
          stdout: `Successfully saved superuser "${email}"!\n`,
          error: "",
        });
      }
    });
  }

  test("missing arguments", async () => {
    for (const args of [[], ["a"], ["a@example.com", "1234567890", "extra"]]) {
      const result = await superuser(dataDir, "upsert", ...args);
      expect(result).toEqual({
        exitCode: 1,
        stdout: "",
        error: "missing email and password arguments",
      });
    }
  });

  test("the saved passwords work", async () => {
    await withServer(dataDir, async (url) => {
      expect(await login(url, "test@example.com", "1234567890!")).toBeString();
      expect(await login(url, "test_new@example.com", "1234567890!")).toBeString();
      expect(await login(url, "test@example.com", "1234567890")).toBeUndefined();
    });
  });
});

describe("superuser create", () => {
  const dataDir = fixtureCopy();
  const scenarios: [string, string, string, string | undefined][] = [
    ["empty email", "", "1234567890", "missing or invalid email address"],
    ["invalid email", "invalid", "1234567890", "missing or invalid email address"],
    [
      "empty password",
      "test_new@example.com",
      "",
      "failed to create new superuser account: password: cannot be blank.",
    ],
    [
      "short password",
      "test_new@example.com",
      "1234567",
      "failed to create new superuser account: password: Must be at least 8 character(s).",
    ],
    [
      "existing email",
      "test@example.com",
      "1234567890!",
      "failed to create new superuser account: email: Value must be unique.",
    ],
    ["new email", "test_new@example.com", "1234567890!", undefined],
  ];
  for (const [name, email, password, error] of scenarios) {
    test(name, async () => {
      const result = await superuser(dataDir, "create", email, password);
      if (error) {
        expect(result).toEqual({ exitCode: 1, stdout: "", error });
      } else {
        expect(result).toEqual({
          exitCode: 0,
          stdout: `Successfully created new superuser "${email}"!\n`,
          error: "",
        });
      }
    });
  }

  test("the new superuser can log in", async () => {
    await withServer(dataDir, async (url) => {
      expect(await login(url, "test_new@example.com", "1234567890!")).toBeString();
    });
  });
});

describe("superuser update", () => {
  const dataDir = fixtureCopy();
  const scenarios: [string, string, string, string | undefined][] = [
    ["empty email", "", "1234567890", "missing or invalid email address"],
    ["invalid email", "invalid", "1234567890", "missing or invalid email address"],
    [
      "nonexisting superuser",
      "test_missing@example.com",
      "1234567890",
      'superuser with email "test_missing@example.com" doesn\'t exist',
    ],
    [
      "empty password",
      "test@example.com",
      "",
      'failed to change superuser "test@example.com" password: password: cannot be blank.',
    ],
    [
      "short password",
      "test@example.com",
      "1234567",
      'failed to change superuser "test@example.com" password: password: Must be at least 8 character(s).',
    ],
    ["valid password", "test@example.com", "12345678", undefined],
  ];
  for (const [name, email, password, error] of scenarios) {
    test(name, async () => {
      const result = await superuser(dataDir, "update", email, password);
      if (error) {
        expect(result).toEqual({ exitCode: 1, stdout: "", error });
      } else {
        expect(result).toEqual({
          exitCode: 0,
          stdout: `Successfully changed superuser "${email}" password!\n`,
          error: "",
        });
      }
    });
  }

  test("the new password works", async () => {
    await withServer(dataDir, async (url) => {
      expect(await login(url, "test@example.com", "12345678")).toBeString();
    });
  });
});

describe("superuser delete", () => {
  const dataDir = fixtureCopy();

  test("empty or invalid email", async () => {
    for (const args of [[], [""], ["invalid"]]) {
      const result = await superuser(dataDir, "delete", ...args);
      expect(result).toEqual({
        exitCode: 1,
        stdout: "",
        error: "invalid or missing email address",
      });
    }
  });

  test("nonexisting superuser", async () => {
    const result = await superuser(dataDir, "delete", "test_missing@example.com");
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'superuser "test_missing@example.com" is missing or already deleted\n',
      error: "",
    });
  });

  test("existing superuser", async () => {
    const result = await superuser(dataDir, "delete", "test2@example.com");
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'Successfully deleted superuser "test2@example.com"!\n',
      error: "",
    });
    const again = await superuser(dataDir, "delete", "test2@example.com");
    expect(again.stdout).toBe('superuser "test2@example.com" is missing or already deleted\n');
  });
});

describe("superuser otp", () => {
  const dataDir = fixtureCopy();

  test("empty or invalid email", async () => {
    for (const args of [[], ["invalid"]]) {
      const result = await superuser(dataDir, "otp", ...args);
      expect(result).toEqual({
        exitCode: 1,
        stdout: "",
        error: "invalid or missing email address",
      });
    }
  });

  test("nonexisting superuser", async () => {
    const result = await superuser(dataDir, "otp", "test_missing@example.com");
    expect(result.error).toBe('superuser with email "test_missing@example.com" doesn\'t exist');
  });

  test("disabled OTP", async () => {
    const result = await superuser(dataDir, "otp", "test@example.com");
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      error: "OTP auth is not enabled for the _superusers collection",
    });
  });

  test("enabled OTP creates one", async () => {
    await withServer(dataDir, async (url) => {
      const token = (await login(url, "test@example.com", "1234567890")) ?? "";
      const res = await fetch(`${url}/api/collections/_superusers`, {
        method: "PATCH",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ otp: { enabled: true, length: 6, duration: 120 } }),
      });
      expect(res.status).toBe(200);
    });

    const result = await superuser(dataDir, "otp", "test@example.com");
    expect(result.exitCode).toBe(0);
    expect(result.error).toBe("");
    const match =
      /^Successfully created OTP for superuser "test@example.com":\n├─ Id:    (\w{15})\n├─ Pass:  (\d{6})\n└─ Valid: 120s\n\n$/.exec(
        result.stdout,
      );
    expect(match).not.toBeNull();

    await withServer(dataDir, async (url) => {
      const token = (await login(url, "test@example.com", "1234567890")) ?? "";
      const res = await fetch(`${url}/api/collections/_otps/records/${match?.[1]}`, {
        headers: { Authorization: token },
      });
      expect(res.status).toBe(200);
      const otp = (await res.json()) as Record<string, unknown>;
      expect(otp.collectionRef).toBe("pbc_3142635823");
      expect(otp.recordRef).toBe("sywbhecnh46rhm0");
      expect(otp.password).toBe("");
    });
  });
});

describe("superuser ips", () => {
  const dataDir = fixtureCopy();

  async function superuserIPs(): Promise<unknown> {
    return withServer(dataDir, async (url) => {
      const token = (await login(url, "test@example.com", "1234567890")) ?? "";
      const res = await fetch(`${url}/api/settings`, { headers: { Authorization: token } });
      return ((await res.json()) as { superuserIPs: unknown }).superuserIPs;
    });
  }

  test("invalid ips", async () => {
    const result = await superuser(dataDir, "ips", "127.0.0.1", "invalid");
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      error: "superuserIPs: (1: invalid IP or CIDR subnet.).",
    });
  });

  test("valid ips", async () => {
    const result = await superuser(dataDir, "ips", "127.0.0.1", "::1", "127.0.0.1/24");
    expect(result).toEqual({
      exitCode: 0,
      stdout: "Successfully updated SuperuserIPs setting:\n├─ 127.0.0.1\n├─ ::1\n└─ 127.0.0.1/24\n",
      error: "",
    });
    expect(await superuserIPs()).toEqual(["127.0.0.1", "::1", "127.0.0.1/24"]);
  });

  test("no ips clears the setting", async () => {
    const result = await superuser(dataDir, "ips");
    expect(result).toEqual({
      exitCode: 0,
      stdout: "Successfully cleared SuperuserIPs setting!\n",
      error: "",
    });
    expect(await superuserIPs()).toEqual([]);
  });
});

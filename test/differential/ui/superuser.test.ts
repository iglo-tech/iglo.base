// Differential case for the superuser command (cmd/superuser.go): the same
// command sequence with the reference PocketBase v0.41.0 binary and the
// compiled iglo.base executable, each on its own copy of the fixture. The
// output and exit codes match, and both pb_data directories, opened by
// upstream afterwards, have the same superusers and settings. Not part of
// `bun test`: run `bun run test:reference`.
//
// Normalized: the binary name, the log time and the --dir/--publicDir
// defaults (next to each binary). Marked difference: the help's global
// flags have no --automigrate, --hooksDir, --hooksPool, --hooksWatch and
// --migrationsDir (docs/design/01-scope.md, removed flags).

import { expect, test } from "bun:test";
import { join } from "node:path";

import { executable, tempDir } from "@test/support/executable";
import { defaultLayout, requireTool } from "@test/support/reference-tools";
import { startUpstream } from "@test/support/upstream";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

const sequence: string[][] = [
  [],
  ["--help"],
  ["bogus"],
  ["--bogus"],
  ["upsert"],
  ["upsert", "a"],
  ["upsert", "invalid", "1234567890"],
  ["upsert", "test@example.com", ""],
  ["upsert", "new@example.com", "1234567"],
  ["upsert", "test@example.com", "1234567890!"],
  ["upsert", "test_new@example.com", "1234567890!"],
  ["upsert", "--bogus"],
  ["upsert", "-x", "a", "b"],
  ["upsert", "--help"],
  ["create", "test_new@example.com", "1234567890!"],
  ["create", "test2@example.com", "1234567890!"],
  ["create", "created@example.com", "1234567890!"],
  ["create", "a", "b", "c"],
  ["update", "missing@example.com", "1234567890!"],
  ["update", "test@example.com", "123"],
  ["update", "test3@example.com", "1234567890x"],
  ["delete"],
  ["delete", "invalid"],
  ["delete", "missing@example.com"],
  ["delete", "test2@example.com"],
  ["delete", "test4@example.com", "extra"],
  ["otp"],
  ["otp", "missing@example.com"],
  ["otp", "test@example.com"],
  ["ips", "127.0.0.1", "invalid"],
  ["ips", "127.0.0.1", "::1", "127.0.0.1/24"],
  ["ips", "--help"],
];

const removedFlagLine = /^ {6}--(automigrate|hooksDir|hooksPool|hooksWatch|migrationsDir) .*\n/gm;

function normalize(text: string, bin: string): string {
  return text
    .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /gm, "TIME ")
    .replace(removedFlagLine, "")
    .replace(/(--(dir|publicDir) string +.*\(default )".*"\)/g, '$1"DEFAULT")')
    .replaceAll(`${bin} superuser`, "BIN superuser");
}

async function runAll(
  binary: string,
  bin: string,
  dataDir: string,
): Promise<{ args: string[]; exitCode: number; stdout: string; stderr: string }[]> {
  const results = [];
  for (const args of sequence) {
    const proc = Bun.spawn([binary, "--dir", dataDir, "superuser", ...args], {
      cwd: tempDir(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    results.push({
      args,
      exitCode,
      stdout: normalize(stdout, bin),
      stderr: normalize(stderr, bin),
    });
  }
  return results;
}

// the superusers and the superuser IPs of a pb_data, read by upstream
async function state(dataDir: string): Promise<unknown> {
  const server = await startUpstream({ dataDir });
  try {
    const logins: Record<string, boolean> = {};
    let token = "";
    for (const [email, password] of [
      ["test@example.com", "1234567890!"],
      ["test_new@example.com", "1234567890!"],
      ["created@example.com", "1234567890!"],
      ["test3@example.com", "1234567890x"],
      ["test3@example.com", "1234567890"],
    ] as const) {
      const res = await fetch(`${server.url}/api/collections/_superusers/auth-with-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: email, password }),
      });
      logins[`${email} ${password}`] = res.ok;
      if (res.ok && token === "") {
        token = ((await res.json()) as { token: string }).token;
      }
    }
    const list = await fetch(
      `${server.url}/api/collections/_superusers/records?fields=email&sort=email`,
      { headers: { Authorization: token } },
    );
    const settings = await fetch(`${server.url}/api/settings`, {
      headers: { Authorization: token },
    });
    return {
      logins,
      superusers: ((await list.json()) as { items: unknown[] }).items,
      superuserIPs: ((await settings.json()) as { superuserIPs: unknown }).superuserIPs,
    };
  } finally {
    await server.stop();
  }
}

test("superuser command sequence", async () => {
  const upstreamDir = join(tempDir(), "pb_data");
  const igloDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, upstreamDir);
  copyDataDir(fixtureDir, igloDir);

  const [want, got] = await Promise.all([
    runAll(requireTool("pocketbase", defaultLayout), "pocketbase", upstreamDir),
    runAll(await executable(), "iglo-base", igloDir),
  ]);
  for (let i = 0; i < want.length; i++) {
    expect(got[i]).toEqual(want[i] as (typeof got)[number]);
  }

  expect(await state(igloDir)).toEqual(await state(upstreamDir));
}, 120_000);

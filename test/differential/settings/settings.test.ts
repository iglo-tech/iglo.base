// The settings model and Settings API (src/settings, src/apis/settings.ts,
// src/middlewares/superuser-ips-whitelist.ts) against the reference
// PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
//   - Cases (cases.ts): every request goes to both servers in the same
//     order, each on its own copy of upstream's fixture; the responses are
//     compared as the scenario harness compares them, and after every case
//     the stored settings row must be the same: the value's SQLite type and
//     bytes (key order, escaping, number text), and the `updated` format.
//     After a GET case, the masked GET body is what "@GET" PATCH sends.
//   - Round trips: settings written through PATCH /api/settings by one
//     server are read back by the other (GET equal to the writer's, the
//     stored row untouched by the reader's start, the superuser IP
//     whitelist applied), plain and encrypted (--encryptionEnv with a key
//     generated here).
//   - Startup: encrypted settings with a missing or wrong key, and a key of
//     the wrong size, fail both servers with the same message and exit
//     code; plain settings load with a key set.
//   - Stored shapes: the fixture's row (a v0.40.x-era value without
//     logs.maxDataSize, empty `created`) and a row with unknown keys load
//     the same in both; the next save writes the same bytes (unknown keys
//     dropped, missing ones added).

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareResponses, Pairing, readStartingData } from "@test/differential/harness/compare";
import {
  accessCases,
  type Identity,
  mergeCases,
  secretCases,
  type SettingsCase,
  validationCases,
  whitelistCases,
} from "@test/differential/settings/cases";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import { send } from "@test/scenarios/runner";
import type { ScenarioResponse } from "@test/scenarios/request";
import type { Scenario } from "@test/scenarios/scenario";
import { changeSettings } from "@test/scenarios/settings-prepare";
import { executable, startServer } from "@test/support/executable";
import { requireTool, defaultLayout } from "@test/support/reference-tools";
import { startUpstream } from "@test/support/upstream";
import { randomString } from "@/tools/security/random";

// starting and stopping the servers is slow on some runners
const timeout = 120_000;

const encryptionEnv = "IGLO_TEST_SETTINGS_KEY";

interface Server {
  url: string;
  stop(): Promise<unknown>;
}

const roots: string[] = [];
const running = new Set<Server>();

afterAll(async () => {
  await Promise.allSettled([...running].map((s) => s.stop()));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-settings-"));
  roots.push(root);
  return root;
}

// a fixture copy (optionally changed) in a new root
function fixtureCopy(change?: (dataDir: string) => void): string {
  const dataDir = join(newRoot(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  change?.(dataDir);
  return dataDir;
}

function copyOf(dataDir: string): string {
  const copy = join(newRoot(), "pb_data");
  copyDataDir(dataDir, copy);
  return copy;
}

async function track<T extends Server>(server: Promise<T>): Promise<T> {
  const s = await server;
  running.add(s);
  return s;
}

async function stop(server: Server): Promise<void> {
  running.delete(server);
  await server.stop();
}

function startUp(dataDir: string, key?: string): Promise<Server> {
  return track(
    startUpstream({
      dataDir,
      args: key === undefined ? [] : ["--encryptionEnv", encryptionEnv],
      env: key === undefined ? {} : { [encryptionEnv]: key },
    }),
  );
}

function startIglo(dataDir: string, key?: string): Promise<Server> {
  return track(
    startServer(
      key === undefined ? [] : ["--encryptionEnv", encryptionEnv],
      dataDir,
      "127.0.0.1",
      undefined,
      key === undefined ? {} : { [encryptionEnv]: key },
    ),
  );
}

const tokens: Record<Identity, string> = {
  guest: "",
  users: usersToken,
  superuser: superuserToken,
};

function request(c: SettingsCase, body?: string): Scenario {
  const headers: Record<string, string> = { ...c.headers };
  if (tokens[c.as] !== "") {
    headers["Authorization"] = tokens[c.as];
  }
  return {
    name: c.name,
    method: c.method,
    url: c.url,
    headers,
    body: body ?? c.body,
    expectedStatus: 0,
  };
}

async function sendTo(url: string, req: Scenario): Promise<ScenarioResponse> {
  const res = await send(url, req);
  if ("error" in res) {
    throw new Error(`${req.name}: ${res.error}`);
  }
  return res;
}

function text(res: ScenarioResponse): string {
  return new TextDecoder().decode(res.body);
}

interface StoredRow {
  type: string;
  value: string;
  created: string;
  updated: string;
}

// the stored settings row of a pb_data (the server may still run on it)
function storedRow(dataDir: string): StoredRow | null {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    const row = db
      .query(
        "SELECT typeof(value) AS type, CAST(value AS TEXT) AS value, created, updated FROM _params WHERE id = 'settings'",
      )
      .get() as StoredRow | null;
    return row;
  } finally {
    db.close();
  }
}

const dateFormat = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z$/;

// the differences between two stored rows: type and value exactly (plain
// values), the formats of the timestamps
function rowDifferences(up: StoredRow | null, ig: StoredRow | null, encrypted: boolean): string[] {
  if (up === null || ig === null) {
    return up === ig
      ? []
      : [
          `stored row: upstream ${up === null ? "none" : "one"}, iglo.base ${ig === null ? "none" : "one"}`,
        ];
  }
  const differences: string[] = [];
  if (up.type !== ig.type) {
    differences.push(`stored type: upstream ${up.type}, iglo.base ${ig.type}`);
  }
  if (!encrypted && up.value !== ig.value) {
    differences.push(`stored value:\n  upstream  ${up.value}\n  iglo.base ${ig.value}`);
  }
  for (const [name, a, b] of [
    ["created", up.created, ig.created],
    ["updated", up.updated, ig.updated],
  ] as const) {
    if ((a === "") !== (b === "") || (a !== "" && !dateFormat.test(b))) {
      differences.push(`stored ${name}: upstream ${a}, iglo.base ${b}`);
    }
  }
  return differences;
}

interface Pair {
  upstreamDir: string;
  igloDir: string;
  upstream: Server;
  iglo: Server;
}

async function startPair(sourceDir: string, key?: string): Promise<Pair> {
  const upstreamDir = copyOf(sourceDir);
  const igloDir = copyOf(sourceDir);
  const [upstream, iglo] = await Promise.all([startUp(upstreamDir, key), startIglo(igloDir, key)]);
  return { upstreamDir, igloDir, upstream, iglo };
}

// Runs the cases in order on a pair; returns every difference.
async function runCases(pair: Pair, cases: SettingsCase[], encrypted = false): Promise<string[]> {
  const start = readStartingData(fixtureDir);
  const differences: string[] = [];
  let lastGet = "";
  for (const c of cases) {
    const req = request(c, c.body === "@GET" ? lastGet : undefined);
    const pairing = new Pairing();
    const [up, ig] = await Promise.all([
      sendTo(pair.upstream.url, req),
      sendTo(pair.iglo.url, req),
    ]);
    if (c.method === "GET" && c.url === "/api/settings" && up.status === 200) {
      lastGet = text(up);
    }
    for (const d of compareResponses(up, ig, { start, request: req }, pairing)) {
      differences.push(`${c.name}: ${d}`);
    }
    for (const d of rowDifferences(
      storedRow(pair.upstreamDir),
      storedRow(pair.igloDir),
      encrypted,
    )) {
      differences.push(`${c.name}: ${d}`);
    }
  }
  return differences;
}

async function getSettings(server: Server): Promise<ScenarioResponse> {
  return sendTo(
    server.url,
    request({ name: "GET", as: "superuser", method: "GET", url: "/api/settings" }),
  );
}

describe("cases", () => {
  test(
    "access, validation, merges and secrets",
    async () => {
      const pair = await startPair(fixtureDir);
      try {
        const cases = [...accessCases, ...validationCases, ...mergeCases, ...secretCases];
        expect(cases.length).toBeGreaterThanOrEqual(40);
        expect(await runCases(pair, cases)).toEqual([]);
      } finally {
        await Promise.all([stop(pair.upstream), stop(pair.iglo)]);
      }
    },
    timeout,
  );

  test(
    "the superuser IP whitelist on settings and records endpoints",
    async () => {
      const pair = await startPair(fixtureDir);
      try {
        expect(await runCases(pair, whitelistCases)).toEqual([]);
      } finally {
        await Promise.all([stop(pair.upstream), stop(pair.iglo)]);
      }
    },
    timeout,
  );

  test(
    "encrypted: the same cases with an encryption key",
    async () => {
      const key = randomString(32);
      const pair = await startPair(fixtureDir, key);
      try {
        expect(await runCases(pair, [...mergeCases, ...secretCases], true)).toEqual([]);
        const [up, ig] = [storedRow(pair.upstreamDir), storedRow(pair.igloDir)];
        expect(up?.type).toBe("text");
        expect(ig?.type).toBe("text");
      } finally {
        await Promise.all([stop(pair.upstream), stop(pair.iglo)]);
      }
    },
    timeout,
  );
});

// the settings writes of the round trips
const roundTripWrites: string[] = [
  `{"meta":{"appName":"round_trip","appURL":"https://example.com","senderName":"RT","senderAddress":"rt@example.com","accentColor":"#123abc","hideControls":true}}`,
  `{"smtp":{"enabled":true,"host":"smtp.example.com","port":2525,"username":"user","password":"smtp_pw","authMethod":"LOGIN","tls":true,"localName":"example.com"}}`,
  `{"s3":{"enabled":false,"bucket":"b","region":"r","endpoint":"https://s3.example.com","accessKey":"ak","secret":"s3_pw","forcePathStyle":true}}`,
  `{"backups":{"cron":"0 3 * * *","cronMaxKeep":4,"s3":{"bucket":"bb","secret":"backups_pw"}}}`,
  `{"rateLimits":{"enabled":true,"rules":[{"label":"*:auth","duration":3,"maxRequests":2},{"label":"/api/","audience":"@guest","duration":10,"maxRequests":300}],"excludedIPs":["10.0.0.1"]}}`,
  `{"trustedProxy":{"headers":["X-Forwarded-For"],"useLeftmostIP":true}}`,
  `{"batch":{"enabled":true,"maxRequests":20,"timeout":9007199254740993,"maxBodySize":1048576}}`,
  `{"logs":{"maxDataSize":2048,"maxDays":9,"minLevel":-4,"logIP":true,"logAuthId":true}}`,
  // last: from now on the superuser may come only from these
  `{"superuserIPs":["127.0.0.1","10.0.0.0/8"]}`,
];

const blockingWrite = `{"superuserIPs":["10.0.0.0/8"]}`;

async function writeAll(server: Server, writes: string[]): Promise<void> {
  for (const body of writes) {
    const res = await sendTo(
      server.url,
      request({ name: "write", as: "superuser", method: "PATCH", url: "/api/settings" }, body),
    );
    expect({ body, status: res.status, text: res.status === 200 ? "" : text(res) }).toEqual({
      body,
      status: 200,
      text: "",
    });
  }
}

// writer writes the settings; the reader starts on a copy of the writer's
// pb_data and must answer GET /api/settings as the writer does, keep the
// stored row as it is, and apply the whitelist
async function roundTrip(writer: "upstream" | "iglo.base", key?: string): Promise<string[]> {
  const writerDir = fixtureCopy();
  const startWriter = writer === "upstream" ? startUp : startIglo;
  const startReader = writer === "upstream" ? startIglo : startUp;
  const differences: string[] = [];

  const w = await startWriter(writerDir, key);
  let writerGet: ScenarioResponse;
  try {
    await writeAll(w, roundTripWrites);
    writerGet = await getSettings(w);
  } finally {
    await stop(w);
  }
  const written = storedRow(writerDir);
  if (key !== undefined && written?.type !== "text") {
    differences.push(`the encrypted value is stored as ${written?.type}`);
  }
  if (key === undefined && written?.type !== "blob") {
    differences.push(`the plain value is stored as ${written?.type}`);
  }

  const readerDir = copyOf(writerDir);
  const r = await startReader(readerDir, key);
  try {
    const readerGet = await getSettings(r);
    const start = readStartingData(fixtureDir);
    const req = request({ name: "GET", as: "superuser", method: "GET", url: "/api/settings" });
    differences.push(
      ...compareResponses(writerGet, readerGet, { start, request: req }).map((d) => `GET: ${d}`),
    );
    const readText = text(readerGet);
    for (const secret of ["smtp_pw", "s3_pw", "backups_pw"]) {
      if (readText.includes(secret)) {
        differences.push(`GET shows the secret ${secret}`);
      }
    }
    // the trusted proxy header is reported by the health check
    const health = await sendTo(
      r.url,
      request({
        name: "health",
        as: "superuser",
        method: "GET",
        url: "/api/health",
        headers: { "X-Forwarded-For": "unknown" },
      }),
    );
    if (!text(health).includes(`"possibleProxyHeader":"X-Forwarded-For"`)) {
      differences.push(`health: ${text(health)}`);
    }
    // reading wrote nothing
    const afterRead = storedRow(readerDir);
    if (JSON.stringify(afterRead) !== JSON.stringify(written)) {
      differences.push("the reader's start changed the stored row");
    }
    // the reader applies the whitelist the writer stored
    await writeAll(r, [blockingWrite]);
    const blocked = await getSettings(r);
    if (blocked.status !== 403) {
      differences.push(`after the blocking write: ${blocked.status} ${text(blocked)}`);
    }
  } finally {
    await stop(r);
  }

  // the writer reads the reader's last save back (the secrets survive it)
  const backDir = copyOf(readerDir);
  const back = await startWriter(backDir, key);
  try {
    const res = await sendTo(
      back.url,
      request({ name: "GET", as: "superuser", method: "GET", url: "/api/settings" }),
    );
    if (res.status !== 403) {
      differences.push(`writer on the reader's data: ${res.status}`);
    }
  } finally {
    await stop(back);
  }
  if (key === undefined) {
    const stored = storedRow(backDir)?.value ?? "";
    for (const secret of ["smtp_pw", "s3_pw", "backups_pw"]) {
      if (!stored.includes(secret)) {
        differences.push(`the stored settings lost ${secret}`);
      }
    }
  }
  return differences;
}

describe("round trip", () => {
  for (const writer of ["upstream", "iglo.base"] as const) {
    test(
      `${writer} writes plain settings, the other reads them`,
      async () => {
        expect(await roundTrip(writer)).toEqual([]);
      },
      timeout,
    );

    test(
      `${writer} writes encrypted settings, the other reads them`,
      async () => {
        expect(await roundTrip(writer, randomString(32))).toEqual([]);
      },
      timeout,
    );
  }
});

// `serve` on dataDir until it exits or 5 s pass; the first output line
// without its timestamp, and the exit code (null when still running)
async function startupResult(
  binary: string[],
  dataDir: string,
  env: Record<string, string>,
): Promise<{ exitCode: number | null; line: string }> {
  const proc = Bun.spawn(
    [
      ...binary,
      "serve",
      "--http",
      "127.0.0.1:0",
      "--dir",
      dataDir,
      "--encryptionEnv",
      encryptionEnv,
    ],
    {
      cwd: newRoot(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1", ...env },
    },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const line = (stderr + stdout).split("\n")[0] ?? "";
  return {
    exitCode: proc.signalCode === "SIGKILL" ? null : exitCode,
    line: line.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, ""),
  };
}

describe("startup", () => {
  const upstreamBinary = (): string[] => [requireTool("pocketbase", defaultLayout)];
  const igloBinary = async (): Promise<string[]> => [await executable()];

  // a pb_data with encrypted settings, written by upstream
  async function encryptedDataDir(key: string): Promise<string> {
    const dataDir = fixtureCopy();
    const up = await startUp(dataDir, key);
    try {
      await writeAll(up, [`{"meta":{"appName":"encrypted"}}`]);
    } finally {
      await stop(up);
    }
    expect(storedRow(dataDir)?.type).toBe("text");
    return dataDir;
  }

  test(
    "a missing, wrong or short key fails both the same way",
    async () => {
      const key = randomString(32);
      const dataDir = await encryptedDataDir(key);
      for (const env of [
        {},
        { [encryptionEnv]: randomString(32) },
        { [encryptionEnv]: "short" },
      ] as Record<string, string>[]) {
        const [up, ig] = await Promise.all([
          startupResult(upstreamBinary(), copyOf(dataDir), env),
          startupResult(await igloBinary(), copyOf(dataDir), env),
        ]);
        expect(ig).toEqual(up);
        expect(up.exitCode).toBe(1);
      }
      // the messages, for the record
      const missing = await startupResult(await igloBinary(), copyOf(dataDir), {});
      expect(missing.line).toBe(
        `invalid settings db data or missing encryption key "${encryptionEnv}"`,
      );
    },
    timeout,
  );

  test(
    "plain settings load with a key set; a fresh install with a short key fails",
    async () => {
      const key = randomString(32);
      const pair = await startPair(fixtureDir, key);
      try {
        const [up, ig] = await Promise.all([getSettings(pair.upstream), getSettings(pair.iglo)]);
        expect(text(ig)).toBe(text(up));
        expect(storedRow(pair.igloDir)?.type).toBe("blob");
      } finally {
        await Promise.all([stop(pair.upstream), stop(pair.iglo)]);
      }

      const freshUp = join(newRoot(), "pb_data");
      const freshIg = join(newRoot(), "pb_data");
      const env = { [encryptionEnv]: "short" };
      const [up, ig] = await Promise.all([
        startupResult(upstreamBinary(), freshUp, env),
        startupResult(await igloBinary(), freshIg, env),
      ]);
      expect(ig).toEqual(up);
    },
    timeout,
  );
});

describe("stored shapes", () => {
  test(
    "the fixture's row and unknown keys load the same; the next save writes the same bytes",
    async () => {
      const source = fixtureCopy((dataDir) =>
        changeSettings(dataDir, (settings) => {
          (settings as Record<string, unknown>).unknownTop = { nested: [1, 2, { a: null }] };
          settings.meta = { ...settings.meta, unknownMeta: "x", appName: "shapes" };
          delete settings.batch;
        }),
      );
      const pair = await startPair(source);
      try {
        const [up, ig] = await Promise.all([getSettings(pair.upstream), getSettings(pair.iglo)]);
        const start = readStartingData(fixtureDir);
        const req = request({ name: "GET", as: "superuser", method: "GET", url: "/api/settings" });
        expect(compareResponses(up, ig, { start, request: req })).toEqual([]);
        // nothing was written on start
        expect(storedRow(pair.igloDir)).toEqual(storedRow(source));
        expect(
          await runCases(pair, [
            { name: "save", as: "superuser", method: "PATCH", url: "/api/settings", body: "{}" },
          ]),
        ).toEqual([]);
        expect(storedRow(pair.igloDir)?.value).not.toContain("unknown");
      } finally {
        await Promise.all([stop(pair.upstream), stop(pair.iglo)]);
      }
    },
    timeout,
  );

  test(
    "no settings row: both write the current defaults merged with nothing",
    async () => {
      const source = fixtureCopy((dataDir) => {
        const db = new Database(join(dataDir, "data.db"));
        try {
          db.run("DELETE FROM _params");
        } finally {
          db.close();
        }
      });
      const pair = await startPair(source);
      try {
        expect(rowDifferences(storedRow(pair.upstreamDir), storedRow(pair.igloDir), false)).toEqual(
          [],
        );
        const [up, ig] = await Promise.all([getSettings(pair.upstream), getSettings(pair.iglo)]);
        expect(text(ig)).toBe(text(up));
      } finally {
        await Promise.all([stop(pair.upstream), stop(pair.iglo)]);
      }
    },
    timeout,
  );
});

// M7.1a: how long other requests wait while 8 cost-12 password operations run.
// `/api/health` is requested one after another (5 ms apart) during 8
// concurrent sign-ins and, separately, 8 concurrent user creates (each hashes
// a password). One server at a time. Not shipped; needs
// `bun run upstream:prepare`.
//
//   nice -n 10 bun test/perf/compare/bcrypt-lag.ts --exe before=<path>,after=<path> [--upstream] [--rounds 5]
//
// Each --exe entry is a label and a compiled iglo.base executable.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  apiClient,
  hostFacts,
  percentile,
  repoRoot,
  startUpstreamServer,
  upsertSuperuser,
  type Server,
} from "@/../scripts/spikes/M0.8/common";

import { freePort } from "@test/support/executable";

const { values } = parseArgs({
  options: {
    exe: { type: "string", default: "" },
    upstream: { type: "boolean", default: false },
    rounds: { type: "string", default: "5" },
  },
});
const rounds = Number(values.rounds);
const password = "1234567890";

mkdirSync(join(repoRoot, "dist"), { recursive: true });
const root = mkdtempSync(join(repoRoot, "dist", "lag-"));

async function startIglo(exe: string, dataDir: string): Promise<Server> {
  const port = await freePort();
  const proc = Bun.spawn(
    [exe, "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir, "--automigrate=false"],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        break;
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(20);
  }
  return {
    url,
    port,
    pid: proc.pid,
    output: () => "",
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

async function measure(label: string, server: Server): Promise<string[]> {
  const api = apiClient(server.url);
  await api.loginSuperuser("bench@example.com", password);
  await api.must("POST", "/api/collections", {
    name: "u12",
    type: "auth",
    listRule: "",
    viewRule: "",
    createRule: "",
    passwordAuth: { enabled: true, identityFields: ["email"] },
    fields: [
      {
        name: "password",
        type: "password",
        required: true,
        hidden: true,
        system: true,
        min: 8,
        cost: 12,
      },
    ],
  });
  await api.must("POST", "/api/collections/u12/records", {
    email: "a@example.com",
    password,
    passwordConfirm: password,
  });

  const rows: string[] = [];
  for (const op of ["sign-in", "create"] as const) {
    const health: number[] = [];
    const ops: number[] = [];
    const walls: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const state = { running: true };
      const probe = (async () => {
        while (state.running) {
          const h0 = performance.now();
          await (await fetch(`${server.url}/api/health`)).arrayBuffer();
          health.push(performance.now() - h0);
          await Bun.sleep(5);
        }
      })();
      await Bun.sleep(30);
      const w0 = performance.now();
      await Promise.all(
        Array.from({ length: 8 }, async (_, k) => {
          const t0 = performance.now();
          const res =
            op === "sign-in"
              ? await fetch(`${server.url}/api/collections/u12/auth-with-password`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ identity: "a@example.com", password }),
                })
              : await fetch(`${server.url}/api/collections/u12/records`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    email: `n${round}-${k}-${Math.random().toString(36).slice(2)}@example.com`,
                    password,
                    passwordConfirm: password,
                  }),
                });
          await res.arrayBuffer();
          if (res.status !== 200) {
            throw new Error(`${label} ${op}: ${res.status}`);
          }
          ops.push(performance.now() - t0);
        }),
      );
      walls.push(performance.now() - w0);
      state.running = false;
      await probe;
      await Bun.sleep(100);
    }
    health.sort((a, b) => a - b);
    ops.sort((a, b) => a - b);
    rows.push(
      `| ${label} | 8 × ${op} | ${percentile(ops, 0.5).toFixed(0)} / ${(ops.at(-1) ?? 0).toFixed(0)} | ${percentile(
        walls.toSorted((a, b) => a - b),
        0.5,
      ).toFixed(
        0,
      )} | ${health.length} | ${percentile(health, 0.5).toFixed(1)} / ${percentile(health, 0.95).toFixed(1)} / ${(health.at(-1) ?? 0).toFixed(1)} |`,
    );
  }
  return rows;
}

try {
  const base = join(root, "base", "pb_data");
  mkdirSync(base, { recursive: true });
  await upsertSuperuser(base, root, "bench@example.com", password);

  const targets: { label: string; exe?: string }[] = values.exe
    ? values.exe.split(",").map((e) => ({ label: e.split("=")[0]!, exe: e.split("=")[1]! }))
    : [];
  if (values.upstream) {
    targets.push({ label: "upstream" });
  }
  const table = [
    "| Server | Operation | operation p50 / max ms | 8 at once, wall ms (median) | health requests | `/api/health` p50 / p95 / max ms |",
    "|---|---|---|---|---|---|",
  ];
  for (const t of targets) {
    const dir = join(root, t.label, "pb_data");
    mkdirSync(join(root, t.label), { recursive: true });
    cpSync(base, dir, { recursive: true });
    const server = t.exe ? await startIglo(t.exe, dir) : await startUpstreamServer(dir, root);
    try {
      table.push(...(await measure(t.label, server)));
    } finally {
      await server.stop();
    }
  }
  console.log(hostFacts());
  console.log(table.join("\n"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

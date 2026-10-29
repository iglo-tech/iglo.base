// M0.8 spike 3: bcrypt password hashes round-tripped between iglo.base
// (Bun.password) and upstream PocketBase v0.41.0 (golang.org/x/crypto
// bcrypt) through the HTTP API. Not shipped; needs `bun run
// upstream:prepare`. Report: docs/perf/M0.8-bcrypt.md.
//
//   nice -n 10 bun scripts/spikes/M0.8/bcrypt.ts
//
// One pb_data, served by one server at a time: auth collections `u10` and
// `u12` (password field cost 10 and 12, min 8, create and update rule "").
//   1. upstream creates a user per password case in both collections;
//   2. iglo.base signs each one in (right password, and wrong or longer
//      variants), creates the same users under other emails and changes
//      the password of some upstream users (record update as superuser);
//   3. upstream signs in iglo.base's users and the changed users, and
//      changes the password of some iglo.base users;
//   4. iglo.base signs in those.
// Between the phases the stored hashes are read from data.db (prefix and
// cost), and raw "$2b$" (Bun.password) and "$2y$" hashes are written into
// two extra users, then signed in by both servers. Every sign-in is sent to
// both servers in the phase that owns the data, and statuses and error
// bodies are compared. Last, the sign-in time per cost on each server.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import {
  apiClient,
  hostFacts,
  percentile,
  spikeRoot,
  startIgloServer,
  startUpstreamServer,
  upsertSuperuser,
  type Server,
} from "@/../scripts/spikes/M0.8/common";

const enc = new TextEncoder();
const bytes = (s: string): number => enc.encode(s).length;

interface PasswordCase {
  name: string;
  password: string;
  // other passwords to try against the same hash, with the expected
  // result (true: signs in)
  variants: [string, string, boolean][];
}

const ascii71 = "a".repeat(35) + "B".repeat(35) + "c";
const z36 = "ż".repeat(36); // 36 characters, 72 bytes
const cases: PasswordCase[] = [
  {
    name: "ascii",
    password: "1234567890",
    variants: [
      ["wrong last char", "1234567891", false],
      ["prefix", "123456789", false],
    ],
  },
  {
    name: "ascii-71",
    password: ascii71,
    variants: [
      ["+1 byte (72)", ascii71 + "X", false],
      ["+3 bytes (74)", ascii71 + "XYZ", false],
    ],
  },
  {
    name: "polish",
    password: "zażółć gęślą jaźń",
    variants: [
      ["NFD form", "zażółć gęślą jaźń".normalize("NFD"), false],
      ["ASCII folded", "zazolc gesla jazn", false],
    ],
  },
  {
    name: "emoji",
    password: "🔑🔒🗝️ klucz 鍵",
    variants: [["without the variation selector", "🔑🔒🗝 klucz 鍵", false]],
  },
  {
    name: "z36-72-bytes",
    password: z36,
    variants: [
      ["+1 byte (73)", z36 + "x", true],
      ["+ż (74)", z36 + "ż", true],
      ["35ż + a (71)", "ż".repeat(35) + "a", false],
    ],
  },
  {
    name: "emoji-72-bytes",
    // 18 four-byte emoji: 72 bytes
    password: "🔑".repeat(18),
    variants: [
      ["+ another emoji (76)", "🔑".repeat(18) + "🔒", true],
      ["last emoji changed (72)", "🔑".repeat(17) + "🔒", false],
    ],
  },
  {
    name: "emoji-straddle",
    // 71 bytes; a sign-in with one more emoji puts its first byte at 72
    password: "🔑".repeat(17) + "abc",
    variants: [["+ an emoji across byte 72 (75)", "🔑".repeat(17) + "abc🔒", false]],
  },
  { name: "z40-80-bytes", password: "ż".repeat(40), variants: [] },
];

interface Check {
  label: string;
  upstream?: string;
  iglo?: string;
}

const checks: Check[] = [];
const rows = new Map<string, Check>();

function record(label: string, target: "upstream" | "iglo", result: string): void {
  let row = rows.get(label);
  if (!row) {
    row = { label };
    rows.set(label, row);
    checks.push(row);
  }
  row[target] = result;
}

function summarize(r: { status: number; json: unknown }): string {
  if (r.status === 200) {
    return "200";
  }
  return `${r.status} ${JSON.stringify(r.json)}`;
}

async function signIn(server: Server, collection: string, email: string, password: string) {
  return apiClient(server.url).call("POST", `/api/collections/${collection}/auth-with-password`, {
    identity: email,
    password,
  });
}

function hashes(dataDir: string): Map<string, string> {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    const out = new Map<string, string>();
    for (const c of ["u10", "u12"]) {
      for (const row of db.query(`SELECT email, password FROM ${c}`).all() as {
        email: string;
        password: string;
      }[]) {
        out.set(`${c}/${row.email}`, row.password);
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function setRawHash(dataDir: string, collection: string, email: string, hash: string): void {
  const db = new Database(join(dataDir, "data.db"));
  try {
    db.query(`UPDATE ${collection} SET password = ? WHERE email = ?`).run(hash, email);
  } finally {
    db.close();
  }
}

const superuser = async (server: Server) => {
  const api = apiClient(server.url);
  await api.loginSuperuser("spike@example.com", "1234567890");
  return api;
};

const describeHash = (h: string | undefined): string => (h ? h.slice(0, 7) : "-");

// how many of `by`'s users have a different hash in b than in a
const changed = (a: Map<string, string>, b: Map<string, string>, by: string): string => {
  const keys = [...a.keys()].filter((k) => k.includes(`-${by}@`) && b.has(k));
  return `${keys.filter((k) => a.get(k) !== b.get(k)).length} of ${keys.length}`;
};

const spike = spikeRoot("m08-bcrypt");
try {
  console.log(hostFacts());
  const dataDir = join(spike.root, "pb_data");
  const root = spike.root;
  await upsertSuperuser(dataDir, root, "spike@example.com", "1234567890");
  const start = (target: "upstream" | "iglo"): Promise<Server> =>
    target === "upstream" ? startUpstreamServer(dataDir, root) : startIgloServer(dataDir, root);
  const email = (c: PasswordCase, by: string): string => `${c.name}-${by}@example.com`;
  const createAll = async (server: Server, target: "upstream" | "iglo", by: string) => {
    const guest = apiClient(server.url);
    for (const col of ["u10", "u12"]) {
      for (const c of cases) {
        const r = await guest.call("POST", `/api/collections/${col}/records`, {
          email: email(c, by),
          password: c.password,
          passwordConfirm: c.password,
        });
        record(`${col} create ${c.name} (${bytes(c.password)} bytes)`, target, summarize(r));
      }
    }
  };
  // sign-ins of the users created (or changed) by `by`, on the given server
  const signInAll = async (
    server: Server,
    target: "upstream" | "iglo",
    by: string,
    what: string,
  ) => {
    for (const col of ["u10", "u12"]) {
      for (const c of cases) {
        const r = await signIn(server, col, email(c, by), c.password);
        record(`${col} ${what}: ${c.name}`, target, summarize(r));
        for (const [label, variant, _expected] of c.variants) {
          const v = await signIn(server, col, email(c, by), variant);
          record(
            `${col} ${what}: ${c.name}, ${label} (${bytes(variant)} bytes)`,
            target,
            summarize(v),
          );
        }
      }
    }
  };
  const changePasswords = async (server: Server, target: "upstream" | "iglo", by: string) => {
    const api = await superuser(server);
    for (const col of ["u10", "u12"]) {
      for (const c of cases) {
        const list = (await api.must(
          "GET",
          `/api/collections/${col}/records?filter=${encodeURIComponent(`email="${email(c, by)}"`)}`,
        )) as { items: { id: string }[] };
        const id = list.items[0]?.id;
        if (!id) {
          continue;
        }
        // the same password again: a new salt and hash written by this server
        const r = await api.call("PATCH", `/api/collections/${col}/records/${id}`, {
          password: c.password,
          passwordConfirm: c.password,
        });
        record(`${col} update ${c.name} (the other server's user)`, target, summarize(r));
      }
    }
  };

  // 0. upstream: the collections, its users and their sign-ins
  {
    const server = await start("upstream");
    try {
      const api = await superuser(server);
      for (const cost of [10, 12]) {
        await api.must("POST", "/api/collections", {
          name: `u${cost}`,
          type: "auth",
          listRule: "",
          viewRule: "",
          createRule: "",
          updateRule: "",
          passwordAuth: { enabled: true, identityFields: ["email"] },
          fields: [
            {
              name: "password",
              type: "password",
              required: true,
              hidden: true,
              system: true,
              min: 8,
              cost,
            },
          ],
        });
        const col = (await api.must("GET", `/api/collections/u${cost}`)) as {
          fields: { name: string; cost?: number }[];
        };
        console.log(
          `u${cost} password field cost: ${col.fields.find((f) => f.name === "password")?.cost}`,
        );
      }
      await createAll(server, "upstream", "up");
      await signInAll(server, "upstream", "up", "sign in upstream's user");
    } finally {
      await server.stop();
    }
  }
  const afterUp = hashes(dataDir);

  // 1. iglo.base reads upstream's hashes and writes its own
  {
    const server = await start("iglo");
    try {
      await signInAll(server, "iglo", "up", "sign in upstream's user");
      await createAll(server, "iglo", "ig");
      await changePasswords(server, "iglo", "up");
      await signInAll(server, "iglo", "up", "sign in upstream's user after iglo.base's update");
    } finally {
      await server.stop();
    }
  }
  const afterIglo = hashes(dataDir);

  // raw hashes in other bcrypt versions, written into two upstream users
  const b2b = Bun.password.hashSync("1234567890", { algorithm: "bcrypt", cost: 10 });
  setRawHash(dataDir, "u10", email(cases[0] as PasswordCase, "up"), b2b);
  setRawHash(dataDir, "u12", email(cases[0] as PasswordCase, "up"), b2b.replace(/^\$2b\$/, "$2y$"));

  // 2. upstream reads iglo.base's hashes and writes its own
  {
    const server = await start("upstream");
    try {
      await signInAll(server, "upstream", "ig", "sign in iglo.base's user");
      await signInAll(server, "upstream", "up", "sign in upstream's user after iglo.base's update");
      for (const [col, kind] of [
        ["u10", "$2b$ (Bun.password)"],
        ["u12", "$2y$"],
      ] as const) {
        const r = await signIn(server, col, email(cases[0] as PasswordCase, "up"), "1234567890");
        record(`${col} raw ${kind} hash`, "upstream", summarize(r));
      }
      await changePasswords(server, "upstream", "ig");
    } finally {
      await server.stop();
    }
  }

  // 3. iglo.base reads upstream's updates and the raw hashes
  {
    const server = await start("iglo");
    try {
      await signInAll(server, "iglo", "ig", "sign in iglo.base's user");
      for (const [col, kind] of [
        ["u10", "$2b$ (Bun.password)"],
        ["u12", "$2y$"],
      ] as const) {
        const r = await signIn(server, col, email(cases[0] as PasswordCase, "up"), "1234567890");
        record(`${col} raw ${kind} hash`, "iglo", summarize(r));
      }
    } finally {
      await server.stop();
    }
  }
  // the "sign in iglo.base's user" rows for upstream were before upstream's
  // update and the iglo rows after it: both are the same users and passwords
  const afterAll = hashes(dataDir);

  // 4. sign-in time per cost (the same user, 10 sign-ins after 2 warm-ups,
  // then 8 at once)
  const timing: string[] = [];
  for (const target of ["upstream", "iglo"] as const) {
    const server = await start(target);
    try {
      for (const col of ["u10", "u12"]) {
        const ms: number[] = [];
        for (let i = 0; i < 12; i++) {
          const t0 = performance.now();
          const r = await signIn(
            server,
            col,
            email(cases[2] as PasswordCase, "ig"),
            (cases[2] as PasswordCase).password,
          );
          if (r.status !== 200) {
            throw new Error(`${target} ${col}: ${r.status}`);
          }
          if (i >= 2) {
            ms.push(performance.now() - t0);
          }
        }
        ms.sort((a, b) => a - b);

        // 8 sign-ins at once, 3 rounds, with /api/health requests (one
        // after the other) while they run
        const conc: number[] = [];
        const health: number[] = [];
        const walls: number[] = [];
        for (let round = 0; round < 3; round++) {
          const state = { running: true };
          const probe = (async () => {
            while (state.running) {
              const h0 = performance.now();
              await (await fetch(`${server.url}/api/health`)).arrayBuffer();
              health.push(performance.now() - h0);
              await Bun.sleep(5);
            }
          })();
          const w0 = performance.now();
          await Promise.all(
            Array.from({ length: 8 }, async () => {
              const t0 = performance.now();
              const r = await signIn(
                server,
                col,
                email(cases[2] as PasswordCase, "ig"),
                (cases[2] as PasswordCase).password,
              );
              if (r.status !== 200) {
                throw new Error(`${target} ${col}: ${r.status}`);
              }
              conc.push(performance.now() - t0);
            }),
          );
          walls.push(performance.now() - w0);
          state.running = false;
          await probe;
        }
        conc.sort((a, b) => a - b);
        health.sort((a, b) => a - b);
        walls.sort((a, b) => a - b);
        timing.push(
          `| ${target} | ${col.slice(1)} | ${percentile(ms, 0.5).toFixed(1)} | ${(ms.at(-1) ?? 0).toFixed(1)} | ${percentile(conc, 0.5).toFixed(0)} / ${(conc.at(-1) ?? 0).toFixed(0)} | ${percentile(walls, 0.5).toFixed(0)} | ${percentile(health, 0.5).toFixed(1)} / ${(health.at(-1) ?? 0).toFixed(1)} |`,
        );
      }
    } finally {
      await server.stop();
    }
  }

  console.log("\nStored hashes (prefix, cost):");
  for (const [key, h] of afterAll) {
    console.log(
      `${key}: after upstream ${describeHash(afterUp.get(key))}, after iglo.base ${describeHash(afterIglo.get(key))}, end ${describeHash(h)}`,
    );
  }

  console.log(
    `hashes rewritten by the updates: upstream's users by iglo.base ${changed(afterUp, afterIglo, "up")}, iglo.base's users by upstream ${changed(afterIglo, afterAll, "ig")}`,
  );

  console.log("\n| Check | upstream | iglo.base | Same |");
  console.log("|---|---|---|---|");
  for (const c of checks) {
    const same =
      c.upstream === undefined || c.iglo === undefined
        ? "-"
        : c.upstream === c.iglo
          ? "yes"
          : "**no**";
    console.log(`| ${c.label} | ${c.upstream ?? "-"} | ${c.iglo ?? "-"} | ${same} |`);
  }

  console.log(
    "\nSign-in time (ms)\n| Server | Cost | 1 at a time p50 | max | 8 at once p50 / max | 8 at once, wall | /api/health meanwhile p50 / max |\n|---|---|---|---|---|---|---|",
  );
  for (const t of timing) {
    console.log(t);
  }

  // expected results of the variants
  const mismatches: string[] = [];
  for (const col of ["u10", "u12"]) {
    for (const c of cases) {
      for (const [label, variant, expected] of c.variants) {
        for (const what of [
          "sign in upstream's user",
          "sign in iglo.base's user",
          "sign in upstream's user after iglo.base's update",
        ]) {
          const row = rows.get(`${col} ${what}: ${c.name}, ${label} (${bytes(variant)} bytes)`);
          for (const r of [row?.upstream, row?.iglo]) {
            if (r !== undefined && (r === "200") !== expected) {
              mismatches.push(`${col} ${what}: ${c.name}, ${label}: ${r}`);
            }
          }
        }
      }
    }
  }
  console.log(
    `\nvariants with an unexpected result: ${mismatches.length ? mismatches.join("; ") : "none"}`,
  );
} finally {
  spike.cleanup();
}

// Records list and view (src/apis/record-crud.ts) against the reference
// PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// Two data sets, each served by both servers from copies of the same
// pb_data, with every request sent to both and the responses compared as
// the scenario harness compares them (test/differential/harness/compare.ts):
//
//   (a) upstream's fixture (fixture-cases.ts), as a guest, users, clients,
//       nologin and a superuser (upstream's fixture tokens);
//   (b) a fresh install built through upstream's API (fresh-cases.ts): the
//       resolver reference test's collections and records plus one
//       notes_<shape> collection per rule shape, as a guest, alice, bob,
//       carol and a superuser (tokens from auth-with-password, valid in
//       both servers because the data is the same).
//
// Both servers read through their read worker pools (serve's default),
// which covers the read pool on a served pb_data through HTTP. The
// repeated request header case (D22) is a scenario with a deliberate
// difference, run with the scenario harness.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpstream } from "@test/differential/db/fixture";
import { compareResponses, readStartingData } from "@test/differential/harness/compare";
import { runDifferential } from "@test/differential/harness/run";
import {
  fixtureCases,
  type Identity,
  type ReadCase,
} from "@test/differential/records-read/fixture-cases";
import {
  freshCases,
  type FreshIdentity,
  notes,
  notesCollection,
  ruleCases,
  ruleShapes,
} from "@test/differential/records-read/fresh-cases";
import {
  authUsers,
  collectionSteps,
  password,
  recordSteps,
} from "@test/differential/resolver/schema";
import { outcome } from "@test/scenarios/expectations";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { updateCollection } from "@test/scenarios/prepare";
import {
  clientsToken,
  nologinToken,
  superuserToken,
  usersToken,
} from "@test/scenarios/record-crud";
import { send } from "@test/scenarios/runner";
import type { Scenario } from "@test/scenarios/scenario";
import type { ScenarioResponse } from "@test/scenarios/request";
import { startServer, type RunningServer } from "@test/support/executable";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

interface ServerPair {
  dataDir: string;
  upstream: UpstreamServer;
  igloBase: RunningServer;
}

const roots: string[] = [];
const pairs: ServerPair[] = [];

async function startPair(sourceDir: string): Promise<ServerPair> {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-records-read-"));
  roots.push(root);
  const upstreamDir = join(root, "upstream", "pb_data");
  const igloBaseDir = join(root, "iglo-base", "pb_data");
  copyDataDir(sourceDir, upstreamDir);
  copyDataDir(sourceDir, igloBaseDir);
  const [upstream, igloBase] = await Promise.all([
    startUpstream({ dataDir: upstreamDir }),
    startServer([], igloBaseDir),
  ]);
  const pair = { dataDir: sourceDir, upstream, igloBase };
  pairs.push(pair);
  return pair;
}

// sends the case to both servers and returns the differences
async function compareCase(
  pair: ServerPair,
  c: ReadCase,
  authorization: string,
): Promise<{ status: number; differences: string[] }> {
  const headers: Record<string, string> = { ...c.headers };
  if (authorization !== "") {
    headers["Authorization"] = authorization;
  }
  const request: Scenario = { name: c.name, method: "GET", url: c.url, headers, expectedStatus: 0 };
  const [up, ig] = await Promise.all([
    send(pair.upstream.url, request),
    send(pair.igloBase.url, request),
  ]);
  if ("error" in up || "error" in ig) {
    throw new Error(
      `upstream: ${"error" in up ? up.error : "ok"}; iglo.base: ${"error" in ig ? ig.error : "ok"}`,
    );
  }
  return {
    status: (up as ScenarioResponse).status,
    differences: compareResponses(up, ig, {
      start: readStartingData(pair.dataDir),
      request,
    }),
  };
}

afterAll(async () => {
  await Promise.allSettled(pairs.flatMap((p) => [p.upstream.stop(), p.igloBase.stop()]));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// (a) upstream's fixture
// -------------------------------------------------------------------

const fixtureTokens: { [K in Identity]: string } = {
  guest: "",
  users: usersToken,
  clients: clientsToken,
  nologin: nologinToken,
  superuser: superuserToken,
};

describe("fixture", () => {
  let pair: ServerPair;
  beforeAll(async () => {
    pair = await startPair(fixtureDir);
  }, 60_000);

  for (const c of fixtureCases) {
    for (const who of c.as ?? (Object.keys(fixtureTokens) as Identity[])) {
      test(`${c.name} (${who})`, async () => {
        const result = await compareCase(pair, c, fixtureTokens[who]);
        expect(result.differences).toEqual([]);
      });
    }
  }
});

// (b) a fresh install
// -------------------------------------------------------------------

const superEmail = "records@example.com";

describe("fresh install", () => {
  let pair: ServerPair;
  const tokens = new Map<FreshIdentity, string>([["guest", ""]]);
  const statuses = new Map<string, number>();

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "iglo-base-records-read-fresh-"));
    roots.push(root);
    const dataDir = join(root, "pb_data");
    const upsert = await runUpstream(
      ["superuser", "upsert", superEmail, password, "--dir", dataDir],
      root,
    );
    expect(upsert.exitCode).toBe(0);
    const builder = await startUpstream({ dataDir });
    try {
      const api = async (
        method: string,
        path: string,
        body?: unknown,
        auth = tokens.get("superuser") ?? "",
      ) => {
        const res = await fetch(`${builder.url}${path}`, {
          method,
          headers: {
            ...(auth === "" ? {} : { authorization: auth }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (res.status !== 200 && res.status !== 204) {
          throw new Error(`${method} ${path}: ${res.status} ${text}`);
        }
        return text === "" ? null : (JSON.parse(text) as unknown);
      };
      const signIn = async (collection: string, email: string): Promise<string> =>
        (
          (await api(
            "POST",
            `/api/collections/${collection}/auth-with-password`,
            { identity: email, password },
            "",
          )) as { token: string }
        ).token;

      tokens.set("superuser", await signIn("_superusers", superEmail));

      const collectionIds = new Map<string, string>();
      const readIds = async (): Promise<void> => {
        const list = (await api("GET", "/api/collections?perPage=200")) as {
          items: { id: string; name: string }[];
        };
        for (const item of list.items) {
          collectionIds.set(item.name, item.id);
        }
      };
      const ids = (name: string): string => {
        const id = collectionIds.get(name);
        if (id === undefined) {
          throw new Error(`unknown collection ${name}`);
        }
        return id;
      };
      await readIds();

      for (const step of collectionSteps) {
        if (step.create !== undefined) {
          await api("POST", "/api/collections", step.create(ids));
        } else if (step.addFields !== undefined) {
          const current = (await api("GET", `/api/collections/${step.addFields.collection}`)) as {
            fields: object[];
          };
          await api("PATCH", `/api/collections/${step.addFields.collection}`, {
            fields: [...current.fields, ...step.addFields.fields(ids)],
          });
        }
        await readIds();
      }
      for (const shape of ruleShapes) {
        await api("POST", "/api/collections", notesCollection(shape, ids));
      }
      // members managers: admins
      await api("PATCH", "/api/collections/members", {
        manageRule: `@request.auth.role = "admin"`,
      });

      for (const step of recordSteps) {
        const body = step.body as { id: string };
        if (step.update === true) {
          await api("PATCH", `/api/collections/${step.collection}/records/${body.id}`, body);
        } else {
          await api("POST", `/api/collections/${step.collection}/records`, body);
        }
      }
      for (const shape of ruleShapes) {
        for (const note of notes) {
          await api("POST", `/api/collections/notes_${shape.shape}/records`, note);
        }
      }

      // the planner statistics of the final data (as the resolver test)
      await api("POST", "/api/sql", { query: "ANALYZE" });

      for (const name of ["alice", "bob", "carol"] as const) {
        tokens.set(name, await signIn(authUsers[name].collection, authUsers[name].email));
      }
    } finally {
      await builder.stop();
    }

    pair = await startPair(dataDir);
  }, 300_000);

  const identities: FreshIdentity[] = ["guest", "alice", "bob", "carol", "superuser"];
  for (const c of [...ruleCases(), ...freshCases]) {
    for (const who of c.as ?? identities) {
      test(`${c.name} (${who})`, async () => {
        const result = await compareCase(pair, c, tokens.get(who as FreshIdentity) ?? "");
        statuses.set(`${c.name} (${who})`, result.status);
        expect(result.differences).toEqual([]);
      });
    }
  }

  // the rules matrix must not be trivial: each shape but the public one
  // lets someone view a record and refuses someone
  test("every rule shape has allowed and refused identities", () => {
    for (const s of ruleShapes) {
      const views = [...statuses]
        .filter(([name]) => name.startsWith(`${s.shape}: view own`))
        .map(([, status]) => status);
      expect(views).toContain(200);
      if (s.shape !== "empty") {
        expect(views.some((status) => status !== 200)).toBe(true);
      }
    }
  });
});

// The repeated request header (D22): upstream's @request.headers.* sees the
// first line, iglo.base the lines joined with ", ". The scenario's header
// value carries a second header line (the raw request writes it as is).
describe("repeated request header lines", () => {
  test("@request.headers with a repeated header", async () => {
    const scenario: Scenario = {
      name: "@request.headers with a repeated header",
      method: "GET",
      url: "/api/collections/demo2/records",
      headers: { "X-Key": "h1\r\nX-Key: h2" },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo2", (col) => {
          col.listRule = `@request.headers.x_key = "h1"`;
        }),
      expectedStatus: 200,
      expectedContent: [`"totalItems":3`],
      difference: {
        name: "Repeated request header lines",
        igloBase: { expectedStatus: 200, expectedContent: [`"totalItems":0`, `"items":[]`] },
      },
    };
    const { upstreamFailures, igloBaseFailures } = await runDifferential(scenario);
    expect(upstreamFailures).toEqual([]);
    const result = outcome(scenario, igloBaseFailures);
    if (!result.ok) {
      throw new Error(result.message);
    }
  }, 60_000);

  test("the same rule with one header line matches upstream", async () => {
    const scenario: Scenario = {
      name: "@request.headers with one header line",
      method: "GET",
      url: "/api/collections/demo2/records",
      headers: { "X-Key": "h1" },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo2", (col) => {
          col.listRule = `@request.headers.x_key = "h1"`;
        }),
      expectedStatus: 200,
      expectedContent: [`"totalItems":3`],
    };
    const { upstreamFailures, igloBaseFailures } = await runDifferential(scenario);
    expect(upstreamFailures).toEqual([]);
    expect(igloBaseFailures).toEqual([]);
  }, 60_000);
});

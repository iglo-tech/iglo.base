// Records create, update and delete (src/apis/record-crud.ts) against the
// reference PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// Two data sets, each served by both servers from copies of the same
// pb_data. Every write is sent to both servers in the same order and the
// responses are compared as the scenario harness compares them
// (test/differential/harness/compare.ts); then the written record (the
// URL's, or the created one by each server's own id) and the case's other
// records are read back from both as a superuser and compared too:
//
//   (a) upstream's fixture (fixture-cases.ts), as a guest, users, clients,
//       nologin and a superuser (upstream's fixture tokens);
//   (b) a fresh install built through upstream's API (fresh-cases.ts), as
//       a guest, alice, bob, dave and a superuser (tokens from
//       auth-with-password, valid in both servers because the data is the
//       same).
//
// Round trip: after the cases, iglo.base stops and upstream starts on a
// copy of iglo.base's pb_data. Every record of every collection, listed
// by upstream from that copy, must equal the list upstream gives from its
// own pb_data, and the passwords the cases set must sign in.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpstream } from "@test/differential/db/fixture";
import { sendChunked } from "@test/differential/records-write/chunked";
import { compareResponses, Pairing, readStartingData } from "@test/differential/harness/compare";
import { type FixtureIdentity, fixtureCases } from "@test/differential/records-write/fixture-cases";
import {
  changedPasswords,
  freshCases,
  freshCollections,
  freshCollections2,
  type FreshIdentity,
  freshPassword,
  freshRecords,
  members,
  membersCollection,
  ruleShapes,
  typesFiles,
} from "@test/differential/records-write/fresh-cases";
import type { WriteCase } from "@test/differential/records-write/write-case";
import { rid } from "@test/differential/resolver/schema";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import {
  clientsToken,
  nologinToken,
  superuserToken,
  usersToken,
} from "@test/scenarios/record-crud";
import { send } from "@test/scenarios/runner";
import type { ScenarioResponse } from "@test/scenarios/request";
import type { Scenario } from "@test/scenarios/scenario";
import { startServer, type RunningServer } from "@test/support/executable";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

interface ServerPair {
  // the starting pb_data (only read)
  dataDir: string;
  upstreamDir: string;
  igloBaseDir: string;
  upstream: UpstreamServer;
  igloBase: RunningServer | null;
}

const roots: string[] = [];
const servers: { stop(): Promise<unknown> }[] = [];

async function startPair(sourceDir: string): Promise<ServerPair> {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-records-write-"));
  roots.push(root);
  const upstreamDir = join(root, "upstream", "pb_data");
  const igloBaseDir = join(root, "iglo-base", "pb_data");
  copyDataDir(sourceDir, upstreamDir);
  copyDataDir(sourceDir, igloBaseDir);
  const [upstream, igloBase] = await Promise.all([
    startUpstream({ dataDir: upstreamDir }),
    startServer([], igloBaseDir),
  ]);
  servers.push(upstream, igloBase);
  return { dataDir: sourceDir, upstreamDir, igloBaseDir, upstream, igloBase };
}

afterAll(async () => {
  await Promise.allSettled(servers.map((s) => s.stop()));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function responseText(res: ScenarioResponse): string {
  return new TextDecoder().decode(res.body);
}

function sendBoth(
  pair: ServerPair,
  request: Scenario,
): Promise<[ScenarioResponse, ScenarioResponse]> {
  return Promise.all([
    send(pair.upstream.url, request),
    send((pair.igloBase as RunningServer).url, request),
  ]).then(([up, ig]) => {
    if ("error" in up || "error" in ig) {
      throw new Error(
        `upstream: ${"error" in up ? up.error : "ok"}; iglo.base: ${"error" in ig ? ig.error : "ok"}`,
      );
    }
    return [up, ig];
  });
}

// the record path of a write URL (without the query)
function recordPath(url: string): string {
  return url.split("?")[0] as string;
}

// sends the write to both servers, then reads the written records back
// from both; returns upstream's status and every difference
async function runCase(
  pair: ServerPair,
  c: WriteCase,
  authorization: string,
): Promise<{ status: number; differences: string[] }> {
  const headers: Record<string, string> = { ...c.headers };
  if (authorization !== "") {
    headers["Authorization"] = authorization;
  }
  const request: Scenario = {
    name: c.name,
    method: c.method,
    url: c.url,
    headers,
    body: c.body,
    expectedStatus: 0,
  };
  const start = readStartingData(pair.dataDir);
  const pairing = new Pairing();
  const [up, ig] =
    c.chunked === undefined
      ? await sendBoth(pair, request)
      : await Promise.all([
          sendChunked(pair.upstream.url, c.method, c.url, headers, c.chunked),
          sendChunked((pair.igloBase as RunningServer).url, c.method, c.url, headers, c.chunked),
        ]);
  const differences = compareResponses(up, ig, { start, request }, pairing);

  // the records to read back: [upstream's path, iglo.base's path]
  const reads: [string, string][] = [];
  if (c.method === "POST") {
    if (up.status === 200 && ig.status === 200) {
      const upId = (JSON.parse(responseText(up)) as { id?: string }).id;
      const igId = (JSON.parse(responseText(ig)) as { id?: string }).id;
      if (upId !== undefined && igId !== undefined) {
        const base = recordPath(c.url);
        reads.push([`${base}/${upId}`, `${base}/${igId}`]);
      }
    }
  } else {
    reads.push([recordPath(c.url), recordPath(c.url)]);
  }
  for (const path of c.reads ?? []) {
    reads.push([path, path]);
  }

  for (const [upPath, igPath] of reads) {
    const read = (url: string): Scenario => ({
      name: `read ${url}`,
      method: "GET",
      url,
      headers: { Authorization: currentSuperuserToken },
      expectedStatus: 0,
    });
    const [upRead, igRead] = await Promise.all([
      send(pair.upstream.url, read(upPath)),
      send((pair.igloBase as RunningServer).url, read(igPath)),
    ]);
    if ("error" in upRead || "error" in igRead) {
      differences.push(`read back ${upPath}: request failed`);
      continue;
    }
    differences.push(
      ...compareResponses(upRead, igRead, { start, request: read(upPath) }, pairing).map(
        (d) => `read back ${upPath}: ${d}`,
      ),
    );
  }

  return { status: up.status, differences };
}

// a GET of url (for the comparison context)
function listRequest(url: string): Scenario {
  return { name: url, method: "GET", url, expectedStatus: 0 };
}

// the superuser token of the data set under test
let currentSuperuserToken = superuserToken;

// Round trip: iglo.base stops, upstream starts on a copy of its pb_data,
// and every collection's records listed from that copy must equal the ones
// upstream lists from its own data.
async function roundTrip(pair: ServerPair, token: string): Promise<string[]> {
  await (pair.igloBase as RunningServer).stop();
  pair.igloBase = null;
  const root = mkdtempSync(join(tmpdir(), "iglo-base-records-write-rt-"));
  roots.push(root);
  const rtDir = join(root, "pb_data");
  copyDataDir(pair.igloBaseDir, rtDir);
  const rt = await startUpstream({ dataDir: rtDir });
  servers.push(rt);

  const get = async (server: UpstreamServer, url: string): Promise<ScenarioResponse> => {
    const res = await send(server.url, {
      name: url,
      method: "GET",
      url,
      headers: { Authorization: token },
      expectedStatus: 0,
    });
    if ("error" in res) {
      throw new Error(res.error);
    }
    return res;
  };

  const collections = JSON.parse(
    responseText(await get(pair.upstream, "/api/collections?perPage=500&sort=name")),
  ) as { items: { name: string; type: string; fields: { name: string; type: string }[] }[] };
  const rtCollections = await get(rt, "/api/collections?perPage=500&sort=name");

  const start = readStartingData(pair.dataDir);
  const pairing = new Pairing();
  const differences: string[] = [];
  differences.push(
    ...compareResponses(
      await get(pair.upstream, "/api/collections?perPage=500&sort=name"),
      rtCollections,
      { start, request: listRequest("/api/collections") },
      pairing,
    ).map((d) => `collections: ${d}`),
  );

  for (const col of collections.items) {
    // every field but the random token keys
    const fields = col.fields.map((f) => f.name).filter((name) => name !== "tokenKey");
    const sort = col.type === "view" ? "id" : "@rowid";
    const url = `/api/collections/${col.name}/records?perPage=500&sort=${sort}&fields=${fields.join(",")}`;
    const [up, back] = await Promise.all([get(pair.upstream, url), get(rt, url)]);
    if (up.status !== 200) {
      differences.push(`${col.name}: upstream list ${up.status}: ${responseText(up)}`);
      continue;
    }
    differences.push(
      ...compareResponses(up, back, { start, request: listRequest(url) }, pairing).map(
        (d) => `${col.name}: ${d}`,
      ),
    );
  }

  return differences;
}

// (a) upstream's fixture
// -------------------------------------------------------------------

const fixtureTokens: { [K in FixtureIdentity]: string } = {
  guest: "",
  users: usersToken,
  clients: clientsToken,
  nologin: nologinToken,
  superuser: superuserToken,
};

describe("fixture", () => {
  let pair: ServerPair;
  beforeAll(async () => {
    currentSuperuserToken = superuserToken;
    pair = await startPair(fixtureDir);
  }, 60_000);

  for (const c of fixtureCases) {
    test(`${c.name} (${c.as})`, async () => {
      const result = await runCase(pair, c, fixtureTokens[c.as as FixtureIdentity]);
      expect(result.differences).toEqual([]);
    });
  }

  test("round trip: upstream reads iglo.base's pb_data back", async () => {
    expect(await roundTrip(pair, superuserToken)).toEqual([]);
  }, 60_000);
});

// (b) a fresh install
// -------------------------------------------------------------------

const superEmail = "records-write@example.com";

describe("fresh install", () => {
  let pair: ServerPair;
  const tokens = new Map<FreshIdentity, string>([["guest", ""]]);
  let fileNames: string[] = [];
  const statuses: { name: string; status: number }[] = [];

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "iglo-base-records-write-fresh-"));
    roots.push(root);
    const dataDir = join(root, "pb_data");
    const upsert = await runUpstream(
      ["superuser", "upsert", superEmail, freshPassword, "--dir", dataDir],
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
            ...(body === undefined || body instanceof FormData
              ? {}
              : { "content-type": "application/json" }),
          },
          body:
            body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
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
            { identity: email, password: freshPassword },
            "",
          )) as { token: string }
        ).token;

      tokens.set("superuser", await signIn("_superusers", superEmail));

      const collectionIds = new Map<string, string>();
      const readIds = async (): Promise<void> => {
        const list = (await api("GET", "/api/collections?perPage=500")) as {
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

      await api("POST", "/api/collections", membersCollection);
      await readIds();
      for (const col of freshCollections(ids)) {
        await api("POST", "/api/collections", col);
      }
      await readIds();
      for (const col of freshCollections2(ids)) {
        await api("POST", "/api/collections", col);
      }

      for (const { collection, body } of freshRecords()) {
        await api("POST", `/api/collections/${collection}/records`, body);
      }

      // three files of w_types/types1, uploaded by upstream
      const form = new FormData();
      for (const name of typesFiles) {
        form.append("fl", new File([`file ${name}`], name, { type: "text/plain" }));
      }
      const types1 = (await api(
        "PATCH",
        `/api/collections/w_types/records/${rid("types1")}`,
        form,
      )) as { fl: string[] };
      fileNames = types1.fl;

      for (const who of ["alice", "bob", "dave"] as const) {
        tokens.set(who, await signIn("members", members[who].email));
      }
    } finally {
      await builder.stop();
    }

    currentSuperuserToken = tokens.get("superuser") as string;
    pair = await startPair(dataDir);
  }, 300_000);

  // the cases need the stored file names, known once beforeAll ran; the
  // tests are registered with placeholder names and read them at run time
  for (const c of freshCases(typesFiles)) {
    test(`${c.name} (${c.as})`, async () => {
      const actual =
        freshCases(fileNames).find((x) => x.name === c.name && x.as === c.as && x.url === c.url) ??
        c;
      currentSuperuserToken = tokens.get("superuser") as string;
      const result = await runCase(pair, actual, tokens.get(c.as as FreshIdentity) ?? "");
      statuses.push({ name: c.name, status: result.status });
      expect(result.differences).toEqual([]);
    });
  }

  // the rules matrix must not be trivial: each shape allows some writes
  // and, but for the public one, refuses some
  test("every rule shape has allowed and refused writes", () => {
    for (const s of ruleShapes) {
      const shapeStatuses = statuses
        .filter((x) => x.name.startsWith(`${s.shape}: `))
        .map((x) => x.status);
      expect(shapeStatuses.some((status) => status === 200 || status === 204)).toBe(true);
      if (s.shape !== "empty") {
        expect(shapeStatuses.some((status) => status >= 400)).toBe(true);
      }
    }
  });

  test("round trip: upstream reads iglo.base's pb_data back", async () => {
    const token = tokens.get("superuser") as string;
    expect(await roundTrip(pair, token)).toEqual([]);

    // the passwords the cases set sign in on iglo.base's data
    const rtUrl = (servers.at(-1) as UpstreamServer).url;
    for (const p of changedPasswords) {
      const res = await fetch(`${rtUrl}/api/collections/${p.collection}/auth-with-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: p.email, password: p.password }),
      });
      expect(`${p.email}: ${res.status}`).toBe(`${p.email}: 200`);
    }
  }, 60_000);
});

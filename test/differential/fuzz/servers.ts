// The two servers of a fuzz run, each on its own writable copy of upstream's
// fixture, from one temporary directory removed afterwards. Before the copies
// are made, upstream itself sets the rules of a few collections, so that the
// run has null, "", field, relation, @request and @collection list rules, and
// creates the generated collections (data.ts). The fixture's records are
// untouched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fuzzItems, fuzzTags, itemRecords, tagRecords } from "@test/differential/fuzz/data";
import type { Who } from "@test/differential/fuzz/generate";
import { type ApiCollection, buildModel, type Model } from "@test/differential/fuzz/model";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { startServer, type RunningServer } from "@test/support/executable";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

export const listRules: { [collection: string]: string } = {
  // a relation in a rule (the fixture's demo1 has a null rule, which users
  // and clients keep)
  demo1: `rel_many.verified ?= true || rel_one.text != "" || text = "lorem ipsum"`,
  // @collection and @request.query in a rule
  view2: `@collection.demo2.title ?= @request.query.q || state = true`,
  // @request.headers and a modifier in a rule
  numeric_id_view: `@request.headers.x_token = "test" || email:lower ~ "test2"`,
  // a relation of the auth record in a rule
  demo2: `@request.auth.rel.active = true || @request.auth.id = id || active = true`,
};

export type TokenSet = { [K in Who]: string };

export interface FuzzServers {
  upstream: UpstreamServer;
  igloBase: RunningServer;
  tokens: { upstream: TokenSet; igloBase: TokenSet };
  model: Model;
  stop(): Promise<void>;
}

// one fixture record of each identity
const identities: { who: Exclude<Who, "guest">; collection: string; id: string }[] = [
  { who: "users", collection: "users", id: "4q1xlclmfloku33" },
  { who: "clients", collection: "clients", id: "gk390qegs4y47wn" },
  { who: "nologin", collection: "nologin", id: "dc49k6jgejn40h3" },
  { who: "superuser", collection: "_superusers", id: "sywbhecnh46rhm0" },
];

async function getJson(
  url: string,
  authorization: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization, ...(init.body === undefined ? {} : jsonHeader) },
  });
  if (res.status !== 200) {
    throw new Error(`${init.method ?? "GET"} ${url}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const jsonHeader = { "content-type": "application/json" };

// the changes to the source copy, through upstream's API
async function prepareSource(dataDir: string): Promise<void> {
  const server = await startUpstream({ dataDir });
  try {
    const post = (path: string, body: string): Promise<unknown> =>
      getJson(`${server.url}${path}`, superuserToken, { method: "POST", body });
    for (const [name, listRule] of Object.entries(listRules)) {
      await getJson(`${server.url}/api/collections/${name}`, superuserToken, {
        method: "PATCH",
        body: JSON.stringify({ listRule }),
      });
    }
    const tags = (await post("/api/collections", JSON.stringify(fuzzTags))) as { id: string };
    await post("/api/collections", JSON.stringify(fuzzItems(tags.id)));
    for (const body of tagRecords) {
      await post("/api/collections/fuzz_tags/records", body);
    }
    for (const body of itemRecords) {
      await post("/api/collections/fuzz_items/records", body);
    }
    // a relation whose target is gone: the row keeps the deleted id
    await post(
      "/api/sql",
      JSON.stringify({
        query: `UPDATE fuzz_items SET tags = '["missingtag00000"]' WHERE id = 'fuzzitem0000020'`,
      }),
    );
  } finally {
    await server.stop();
  }
}

// impersonate writes nothing, unlike auth-with-password (auth origins)
async function mintTokens(url: string): Promise<TokenSet> {
  const tokens: TokenSet = { guest: "", users: "", clients: "", nologin: "", superuser: "" };
  for (const { who, collection, id } of identities) {
    const res = (await getJson(
      `${url}/api/collections/${collection}/impersonate/${id}`,
      superuserToken,
      { method: "POST" },
    )) as { token: string };
    tokens[who] = res.token;
  }
  return tokens;
}

async function readModel(url: string, token: string): Promise<Model> {
  const list = (await getJson(`${url}/api/collections?perPage=500&sort=name`, token)) as {
    items: ApiCollection[];
  };
  const records = new Map<string, Record<string, unknown>[]>();
  for (const c of list.items) {
    const page = (await getJson(
      `${url}/api/collections/${c.name}/records?perPage=500&sort=id`,
      token,
    )) as { items: Record<string, unknown>[] };
    records.set(c.name, page.items);
  }
  return buildModel(list.items, records);
}

export async function startFuzzServers(): Promise<FuzzServers> {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-fuzz-"));
  const source = join(root, "pb_data");
  const upstreamDir = join(root, "upstream", "pb_data");
  const igloBaseDir = join(root, "iglo-base", "pb_data");
  let started: PromiseSettledResult<UpstreamServer | RunningServer>[] = [];
  const stop = async (): Promise<void> => {
    await Promise.allSettled(
      started.map((s) => (s.status === "fulfilled" ? s.value.stop() : undefined)),
    );
    rmSync(root, { recursive: true, force: true });
  };
  try {
    copyDataDir(fixtureDir, source);
    await prepareSource(source);
    copyDataDir(source, upstreamDir);
    copyDataDir(source, igloBaseDir);
    started = await Promise.allSettled([
      startUpstream({ dataDir: upstreamDir }),
      startServer([], igloBaseDir),
    ]);
    const [upStart, igStart] = started;
    if (upStart?.status !== "fulfilled" || igStart?.status !== "fulfilled") {
      throw new Error("a server failed to start", {
        cause: started.map((s) => (s.status === "rejected" ? s.reason : "started")),
      });
    }
    const upstream = upStart.value as UpstreamServer;
    const igloBase = igStart.value as RunningServer;
    const tokens = {
      upstream: await mintTokens(upstream.url),
      igloBase: await mintTokens(igloBase.url),
    };
    return {
      upstream,
      igloBase,
      tokens,
      model: await readModel(upstream.url, tokens.upstream.superuser),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

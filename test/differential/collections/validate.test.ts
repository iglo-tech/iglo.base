// Collection validation (src/collections/collection-validate.ts) against
// the reference PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// On a fresh upstream install with the collections of validate-cases.ts,
// each case's payload goes to upstream's POST /api/collections or PATCH
// /api/collections/{target}. Before it is sent, the model reads the same
// state from upstream's live pb_data (src/db through a CollectionsApp,
// without the collections cache, which falls back to the database as
// upstream's lookups do before the cache is loaded) and does what
// upstream's handler and save do before validation:
//
//   - create (apis/collection.go collectionCreate): NewCollection(type,
//     name) from the body's type and name, then the body unmarshaled into
//     it; update (collectionUpdate): the stored collection
//     (FindCollectionByNameOrId) with the body unmarshaled into it;
//   - onCollectionSave (src/collections/collection-save.ts): the default
//     type, the default id of a new collection, NewFieldsList over the
//     fields, the default fields, unsetMissingOAuth2MappedFields,
//     updateGeneratedIdIfExists and the index table names;
//
// and then validateCollection. A validation error must give upstream's
// 400 body: `{"data":…,"message":"Failed to create collection.",
// "status":400}` (or "update"). Upstream writes map members in Go's random
// map order (json v2 without Deterministic), so both bodies are compared
// with their object members sorted; every code, message and param is
// compared as it is. No error must mean upstream's 200.
//
// Cases that need the rule check (M2.2) run as test.failing: they pass
// while the model differs and fail once it agrees.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Collection, newCollection } from "@/collections/collection-model";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { onCollectionSave } from "@/collections/collection-save";
import { validateCollection } from "@/collections/collection-validate";
import { decodeString, unmarshalGoStruct } from "@/collections/go-json-struct";
import { newBadRequestError } from "@/server/error";
import { Errors } from "@/validation/error";

import { openDataDir, type TestCollectionsApp } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import {
  type Ctx,
  type ValidateCase,
  setupCollections,
  validateCases,
} from "@test/differential/collections/validate-cases";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

// the hooks start and stop upstream, which is slow on the macOS runners
const hookTimeout = 60_000;

const email = "validate@example.com";
const password = "1234567890";

let root: string | undefined;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;
let app: TestCollectionsApp | undefined;

async function request(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const res = await fetch(`${upstream.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: token },
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

// the current state, read through upstream's GET /api/collections
async function readCtx(): Promise<Ctx> {
  const res = await request("GET", "/api/collections?perPage=500");
  expect(res.status).toBe(200);
  const items = (
    JSON.parse(res.text) as {
      items: { id: string; name: string; fields: Record<string, unknown>[] }[];
    }
  ).items;
  const byName = new Map(items.map((c) => [c.name, c]));
  const get = (name: string) => {
    const c = byName.get(name);
    if (c === undefined) {
      throw new Error(`no collection ${name}`);
    }
    return c;
  };
  return {
    id: (name) => get(name).id,
    fields: (name) => get(name).fields.map((f) => ({ ...f })),
    field: (name, field) => {
      const f = get(name).fields.find((x) => x.name === field);
      if (f === undefined) {
        throw new Error(`no field ${name}.${field}`);
      }
      return { ...f };
    },
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-collections-validate-ref-"));
  dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });
  const res = await fetch(`${upstream.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(res.status).toBe(200);
  token = ((await res.json()) as { token: string }).token;

  // serialized: upstream reloads its collections cache after each save
  for (const setup of setupCollections) {
    const body = JSON.stringify(setup(await readCtx()));
    const created = await request("POST", "/api/collections", body);
    expect({
      body,
      status: created.status,
      text: created.status === 200 ? "" : created.text,
    }).toEqual({ body, status: 200, text: "" });
  }

  app = openDataDir(dataDir);
}, hookTimeout);

afterAll(async () => {
  app?.cleanup();
  await upstream?.stop();
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
  }
}, hookTimeout);

function model(): TestCollectionsApp {
  if (app === undefined) {
    throw new Error("the model app is closed");
  }
  return app;
}

// the model's collection for a case: the handler's collection with the
// body applied
function modelCollection(c: ValidateCase, body: string): Collection {
  if (c.target !== undefined) {
    const collection = findCollectionByNameOrId(model(), c.target);
    collection.unmarshalJSON(body);
    return collection;
  }

  // populate the minimal required factory collection data (if any)
  const factoryExtract = { type: "", name: "" };
  unmarshalGoStruct(
    body,
    {
      type: (raw) => (factoryExtract.type = decodeString(raw)),
      name: (raw) => (factoryExtract.name = decodeString(raw)),
    },
    () => {},
  );

  // create scaffold
  const collection = newCollection(factoryExtract.type, factoryExtract.name);

  // merge the scaffold with the submitted request data
  collection.unmarshalJSON(body);
  return collection;
}

// a JSON value with its object members sorted (Go's map order is random)
function sortedJSON(text: string): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(sort);
    }
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(v).toSorted()) {
        out[key] = sort((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(JSON.parse(text)));
}

interface Outcome {
  status: number;
  body: string;
}

function modelOutcome(c: ValidateCase, body: string): Outcome {
  const collection = modelCollection(c, body);
  onCollectionSave(model(), collection);
  const err = validateCollection(model(), collection);
  if (err === null) {
    return { status: 200, body: "" };
  }
  if (!(err instanceof Errors)) {
    throw err;
  }
  const message =
    c.target === undefined ? "Failed to create collection." : "Failed to update collection.";
  return { status: 400, body: sortedJSON(JSON.stringify(newBadRequestError(message, err))) };
}

const results = { valid: 0, invalid: 0 };

describe("collection validation against upstream", () => {
  for (const c of validateCases) {
    const run = async () => {
      const body = JSON.stringify(c.body(await readCtx()));

      // the model first: upstream's request changes the state
      const got = modelOutcome(c, body);

      const res = await request(
        c.target === undefined ? "POST" : "PATCH",
        c.target === undefined ? "/api/collections" : `/api/collections/${c.target}`,
        body,
      );
      // upstream's outcome is the case's expectation
      expect({ case: c.name, valid: res.status === 200 }).toEqual({ case: c.name, valid: c.valid });
      if (res.status === 200) {
        results.valid++;
      } else {
        expect({ case: c.name, status: res.status, text: res.text }).toEqual({
          case: c.name,
          status: 400,
          text: res.text,
        });
        results.invalid++;
      }

      const expected: Outcome =
        res.status === 200
          ? { status: 200, body: "" }
          : { status: 400, body: sortedJSON(res.text) };
      expect({ case: c.name, payload: body, ...got }).toEqual({
        case: c.name,
        payload: body,
        ...expected,
      });
    };

    if (c.pending === undefined) {
      test(c.name, run);
    } else {
      test.failing(`${c.name} (pending on ${c.pending.task}: ${c.pending.reason})`, run);
    }
  }

  test("at least 80 invalid and 20 valid payloads were sent", () => {
    expect(results.invalid).toBeGreaterThanOrEqual(80);
    expect(results.valid).toBeGreaterThanOrEqual(20);
  });
});

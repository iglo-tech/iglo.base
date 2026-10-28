// The collection model (src/collections) against the reference PocketBase
// v0.41.0 binary. Not part of `bun test`: run `bun run test:reference`.
//
//   - created collections: on a fresh upstream install, the collections in
//     cases.ts are created through POST /api/collections. With upstream
//     stopped, each `_collections` row is read into the model (dbScan,
//     postScan). Its dbExport must give the row's column values (each value
//     as the db driver writes it: FieldsList.value(), the indexes JSON,
//     DateTime.value(), JSONRaw.value(), a Go bool as 1/0), and its JSON
//     must equal upstream's GET /api/collections/{id} body byte for byte
//     (upstream's map members are sorted too: Collection.MarshalJSON is
//     deterministic, so no member order is random here).
//   - minimal creates: NewBaseCollection, NewAuthCollection and
//     NewViewCollection for a name give the same id, fields, indexes and
//     options as upstream's minimal create. The generated values (created,
//     updated, the auth token secrets) are copied from upstream's row. A
//     view's fields are generated from its query on save (M1.7), so only
//     its id, indexes and options are compared.
//   - OAuth2 provider updates: the collections of oauth2UpdateCases are
//     created, their rows read, and then updated through PATCH. Each
//     stored row, with the update unmarshaled into it, must export the
//     updated row and marshal to the updated GET body.
//   - fixture: every `_collections` row of upstream's test fixture, read
//     into the model, marshals to upstream's GET body for it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Collection,
  newAuthCollection,
  newBaseCollection,
  newViewCollection,
} from "@/collections/collection-model";
import { FieldsList } from "@/collections/fields-list";
import { DateTime } from "@/tools/types/datetime";
import { jsonArrayValue } from "@/tools/types/json-array";
import { JSONRaw } from "@/tools/types/json-raw";

import {
  collectionCases,
  minimalCases,
  oauth2UpdateCases,
  oauth2UpdateCreateBody,
  oauth2UpdatePatchBody,
} from "@test/differential/collections/cases";
import {
  copyFixture,
  runUpstream,
  serveUpstream,
  superuserToken,
  type FixtureCopy,
} from "@test/differential/db/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

// the hooks start and stop upstream, which is slow on the macOS runners
const hookTimeout = 60_000;

const email = "collections@example.com";
const password = "1234567890";

let root: string | undefined;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-collections-ref-"));
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
}, hookTimeout);

afterAll(async () => {
  await upstream?.stop();
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
  }
}, hookTimeout);

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

// the column values the db driver writes for dbExport's values
function driverValues(exported: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(exported)) {
    if (v instanceof FieldsList || v instanceof DateTime || v instanceof JSONRaw) {
      out[k] = v.value();
    } else if (Array.isArray(v)) {
      out[k] = jsonArrayValue(v);
    } else if (typeof v === "boolean") {
      out[k] = v ? 1 : 0;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// the model read from a `_collections` row
function modelFromRow(row: Record<string, unknown>): Collection {
  const c = new Collection();
  c.dbScan(row);
  c.postScan();
  return c;
}

function readRows(file: string): Map<string, Record<string, unknown>> {
  // read-write: a read-only connection cannot create the WAL index (-shm)
  // on macOS; this is a temporary copy that no server uses any more
  const db = new Database(file);
  try {
    const rows = db.query("SELECT * FROM _collections").all() as Record<string, unknown>[];
    return new Map(rows.map((r) => [r.id as string, r]));
  } finally {
    db.close();
  }
}

interface Created {
  name: string;
  id: string;
  getBody: string;
}

const created: Created[] = [];
const minimal: Record<"base" | "auth" | "view", Created | undefined> = {
  base: undefined,
  auth: undefined,
  view: undefined,
};

describe("create through upstream", () => {
  const ids = new Map<string, string>();

  test("the users collection id", async () => {
    const res = await request("GET", "/api/collections/users");
    expect(res.status).toBe(200);
    ids.set("users", (JSON.parse(res.text) as { id: string }).id);
  });

  // serialized: upstream reloads its collections cache after each save
  for (const c of collectionCases) {
    test(c.name, async () => {
      const body = c.body
        .replaceAll("$users", ids.get("users") ?? "")
        .replaceAll("$base_all", ids.get("base_all") ?? "");
      const res = await request("POST", "/api/collections", body);
      expect({
        name: c.name,
        status: res.status,
        text: res.status === 200 ? "" : res.text,
      }).toEqual({ name: c.name, status: 200, text: "" });
      const id = (JSON.parse(res.text) as { id: string }).id;
      ids.set(c.name, id);

      const got = await request("GET", `/api/collections/${id}`);
      expect(got.status).toBe(200);
      // the create response is the same model
      expect(got.text).toBe(res.text);
      created.push({ name: c.name, id, getBody: got.text });
    });
  }

  for (const [kind, c] of Object.entries(minimalCases) as [
    keyof typeof minimalCases,
    { name: string; body: string },
  ][]) {
    test(`minimal ${kind}`, async () => {
      const res = await request("POST", "/api/collections", c.body);
      expect({ status: res.status, text: res.status === 200 ? "" : res.text }).toEqual({
        status: 200,
        text: "",
      });
      const id = (JSON.parse(res.text) as { id: string }).id;
      const got = await request("GET", `/api/collections/${id}`);
      expect(got.status).toBe(200);
      minimal[kind] = { name: c.name, id, getBody: got.text };
    });
  }
});

// generated values copied from upstream's row: created, updated and
// (auth) the token secrets
function withGenerated(model: Collection, row: Record<string, unknown>): Collection {
  model.created = (() => {
    const d = new DateTime();
    d.scan(row.created);
    return d;
  })();
  model.updated = (() => {
    const d = new DateTime();
    d.scan(row.updated);
    return d;
  })();
  if (model.isAuth()) {
    const stored = modelFromRow(row);
    model.authToken.secret = stored.authToken.secret;
    model.passwordResetToken.secret = stored.passwordResetToken.secret;
    model.emailChangeToken.secret = stored.emailChangeToken.secret;
    model.verificationToken.secret = stored.verificationToken.secret;
    model.fileToken.secret = stored.fileToken.secret;
  }
  return model;
}

describe("stored _collections rows", () => {
  let rows: Map<string, Record<string, unknown>>;

  beforeAll(async () => {
    await upstream?.stop();
    upstream = undefined;
    rows = readRows(join(dataDir, "data.db"));
  }, hookTimeout);

  test("enough collections were created", () => {
    expect(created.length).toBe(collectionCases.length);
    expect(created.length).toBeGreaterThanOrEqual(20);
  });

  test("each row exports its column values and marshals to the GET body", () => {
    for (const c of created) {
      const row = rows.get(c.id);
      expect(row).toBeDefined();
      const model = modelFromRow(row as Record<string, unknown>);
      expect({ name: c.name, columns: driverValues(model.dbExport()) }).toEqual({
        name: c.name,
        columns: row as Record<string, unknown>,
      });
      expect({ name: c.name, body: model.string() }).toEqual({ name: c.name, body: c.getBody });
    }
  });

  test("the other rows of the fresh install read back too", () => {
    for (const row of rows.values()) {
      const model = modelFromRow(row);
      expect({ name: row.name, columns: driverValues(model.dbExport()) }).toEqual({
        name: row.name,
        columns: row,
      });
    }
  });

  test("NewBaseCollection matches a minimal create", () => {
    const m = minimal.base as Created;
    const row = rows.get(m.id) as Record<string, unknown>;
    const model = withGenerated(newBaseCollection(m.name), row);
    expect(model.id).toBe(m.id);
    expect(driverValues(model.dbExport())).toEqual(row);
    expect(model.string()).toBe(m.getBody);
  });

  test("NewAuthCollection matches a minimal create", () => {
    const m = minimal.auth as Created;
    const row = rows.get(m.id) as Record<string, unknown>;
    const model = withGenerated(newAuthCollection(m.name), row);
    expect(model.id).toBe(m.id);
    expect(driverValues(model.dbExport())).toEqual(row);
    expect(model.string()).toBe(m.getBody);
  });

  test("NewViewCollection matches a minimal create (id, indexes, options)", () => {
    const m = minimal.view as Created;
    const row = rows.get(m.id) as Record<string, unknown>;
    const model = withGenerated(newViewCollection(m.name), row);
    model.viewQuery = minimalCases.view.query;
    expect(model.id).toBe(m.id);
    const columns = driverValues(model.dbExport());
    expect({ id: columns.id, indexes: columns.indexes, options: columns.options }).toEqual({
      id: row.id,
      indexes: row.indexes,
      options: row.options,
    });
  });
});

describe("OAuth2 provider updates through upstream", () => {
  interface Updated {
    name: string;
    id: string;
    status: number;
    patchBody: string;
    getBody: string;
  }
  const updated: Updated[] = [];
  let before: Map<string, Record<string, unknown>>;
  let after: Map<string, Record<string, unknown>>;

  beforeAll(async () => {
    upstream = await startUpstream({ dataDir });
    const ids = new Map<string, string>();
    for (const c of oauth2UpdateCases) {
      const res = await request("POST", "/api/collections", oauth2UpdateCreateBody(c));
      expect({
        name: c.name,
        status: res.status,
        text: res.status === 200 ? "" : res.text,
      }).toEqual({ name: c.name, status: 200, text: "" });
      ids.set(c.name, (JSON.parse(res.text) as { id: string }).id);
    }
    await upstream.stop();
    upstream = undefined;
    before = readRows(join(dataDir, "data.db"));

    upstream = await startUpstream({ dataDir });
    for (const c of oauth2UpdateCases) {
      const id = ids.get(c.name) ?? "";
      const res = await request("PATCH", `/api/collections/${id}`, oauth2UpdatePatchBody(c));
      const got = await request("GET", `/api/collections/${id}`);
      expect(got.status).toBe(200);
      updated.push({
        name: c.name,
        id,
        status: res.status,
        patchBody: res.text,
        getBody: got.text,
      });
    }
    await upstream.stop();
    upstream = undefined;
    after = readRows(join(dataDir, "data.db"));
  }, hookTimeout);

  test("upstream accepts every update with the expected PKCE values", () => {
    expect(updated.length).toBe(oauth2UpdateCases.length);
    for (const [i, c] of oauth2UpdateCases.entries()) {
      const u = updated[i] as Updated;
      const providers = (JSON.parse(u.getBody) as { oauth2: { providers: { pkce: unknown }[] } })
        .oauth2.providers;
      expect({ name: c.name, status: u.status, pkce: providers.map((p) => p.pkce) }).toEqual({
        name: c.name,
        status: 200,
        pkce: c.pkce,
      });
      // the update response is the same model
      expect({ name: c.name, body: u.patchBody }).toEqual({ name: c.name, body: u.getBody });
    }
  });

  test("the update unmarshaled into the stored row gives the updated row and GET body", () => {
    for (const [i, c] of oauth2UpdateCases.entries()) {
      const u = updated[i] as Updated;
      const model = modelFromRow(before.get(u.id) as Record<string, unknown>);
      model.unmarshalJSON(oauth2UpdatePatchBody(c));
      const row = after.get(u.id) as Record<string, unknown>;
      withGenerated(model, row);
      expect({ name: c.name, columns: driverValues(model.dbExport()) }).toEqual({
        name: c.name,
        columns: row,
      });
      expect({ name: c.name, body: model.string() }).toEqual({ name: c.name, body: u.getBody });
    }
  });
});

describe("upstream's test fixture", () => {
  let copy: FixtureCopy | undefined;
  const bodies = new Map<string, string>();

  beforeAll(async () => {
    const fixture = copyFixture();
    copy = fixture;
    const server = await serveUpstream(fixture);
    try {
      const list = await fetch(`${server.url}/api/collections?perPage=500`, {
        headers: { Authorization: superuserToken },
      });
      expect(list.status).toBe(200);
      const items = ((await list.json()) as { items: { id: string }[] }).items;
      for (const { id } of items) {
        const res = await fetch(`${server.url}/api/collections/${id}`, {
          headers: { Authorization: superuserToken },
        });
        expect(res.status).toBe(200);
        bodies.set(id, await res.text());
      }
    } finally {
      await server.stop();
    }
  }, hookTimeout);

  afterAll(() => {
    if (copy !== undefined) {
      rmSync(copy.root, { recursive: true, force: true });
    }
  });

  test("every row marshals to upstream's GET body", () => {
    const rows = readRows(join((copy as FixtureCopy).dataDir, "data.db"));
    expect(rows.size).toBe(bodies.size);
    expect(rows.size).toBeGreaterThan(10);
    for (const [id, row] of rows) {
      expect({ id, body: modelFromRow(row).string() }).toEqual({ id, body: bodies.get(id) ?? "" });
    }
  });
});

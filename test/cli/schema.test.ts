// The schema command (D40, issue #77) through the compiled executable: the
// help, the embedded JSON Schema, `schema pull` on the fixtures and on a
// database built through the collections API. The file is checked against
// the published JSON Schema, read back with the reader, and compared with
// what GET /api/collections returns (ids, timestamps and OAuth2 providers
// taken out, relation targets by name, view fields left out).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020";

import { readSchema } from "@/schema/read";
import type { SchemaCollection, SchemaDescription, SchemaField } from "@/schema/types";
import { run, startServer, tempDir } from "@test/support/executable";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

const schemaPath = resolve(import.meta.dir, "../../schema/iglo.schema.json");
const schemaJSON = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schemaJSON);

const superuser = { email: "admin@schema.test", password: "1234567890" };

function copyOf(source: string): string {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(source, dataDir);
  return dataDir;
}

// the pulled file, parsed, after validating it against the published schema
async function pull(dataDir: string, ...extra: string[]): Promise<{ text: string; file: object }> {
  const result = await run(["--dir", dataDir, "schema", "pull", ...extra]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return { text: result.stdout, file: JSON.parse(result.stdout) as object };
}

function assertValid(file: object): void {
  const ok = validate(file);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

// the collections of GET /api/collections, in the shape of the schema file's
// description: no ids, timestamps or providers; rules nested; relations by name
interface ApiCollection {
  id: string;
  name: string;
  type: string;
  system: boolean;
  fields?: Record<string, unknown>[];
  indexes?: string[];
  viewQuery?: string;
  oauth2?: { providers?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

const ruleNames: Record<string, string> = {
  listRule: "list",
  viewRule: "view",
  createRule: "create",
  updateRule: "update",
  deleteRule: "delete",
  authRule: "auth",
  manageRule: "manage",
};

function normalize(apiCollections: ApiCollection[]): SchemaCollection[] {
  const names = new Map(apiCollections.map((item) => [item.id, item.name]));
  return apiCollections
    .map((item): SchemaCollection => {
      const rules: Record<string, string | null> = {};
      const options: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(item)) {
        if (key in ruleNames) {
          rules[ruleNames[key] as string] = value as string | null;
        } else if (
          ![
            "id",
            "created",
            "updated",
            "name",
            "type",
            "system",
            "fields",
            "indexes",
            "viewQuery",
          ].includes(key)
        ) {
          options[key] = value;
        }
      }
      if (isObject(options.oauth2)) {
        const { providers: _providers, ...rest } = options.oauth2 as Record<string, unknown>;
        options.oauth2 = rest;
      }
      const fields: SchemaField[] =
        item.type === "view"
          ? []
          : (item.fields ?? []).map((field) => {
              const {
                id: _id,
                name,
                type,
                system,
                collectionId,
                ...rest
              } = field as Record<string, unknown>;
              const fieldOptions: Record<string, unknown> = { ...rest };
              if (collectionId !== undefined) {
                fieldOptions.collection = names.get(collectionId as string) ?? "";
              }
              return { name, type, system, options: fieldOptions } as unknown as SchemaField;
            });
      const collection = {
        name: item.name,
        type: item.type,
        system: item.system,
        rules,
        indexes: item.indexes ?? [],
        fields,
        options,
      } as unknown as SchemaCollection;
      if (item.type === "view") {
        collection.query = item.viewQuery;
      }
      return collection;
    })
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// the file read back, as the description it describes
function readBack(text: string): SchemaDescription {
  const result = readSchema(text);
  if (!result.ok) {
    throw new Error(`the pulled file is refused: ${JSON.stringify(result.errors)}`);
  }
  return result.schema;
}

// the description's collections without the extra keys the file does not
// hold (the pull writes none, so none is there)
function comparable(collections: SchemaCollection[]): SchemaCollection[] {
  return collections.map((item) => {
    const { description: _description, ...rest } = item;
    return {
      ...rest,
      fields: rest.fields.map((field) => {
        const { description: _d, tsType: _t, ...fieldRest } = field;
        return fieldRest as SchemaField;
      }),
    };
  });
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: superuser.email, password: superuser.password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function api(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
}

async function withServer<T>(dataDir: string, fn: (url: string) => Promise<T>): Promise<T> {
  const server = await startServer([], dataDir);
  try {
    return await fn(server.url);
  } finally {
    await server.stop();
  }
}

// a superuser added to a data directory (created when it does not exist)
async function withSuperuser(dataDir: string): Promise<string> {
  const created = await run([
    "--dir",
    dataDir,
    "superuser",
    "upsert",
    superuser.email,
    superuser.password,
  ]);
  expect(created.exitCode).toBe(0);
  return dataDir;
}

describe("schema command", () => {
  test("help lists the subcommands", async () => {
    const result = await run(["schema", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith(
      "Manage the schema file (schema as code)\n\nUsage:\n  iglo-base schema [command]\n\nAvailable Commands:\n  json-schema ",
    );
    expect(result.stdout).toContain("\n  pull        Writes the schema file from the database\n");
  });

  test("pull --help shows the flags", async () => {
    const result = await run(["schema", "pull", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--out string");
  });

  test("an unknown subcommand is an error", async () => {
    const result = await run(["schema", "apply"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command "apply" for "iglo-base schema"');
  });

  test("json-schema prints the JSON Schema this build embeds", async () => {
    const result = await run(["schema", "json-schema"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(schemaJSON);
  });

  test("pull on the fixture writes a file that validates, reads back, and is stable", async () => {
    const dataDir = copyOf(fixtureDir);
    const first = await pull(dataDir);
    assertValid(first.file);
    expect(first.text.endsWith("}\n")).toBe(true);
    expect((first.file as { $schema: string }).$schema).toMatch(
      /^https:\/\/github\.com\/iglo-tech\/iglo\.base\/releases\/.*\/iglo\.schema\.json$/,
    );
    const second = await pull(dataDir);
    expect(second.text).toBe(first.text);
  });

  test("pull --out writes the file and keeps the descriptions of an existing file", async () => {
    const dataDir = copyOf(fixtureDir);
    const out = join(tempDir(), "iglo.schema.json");
    const plain = await run(["--dir", dataDir, "schema", "pull", "--out", out]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toBe("");
    const written = readFileSync(out, "utf8");
    assertValid(JSON.parse(written));

    // a description and a tsType written by hand survive the next pull
    const edited = JSON.parse(written) as {
      collections: Record<string, { description?: string; fields?: Record<string, object> }>;
    };
    const demo = edited.collections.demo1;
    if (demo === undefined) {
      throw new Error("the fixture has no demo1 collection");
    }
    demo.description = "Demo records";
    const jsonField = Object.entries(demo.fields ?? {}).find(
      ([, field]) => (field as { type: string }).type === "json",
    );
    if (jsonField !== undefined) {
      (jsonField[1] as { tsType?: string }).tsType = "{ note: string }";
    }
    await Bun.write(out, JSON.stringify(edited, null, 2) + "\n");

    expect((await run(["--dir", dataDir, "schema", "pull", "--out", out])).exitCode).toBe(0);
    const again = JSON.parse(readFileSync(out, "utf8")) as typeof edited;
    const kept = again.collections.demo1;
    expect(kept?.description).toBe("Demo records");
    if (jsonField !== undefined) {
      const fields = (kept?.fields ?? {}) as Record<string, { tsType?: string }>;
      expect(fields[jsonField[0]]?.tsType).toBe("{ note: string }");
    }
  });

  test("a pull over a file that is not JSON stops and leaves the file alone", async () => {
    const dataDir = copyOf(fixtureDir);
    const out = join(tempDir(), "iglo.schema.json");
    await Bun.write(out, '{"collections": ');
    const result = await run(["--dir", dataDir, "schema", "pull", "--out", out]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot keep the descriptions");
    expect(readFileSync(out, "utf8")).toBe('{"collections": ');
    expect(existsSync(out)).toBe(true);
  });

  test("the fixture's collections are the ones GET /api/collections returns", async () => {
    const dataDir = await withSuperuser(copyOf(fixtureDir));
    const { file, text } = await pull(dataDir);
    assertValid(file);
    const description = readBack(text);
    await withServer(dataDir, async (url) => {
      const token = await login(url);
      const listed = await api(url, token, "GET", "/api/collections?perPage=500");
      const items = (listed.json as { items: ApiCollection[] }).items;
      expect(comparable(description.collections)).toEqual(normalize(items));
    });
  });

  test("a database built through the API reads back the same, and follows a reorder", async () => {
    // a new database, so that the system collections are the defaults
    const dataDir = await withSuperuser(join(tempDir(), "pb_data"));
    await withServer(dataDir, async (url) => {
      const token = await login(url);
      const list = (await api(url, token, "GET", "/api/collections?perPage=500")).json as {
        items: ApiCollection[];
      };
      const users = list.items.find((item) => item.name === "users");
      expect(users).toBeDefined();

      const everything = await api(url, token, "POST", "/api/collections", {
        name: "everything",
        type: "base",
        listRule: "",
        viewRule: "",
        indexes: ["CREATE INDEX `idx_everything_status` ON `everything` (`status`)"],
        fields: [
          {
            name: "title",
            type: "text",
            required: true,
            min: 1,
            max: 120,
            presentable: true,
            help: "The title",
          },
          { name: "body", type: "editor", maxSize: 5000, convertURLs: true },
          { name: "score", type: "number", min: 0, max: 100, onlyInt: true },
          { name: "published", type: "bool" },
          { name: "contact", type: "email", onlyDomains: ["example.com"] },
          { name: "site", type: "url", exceptDomains: ["bad.example"] },
          { name: "due", type: "date", min: "2020-01-01 00:00:00.000Z" },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
          { name: "status", type: "select", values: ["draft", "live"], maxSelect: 1 },
          { name: "meta", type: "json", maxSize: 2000 },
          { name: "place", type: "geoPoint" },
          {
            name: "author",
            type: "relation",
            collectionId: users?.id,
            maxSelect: 1,
            cascadeDelete: true,
          },
          {
            name: "cover",
            type: "file",
            maxSelect: 1,
            mimeTypes: ["image/png"],
            thumbs: ["100x100"],
            protected: true,
            maxSize: 1000000,
          },
          { name: "secret_code", type: "password", min: 8, cost: 10 },
        ],
      });
      expect(everything.status).toBe(200);

      const accounts = await api(url, token, "POST", "/api/collections", {
        name: "accounts",
        type: "auth",
        fields: [{ name: "nickname", type: "text", max: 40 }],
        passwordAuth: { enabled: true, identityFields: ["email"] },
        otp: { enabled: true, duration: 300, length: 6 },
        mfa: { enabled: true, duration: 600 },
        authToken: { duration: 1800 },
        verificationTemplate: { subject: "Confirm {APP_NAME}", body: "<p>Hi</p>" },
        oauth2: { enabled: false, mappedFields: { name: "nickname" } },
      });
      expect(accounts.status).toBe(200);

      const digest = await api(url, token, "POST", "/api/collections", {
        name: "digest",
        type: "view",
        listRule: null,
        viewQuery: "SELECT id, email FROM users",
      });
      expect(digest.status).toBe(200);

      const superusers = await api(url, token, "PATCH", "/api/collections/_superusers", {
        authToken: { duration: 3600 },
      });
      expect(superusers.status).toBe(200);
    });

    const first = await pull(dataDir);
    assertValid(first.file);
    const collections = (first.file as { collections: Record<string, Record<string, unknown>> })
      .collections;
    expect(collections["_superusers"]).toEqual({ type: "auth", authToken: { duration: 3600 } });
    expect(collections.digest).toEqual({
      type: "view",
      query: "SELECT id, email FROM users",
    });
    expect(collections.everything?.fields).toMatchObject({
      author: { type: "relation", collection: "users", maxSelect: 1, cascadeDelete: true },
    });
    expect(Object.keys(collections.accounts as object)).toContain("otp");

    await withServer(dataDir, async (url) => {
      const token = await login(url);
      const listed = await api(url, token, "GET", "/api/collections?perPage=500");
      expect(comparable(readBack(first.text).collections)).toEqual(
        normalize((listed.json as { items: ApiCollection[] }).items),
      );
    });

    // move the title to the end of the user fields: the file follows
    await withServer(dataDir, async (url) => {
      const token = await login(url);
      const listed = (await api(url, token, "GET", "/api/collections?perPage=500")).json as {
        items: ApiCollection[];
      };
      const everything = listed.items.find((item) => item.name === "everything");
      const fields = everything?.fields ?? [];
      const title = fields.find((field) => field.name === "title");
      const rest = fields.filter((field) => field !== title);
      const reordered = await api(url, token, "PATCH", `/api/collections/${everything?.id}`, {
        fields: [...rest, title],
      });
      expect(reordered.status).toBe(200);
    });
    const after = await pull(dataDir);
    assertValid(after.file);
    const names = Object.keys(
      (after.file as { collections: Record<string, { fields: object }> }).collections.everything!
        .fields,
    );
    expect(names[names.length - 1]).toBe("title");
    expect(names.indexOf("body")).toBeLessThan(names.indexOf("title"));
    expect(after.text).not.toBe(first.text);
    expect((await pull(dataDir)).text).toBe(after.text);
  });
});

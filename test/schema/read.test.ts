// The reader of the schema file (D40): the description it gives for a file,
// and the errors it gives for a file that is not one. Through readSchema
// only, as the CLI and the apply use it.

import { describe, expect, test } from "bun:test";

import { readSchema, type SchemaIssue } from "@/schema/read";
import type { SchemaCollection, SchemaDescription } from "@/schema/types";

const url = "https://github.com/iglo-tech/iglo.base/releases/latest/download/iglo.schema.json";

function file(collections: unknown): string {
  return JSON.stringify({ $schema: url, collections }, null, 2);
}

function errorsOf(text: string): SchemaIssue[] {
  const result = readSchema(text);
  if (result.ok) {
    throw new Error("expected the file to be refused");
  }
  return result.errors;
}

// the errors of a file with one collection and one field, as "path: message"
function fieldErrors(field: unknown): string[] {
  return errorsOf(file({ posts: { type: "base", fields: { title: field } } })).map(
    (issue) => `${issue.path}: ${issue.message}`,
  );
}

function schemaOf(text: string): SchemaDescription {
  const result = readSchema(text);
  if (!result.ok) {
    throw new Error(`the file was refused: ${JSON.stringify(result.errors)}`);
  }
  return result.schema;
}

function collection(schema: SchemaDescription, name: string): SchemaCollection {
  const found = schema.collections.find((item) => item.name === name);
  if (found === undefined) {
    throw new Error(`no collection ${name}`);
  }
  return found;
}

describe("reading a valid file", () => {
  test("restores the defaults, the system collections and the system fields", () => {
    const schema = schemaOf(
      file({
        posts: {
          type: "base",
          fields: { title: { type: "text", required: true, max: 120 } },
        },
      }),
    );

    expect(schema.collections.map((item) => item.name)).toEqual([
      "_authOrigins",
      "_externalAuths",
      "_mfas",
      "_otps",
      "_superusers",
      "posts",
    ]);

    const posts = collection(schema, "posts");
    expect(posts.type).toBe("base");
    expect(posts.system).toBe(false);
    expect(posts.indexes).toEqual([]);
    expect(posts.rules).toEqual({
      list: null,
      view: null,
      create: null,
      update: null,
      delete: null,
    });
    expect(posts.fields.map((field) => field.name)).toEqual(["id", "title"]);

    const id = posts.fields[0];
    expect(id?.system).toBe(true);
    expect(id?.options.primaryKey).toBe(true);

    const title = posts.fields[1];
    expect(title?.system).toBe(false);
    expect(title?.options).toMatchObject({ required: true, max: 120, min: 0, pattern: "" });
  });

  test("keeps the order of the fields and restores the auth options", () => {
    const schema = schemaOf(
      file({
        members: {
          type: "auth",
          fields: {
            zeta: { type: "text" },
            alpha: { type: "number", min: 1 },
          },
          passwordAuth: { identityFields: ["email", "members_name"] },
        },
      }),
    );
    const members = collection(schema, "members");
    expect(members.fields.map((field) => field.name)).toEqual([
      "id",
      "password",
      "tokenKey",
      "email",
      "emailVisibility",
      "verified",
      "zeta",
      "alpha",
    ]);
    expect(members.options.passwordAuth).toEqual({
      enabled: true,
      identityFields: ["email", "members_name"],
    });
    expect(members.options.authToken).toEqual({ duration: 432000 });
    // the email template keeps the default body it does not change
    expect(members.options.otp).toMatchObject({ enabled: false, duration: 180, length: 8 });
  });

  test("reads a relation by the name of its target and a view by its query", () => {
    const schema = schemaOf(
      file({
        authors: { type: "base" },
        posts: {
          type: "base",
          fields: { author: { type: "relation", collection: "authors", maxSelect: 1 } },
        },
        summaries: { type: "view", query: "SELECT id FROM posts" },
      }),
    );
    const posts = collection(schema, "posts");
    expect(posts.fields[1]?.options).toMatchObject({
      collection: "authors",
      maxSelect: 1,
      cascadeDelete: false,
    });
    const summaries = collection(schema, "summaries");
    expect(summaries.query).toBe("SELECT id FROM posts");
    expect(summaries.fields).toEqual([]);
  });

  test("keeps the descriptions for editors and generated types", () => {
    const schema = schemaOf(
      file({
        posts: {
          type: "base",
          description: "Blog posts",
          fields: { tags: { type: "json", tsType: "{ tags: string[] }", description: "Labels" } },
        },
      }),
    );
    const posts = collection(schema, "posts");
    expect(posts.description).toBe("Blog posts");
    expect(posts.fields[1]).toMatchObject({ tsType: "{ tags: string[] }", description: "Labels" });
  });

  test("a missing system field is added first, in its default order", () => {
    const schema = schemaOf(
      file({
        members: {
          type: "auth",
          fields: { email: { type: "email", required: false } },
        },
      }),
    );
    // the file keeps the email field it lists, and the others come first
    expect(collection(schema, "members").fields.map((field) => field.name)).toEqual([
      "id",
      "password",
      "tokenKey",
      "emailVisibility",
      "verified",
      "email",
    ]);
  });

  test("keeps the system flag of a collection that is not a builtin one", () => {
    const schema = schemaOf(
      file({ nologin: { type: "base", system: true, fields: { note: { type: "text" } } } }),
    );
    expect(collection(schema, "nologin").system).toBe(true);
    expect(collection(schema, "_mfas").system).toBe(true);
  });

  test("a system collection that the file leaves out is its default", () => {
    const schema = schemaOf(file({}));
    const superusers = collection(schema, "_superusers");
    expect(superusers.system).toBe(true);
    expect(superusers.type).toBe("auth");
    expect(superusers.options.authToken).toEqual({ duration: 86400 });
  });
});

describe("reading an invalid file", () => {
  test("reports invalid JSON with its line and column", () => {
    const issues = errorsOf('{\n  "collections": {\n    "posts": {,\n  }\n}');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("$");
    expect(issues[0]?.message).toStartWith("not valid JSON: line 3, column 15");
  });

  test("reports a field of an unknown type by its path", () => {
    expect(fieldErrors({ type: "geo" })).toEqual([
      '$.collections.posts.fields.title.type: unknown field type "geo"',
    ]);
  });

  test("reports an unknown option by its path", () => {
    expect(fieldErrors({ type: "text", maxLength: 3 })).toEqual([
      "$.collections.posts.fields.title.maxLength: unknown option for a text field",
    ]);
  });

  test("reports an option of the wrong type by its path", () => {
    expect(fieldErrors({ type: "text", max: "3" })).toEqual([
      "$.collections.posts.fields.title.max: must be a whole number",
    ]);
    expect(fieldErrors({ type: "bool", required: "yes" })).toEqual([
      "$.collections.posts.fields.title.required: must be true or false",
    ]);
  });

  test("reports a relation to a collection the file does not have", () => {
    expect(
      errorsOf(
        file({
          posts: {
            type: "base",
            fields: { author: { type: "relation", collection: "authors" } },
          },
        }),
      ).map((issue) => issue.path),
    ).toEqual(["$.collections.posts.fields.author.collection"]);
  });

  test("reports a duplicate field name by its path", () => {
    const text = `{"collections":{"posts":{"type":"base","fields":{"title":{"type":"text"},"title":{"type":"bool"}}}}}`;
    expect(errorsOf(text)).toEqual([
      {
        path: "$.collections.posts.fields.title",
        message: 'duplicate field name "title"',
      },
    ]);
  });

  test("reports a duplicate collection name by its path", () => {
    const text = `{"collections":{"posts":{"type":"base"},"posts":{"type":"base"}}}`;
    expect(errorsOf(text)).toEqual([
      {
        path: "$.collections.posts",
        message: 'duplicate collection name "posts"',
      },
    ]);
  });

  test("refuses a token secret and a plain OAuth2 secret", () => {
    const issues = errorsOf(
      file({
        members: {
          type: "auth",
          authToken: { duration: 3600, secret: "s3cret" },
          oauth2: {
            enabled: true,
            providers: [{ name: "github", clientId: "id", clientSecret: "plain" }],
          },
        },
      }),
    ).map((issue) => `${issue.path}: ${issue.message}`);
    expect(issues).toEqual([
      "$.collections.members.authToken.secret: token secrets are not written in the schema file; remove this property",
      '$.collections.members.oauth2.providers[0].clientSecret: a plain secret is refused: the file holds the variable that holds it, as {"env": "NAME"}',
    ]);
  });

  test("refuses names that are only digits, because their order is lost", () => {
    expect(errorsOf(file({ "2026": { type: "base" } })).map((issue) => issue.path)).toEqual([
      '$.collections["2026"]',
    ]);
    expect(
      errorsOf(file({ posts: { type: "base", fields: { 42: { type: "text" } } } })).map(
        (issue) => issue.path,
      ),
    ).toEqual(['$.collections.posts.fields["42"]']);
  });

  test("refuses a tsType on a field that is not json, and the system flag", () => {
    expect(fieldErrors({ type: "text", tsType: "string" })).toEqual([
      "$.collections.posts.fields.title.tsType: tsType is only for json fields",
    ]);
    expect(fieldErrors({ type: "text", system: true })).toEqual([
      "$.collections.posts.fields.title.system: is not written in the file (system is implied)",
    ]);
  });

  test("refuses ids in the file", () => {
    expect(fieldErrors({ type: "text", id: "text123" })).toEqual([
      "$.collections.posts.fields.title.id: is not written in the file (id is implied)",
    ]);
  });

  test("refuses fields of a view and a query on a base collection", () => {
    expect(
      errorsOf(file({ shown: { type: "view", query: "SELECT 1", fields: {} } })).map(
        (issue) => issue.path,
      ),
    ).toEqual(["$.collections.shown.fields"]);
    expect(
      errorsOf(file({ posts: { type: "base", query: "SELECT 1" } })).map((issue) => issue.path),
    ).toEqual(["$.collections.posts.query"]);
  });

  test("refuses a system collection of the wrong type", () => {
    expect(errorsOf(file({ _superusers: { type: "base" } })).map((issue) => issue.path)).toEqual([
      "$.collections._superusers.type",
    ]);
  });

  test("refuses a system field of the wrong type", () => {
    expect(
      errorsOf(file({ members: { type: "auth", fields: { email: { type: "text" } } } })).map(
        (issue) => issue.path,
      ),
    ).toEqual(["$.collections.members.fields.email.type"]);
  });

  test("refuses an unknown rule and a rule that is not text", () => {
    expect(
      errorsOf(file({ posts: { type: "base", rules: { list: "", read: "", view: 3 } } })).map(
        (issue) => `${issue.path}: ${issue.message}`,
      ),
    ).toEqual([
      "$.collections.posts.rules.read: unknown rule (rules are list, view, create, update, delete, and auth and manage on auth collections)",
      "$.collections.posts.rules.view: must be a string or null",
    ]);
  });

  test("refuses a missing collections property and a missing type", () => {
    expect(errorsOf("{}").map((issue) => issue.path)).toEqual(["$.collections"]);
    expect(
      errorsOf(file({ posts: { fields: {} } })).map((issue) => `${issue.path}: ${issue.message}`),
    ).toEqual(['$.collections.posts: is missing "type" (one of base, auth, view)']);
  });
});

describe("names that are array indexes", () => {
  test("refuses the whole numbers that JSON objects order first, for collections and fields", () => {
    for (const name of ["0", "12", "2026", "4294967294"]) {
      expect(errorsOf(file({ [name]: { type: "base" } })).map((issue) => issue.path)).toEqual([
        `$.collections["${name}"]`,
      ]);
      expect(
        errorsOf(file({ posts: { type: "base", fields: { [name]: { type: "text" } } } })).map(
          (issue) => issue.path,
        ),
      ).toEqual([`$.collections.posts.fields["${name}"]`]);
    }
  });

  test("accepts other digit names, and keeps the order of the fields", () => {
    const schema = schemaOf(
      file({
        posts: {
          type: "base",
          fields: {
            title: { type: "text" },
            "01": { type: "text" },
            "007": { type: "text" },
            "4294967295": { type: "text" },
          },
        },
        "01": { type: "base" },
      }),
    );
    expect(collection(schema, "posts").fields.map((field) => field.name)).toEqual([
      "id",
      "title",
      "01",
      "007",
      "4294967295",
    ]);
    expect(schema.collections.map((item) => item.name)).toContain("01");
  });
});

describe("a block means the same schema under any collection name", () => {
  test("users and another auth collection get the same defaults for the same block", () => {
    const block = {
      type: "auth",
      fields: {
        name: { type: "text" },
        avatar: { type: "file" },
        created: { type: "autodate" },
        updated: { type: "autodate" },
      },
    };
    const schema = schemaOf(file({ users: block, accounts: block }));
    const { name: _usersName, ...users } = collection(schema, "users");
    const { name: _accountsName, ...accounts } = collection(schema, "accounts");
    expect(users).toEqual(accounts);
    // the factory defaults of an auth collection, not the fresh install's users
    expect(users.rules).toEqual({
      list: null,
      view: null,
      create: null,
      update: null,
      delete: null,
      auth: "",
      manage: null,
    });
    // a plain file field has no limit; the fresh install's avatar limit is not a default
    expect(users.fields.find((field) => field.name === "avatar")?.options.maxSelect).toBe(0);
    expect(users.indexes).toEqual([]);
  });
});

// The text of the schema file (D40): what is left out, the order of keys
// and fields, the extra keys a pull keeps, and that a file reads back as the
// description it was written from. Through readSchema, formatSchema and
// extractExtras, the functions the CLI uses.

import { describe, expect, test } from "bun:test";

import { readSchema } from "@/schema/read";
import { extractExtras, formatSchema } from "@/schema/write";
import type { SchemaDescription } from "@/schema/types";

const url = "https://github.com/iglo-tech/iglo.base/releases/download/v1.2.3/iglo.schema.json";

function format(description: SchemaDescription, extras?: ReturnType<typeof extractExtras>): string {
  return formatSchema(description, { schemaURL: url, extras });
}

function read(text: string): SchemaDescription {
  const result = readSchema(text);
  if (!result.ok) {
    throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  }
  return result.schema;
}

// the file a canonical description is written as: two spaces, final newline
function canonical(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

describe("writing a schema file", () => {
  test("leaves out the defaults, the system collections and the implied fields", () => {
    const text = canonical({
      $schema: url,
      collections: {
        posts: {
          type: "base",
          fields: {
            title: { type: "text", required: true },
          },
        },
      },
    });
    expect(format(read(text))).toBe(text);
  });

  test("reads back as the description it was written from", () => {
    const text = canonical({
      $schema: url,
      collections: {
        members: {
          type: "auth",
          rules: { list: "id = @request.auth.id", create: "" },
          indexes: [],
          fields: {
            nickname: { type: "text", max: 40 },
            avatar: { type: "file", maxSelect: 1, mimeTypes: ["image/png"] },
          },
          passwordAuth: { identityFields: ["email", "nickname"] },
          oauth2: { enabled: true, mappedFields: { name: "nickname" } },
        },
      },
    });
    const description = read(text);
    const written = format(description);
    // no indexes: the empty list is the default, and the implied indexes of an
    // auth collection are not written
    expect(JSON.parse(written).collections.members).toEqual({
      type: "auth",
      rules: { list: "id = @request.auth.id", create: "" },
      fields: {
        nickname: { type: "text", max: 40 },
        avatar: { type: "file", maxSelect: 1, mimeTypes: ["image/png"] },
      },
      passwordAuth: { identityFields: ["email", "nickname"] },
      oauth2: { enabled: true, mappedFields: { name: "nickname" } },
    });
    expect(read(written)).toEqual(description);
  });

  test("keeps the order of the fields, and writes the system fields that moved", () => {
    const description = read(
      canonical({
        collections: {
          members: {
            type: "auth",
            fields: {
              title: { type: "text" },
              email: { type: "email", required: false },
            },
          },
        },
      }),
    );
    const written = format(description);
    const fields = JSON.parse(written).collections.members.fields;
    // the implied system fields are not written; the ones after the moved
    // email are, so that their order is kept
    expect(Object.keys(fields)).toEqual(["emailVisibility", "verified", "title", "email"]);
    expect(read(written)).toEqual(description);
  });

  test("writes a system collection that changed, with its changed option only", () => {
    const text = canonical({
      collections: {
        _superusers: {
          type: "auth",
          authToken: { duration: 3600 },
        },
      },
    });
    const parsed = JSON.parse(format(read(text)));
    expect(parsed.collections).toEqual({
      _superusers: { type: "auth", authToken: { duration: 3600 } },
    });
    expect(read(format(read(text)))).toEqual(read(text));
  });

  test("writes a view by its query and its rules", () => {
    const text = canonical({
      collections: {
        summaries: { type: "view", query: "SELECT id FROM posts", rules: { list: "" } },
      },
    });
    const written = format(read(text));
    expect(JSON.parse(written).collections).toEqual({
      summaries: { type: "view", rules: { list: "" }, query: "SELECT id FROM posts" },
    });
    expect(read(written)).toEqual(read(text));
  });

  test("sorts the collections by name, and the rules and options by key", () => {
    const text = canonical({
      collections: {
        zebras: { type: "base" },
        apples: {
          type: "base",
          rules: { update: "", list: "" },
        },
      },
    });
    const written = format(read(text));
    expect(Object.keys(JSON.parse(written).collections)).toEqual(["apples", "zebras"]);
    expect(JSON.parse(written).collections.apples.rules).toEqual({ list: "", update: "" });
    expect(written.indexOf('"list"')).toBeLessThan(written.indexOf('"update"'));
  });

  test("ends with a final newline and is byte-identical on a second pass", () => {
    const text = canonical({
      collections: {
        posts: { type: "base", fields: { body: { type: "editor", maxSize: 5000 } } },
      },
    });
    const first = format(read(text));
    expect(first.endsWith("}\n")).toBe(true);
    expect(format(read(first))).toBe(first);
  });
});

describe("extra keys", () => {
  test("a pull over an existing file keeps its descriptions and tsType", () => {
    const existing = canonical({
      collections: {
        posts: {
          type: "base",
          description: "Blog posts",
          fields: {
            tags: { type: "json", tsType: "{ tags: string[] }", description: "Labels" },
            title: { type: "text", description: "Shown in lists" },
          },
        },
      },
    });
    const extras = extractExtras(existing);
    const pulled = read(
      canonical({
        collections: {
          posts: {
            type: "base",
            fields: {
              tags: { type: "json" },
              title: { type: "text" },
            },
          },
        },
      }),
    );
    const written = format(pulled, extras);
    expect(JSON.parse(written).collections.posts).toEqual(JSON.parse(existing).collections.posts);
    expect(read(written).collections.find((item) => item.name === "posts")?.description).toBe(
      "Blog posts",
    );
  });

  test("drops a tsType whose field is not json any more", () => {
    const extras = extractExtras(
      canonical({
        collections: {
          posts: { type: "base", fields: { tags: { type: "json", tsType: "string[]" } } },
        },
      }),
    );
    const pulled = read(
      canonical({ collections: { posts: { type: "base", fields: { tags: { type: "text" } } } } }),
    );
    expect(format(pulled, extras)).not.toContain("tsType");
  });

  test("an existing file that is not JSON is an error for the pull", () => {
    expect(() => extractExtras('{"collections": [')).toThrow("line 1, column 18");
  });
});

describe("names that are not array indexes", () => {
  test("keep their place in the file, as the reader reads them", () => {
    const text = canonical({
      $schema: url,
      collections: {
        "01": {
          type: "base",
          fields: {
            b: { type: "text" },
            "01": { type: "text" },
            a: { type: "text" },
          },
        },
      },
    });
    expect(format(read(text))).toBe(text);
  });
});

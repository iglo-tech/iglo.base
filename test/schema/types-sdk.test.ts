// The generated types for the SDK (D40, S.4), through the compiled executable
// and the real SDK sources. A fixture app in a mktemp -d directory is
// type-checked with tsc: calls through the typed client (plain, server, browser)
// and through the official `pocketbase` package's generic collection<M>(), with
// `@ts-expect-error` lines for the wrong names, values and fields (an unused
// one is an error itself). A script then runs against a real iglo.base that a
// start with --schema serves, and checks the responses at runtime: their keys,
// their JavaScript types, the hidden fields, the expand and the view.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";

import { typesSchema } from "@test/schema/types-fixture";
import { run, startServer, tempDir } from "@test/support/executable";

const repoRoot = resolve(import.meta.dir, "../..");
const sdkSource = join(repoRoot, "sdk/src");
const email = "admin@sdk-types.test";
const password = "1234567890";

// the fixture's tsconfig: the SDK from its sources, and the official package
const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "Preserve",
    moduleResolution: "bundler",
    types: [],
    strict: true,
    noEmit: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    skipLibCheck: true,
    paths: {
      "iglo.base": [join(sdkSource, "index.ts")],
      "iglo.base/ssr": [join(sdkSource, "ssr/index.ts")],
      "iglo.base/ssr/browser": [join(sdkSource, "ssr/browser-client.ts")],
      "@sdk/*": [join(sdkSource, "*")],
      pocketbase: [join(repoRoot, "node_modules/pocketbase/dist/pocketbase.es.d.mts")],
    },
  },
  files: ["iglo.types.ts", "types-app.ts", "official-app.ts", "live.ts"],
};

// The typed client, in the four places an app uses it, and the wrong uses that
// must not compile. The official package takes the generated record types as
// its generic argument (the types do not depend on the SDK's classes).
const typesApp = `import PocketBase from "iglo.base";
import { createBrowserClient } from "iglo.base/ssr/browser";
import { createServerClient } from "iglo.base/ssr";
import { Collections } from "./iglo.types";
import type {
  AuthorsCreate,
  AuthorsResponse,
  PostListResponse,
  PostsCreate,
  PostsResponse,
  PostsUpdate,
  TypedPocketBase,
} from "./iglo.types";

const pb = new PocketBase("http://127.0.0.1:1") as TypedPocketBase;

export async function typed(): Promise<void> {
  const post: PostsResponse = await pb.collection("posts").getOne("id");
  const status: PostsResponse["status"] = post.status;
  const section: "" | "news" | "sport" = post.section;
  const expanded = await pb
    .collection(Collections.Posts)
    .getOne<PostsResponse<{ author: AuthorsResponse; related: PostsResponse[] }>>("id", {
      expand: "author,related",
    });
  const nickname: string | undefined = expanded.expand?.author?.nickname;
  const related: PostsResponse[] | undefined = expanded.expand?.related;
  const list = await pb.collection("posts").getList<PostsResponse>(1, 10);
  const views: number = list.items[0]?.views ?? 0;

  const created: PostsCreate = {
    title: "t",
    status: "draft",
    meta: { k: "v" },
    place: { lon: 1, lat: 2 },
    cover: new Blob([]),
    gallery: [new Blob([])],
    pin: "1234",
  };
  await pb.collection("posts").create(created);
  const update: PostsUpdate = {
    "views+": 1,
    "status+": ["draft"],
    "+tags": "a",
    "tags-": ["b"],
    "+related": "x",
    "cover-": "old.png",
    "+cover": new File([], "a.png"),
    "gallery+": [new Blob([])],
  };
  await pb.collection("posts").update(post.id, update);
  const author: AuthorsCreate = {
    email: "a@x.test",
    password: "1234567890",
    passwordConfirm: "1234567890",
    nickname: "n",
    emailVisibility: true,
  };
  await pb.collection("authors").create(author);

  const server: TypedPocketBase = await createServerClient({
    url: "http://127.0.0.1:1",
    cookies: { getAll: () => [] },
  });
  const authors: AuthorsResponse[] = await server.collection("authors").getFullList<AuthorsResponse>();
  const browser: TypedPocketBase = createBrowserClient({ url: "http://127.0.0.1:1" });
  const page: PostListResponse[] = await browser.collection("post_list").getFullList<PostListResponse>();
  void [status, section, nickname, related, views, authors, page];
}

export async function rejected(): Promise<void> {
  // @ts-expect-error a collection that the schema does not have
  pb.collection("nope");
  // @ts-expect-error a select value that the field does not have
  const badStatus: PostsCreate = { title: "t", status: "bogus" };
  // @ts-expect-error a field that the collection does not have
  const extra: PostsCreate = { title: "t", status: "draft", nope: 1 };
  // @ts-expect-error a select modifier takes the field's values only
  const badUpdate: PostsUpdate = { "status+": "bogus" };
  // @ts-expect-error a relation takes an id, not a number
  const badAuthor: PostsCreate = { title: "t", status: "draft", author: 1 };
  const post = await pb.collection("posts").getOne("id");
  // @ts-expect-error a hidden field is not in the response
  const pin = post.pin;
  const plain = await pb.collection("posts").getOne<PostsResponse<{}>>("id");
  // @ts-expect-error an expand that the response type does not declare
  const missing = plain.expand?.author;
  void [badStatus, extra, badUpdate, badAuthor, pin, missing];
}
`;

const officialApp = `import OfficialPocketBase from "pocketbase";
import type { AuthorsResponse, PostsCreate, PostsResponse, PostsUpdate } from "./iglo.types";

export async function official(): Promise<void> {
  const client = new OfficialPocketBase("http://127.0.0.1:1");
  const post = await client.collection<PostsResponse>("posts").getOne("id");
  const title: string = post.title;
  const withAuthor = await client
    .collection<PostsResponse<{ author: AuthorsResponse }>>("posts")
    .getOne("id", { expand: "author" });
  const nickname: string | undefined = withAuthor.expand?.author?.nickname;
  const create: PostsCreate = { title: "t", status: "draft" };
  await client.collection<PostsResponse>("posts").create(create);
  const update: PostsUpdate = { "views+": 1 };
  await client.collection<PostsResponse>("posts").update("id", update);
  // @ts-expect-error a field that the collection does not have
  void post.nope;
  void [title, nickname];
}
`;

// The runtime check against a real server. Each response's keys and the
// JavaScript types of its values are those the generated types give them; a
// non-required select reads "" when unset, a json field reads null when unset.
const liveApp = `import PocketBase from "iglo.base";
import { createBrowserClient } from "iglo.base/ssr/browser";
import { createServerClient } from "iglo.base/ssr";
import { Collections } from "./iglo.types";
import type { AuthorsResponse, PostListResponse, PostsCreate, PostsResponse, TypedPocketBase } from "./iglo.types";

// the process of the runtime (Bun), declared here: the fixture's tsconfig has no node types
declare const process: { env: Record<string, string | undefined> };

type Kind = "string" | "number" | "boolean" | "array" | "object" | "any";

const postShape: Record<string, Kind> = {
  id: "string", collectionId: "string", collectionName: "string",
  title: "string", body: "string", views: "number", published: "boolean",
  contact: "string", site: "string", day: "string", status: "string",
  section: "string", tags: "array", author: "string", related: "array",
  meta: "object", free: "any", place: "object", cover: "string", gallery: "array",
  created: "string", updated: "string",
};

// a superuser's responses also carry the hidden password field (upstream shows hidden
// fields to superusers only); the generated Response type is the other clients' view
const superPostShape: Record<string, Kind> = { ...postShape, pin: "string" };

function kindOf(value: unknown): Kind | "other" {
  if (Array.isArray(value)) return "array";
  if (value === null) return "any";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "other";
}

function checkShape(record: object, shape: Record<string, Kind>, label: string): void {
  const actual = Object.keys(record).sort();
  const expected = Object.keys(shape).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + ": keys " + JSON.stringify(actual) + " are not " + JSON.stringify(expected));
  }
  for (const [key, kind] of Object.entries(shape)) {
    const value = (record as Record<string, unknown>)[key];
    const got = kindOf(value);
    if (kind !== "any" && got !== kind) {
      throw new Error(label + ": " + key + " is " + got + ", not " + kind);
    }
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const url = process.env.IGLO_URL ?? "";
const admin = new PocketBase(url) as TypedPocketBase;
await admin.collection("_superusers").authWithPassword(process.env.IGLO_EMAIL ?? "", process.env.IGLO_PASSWORD ?? "");

const alice = await admin.collection("authors").create<AuthorsResponse>({
  email: "alice@types.test", password: "1234567890", passwordConfirm: "1234567890",
  nickname: "Alice", emailVisibility: true,
});
const bob = await admin.collection("authors").create<AuthorsResponse>({
  email: "bob@types.test", password: "1234567890", passwordConfirm: "1234567890",
  nickname: "Bob", emailVisibility: false,
});
const data: PostsCreate = {
  title: "First", status: "draft", meta: { k: "v" }, place: { lon: 1, lat: 2 },
  pin: "1234", author: alice.id, related: [], views: 3, published: true, tags: ["a"],
};
const post = await admin.collection("posts").create<PostsResponse>(data);
checkShape(post, superPostShape, "create response");
check(post.section === "", "an unset select reads empty");
check(post.views === 3 && post.published === true, "the stored values");

const second = await admin.collection("posts").create<PostsResponse>({
  title: "Second", status: "published", meta: { k: "w" }, place: { lon: 0, lat: 0 }, pin: "1234",
});
check(second.section === "" && second.author === "", "an unset relation reads empty");

const expanded = await admin.collection("posts").getOne<PostsResponse<{ author: AuthorsResponse }>>(
  post.id,
  { expand: "author" },
);
checkShape(expanded, { ...superPostShape, expand: "object" }, "expanded response");
check(expanded.expand?.author?.nickname === "Alice", "the expanded author");

const list = await admin.collection(Collections.Posts).getList<PostsResponse>(1, 10);
check(list.items.length === 2, "two posts are listed");
checkShape(list.items[0] as object, superPostShape, "list item");

const view = await admin.collection("post_list").getFullList<PostListResponse>();
checkShape(view[0] as object, { id: "string", collectionId: "string", collectionName: "string", title: "string" }, "view");

// the SSR server client, anonymous: the public records and the email rule
const server: TypedPocketBase = await createServerClient({ url, cookies: { getAll: () => [] } });
const authors = await server.collection("authors").getFullList<AuthorsResponse>();
const seenAlice = authors.find((author) => author.nickname === "Alice");
const seenBob = authors.find((author) => author.nickname === "Bob");
check(seenAlice?.email === "alice@types.test", "a visible email is returned");
check(seenBob !== undefined && seenBob.email === undefined, "a hidden email is not returned");
const serverPosts = await server.collection("posts").getList<PostsResponse>(1, 10);
checkShape(serverPosts.items[0] as object, postShape, "server list item");
check(serverPosts.items.every((item) => !("pin" in item)), "a hidden field is not in an anonymous response");

// the browser client
const browser: TypedPocketBase = createBrowserClient({ url });
const page = await browser.collection("posts").getOne<PostsResponse>(post.id);
checkShape(page, postShape, "browser response");
check(page.title === "First" && !("pin" in page), "the browser client reads the record");

console.log("types ok");
`;

describe("schema types for the SDK", () => {
  test("the typed client, the official package and the wrong uses type-check", async () => {
    const dir = tempDir();
    const schema = join(dir, "iglo.schema.json");
    writeFileSync(schema, JSON.stringify(typesSchema, null, 2));
    const created = await run([
      "--dir",
      join(dir, "pb_data"),
      "superuser",
      "upsert",
      email,
      password,
    ]);
    expect(created.exitCode).toBe(0);
    const generated = await run([
      "--dir",
      join(dir, "pb_data"),
      "schema",
      "types",
      "--schema",
      schema,
      "--out",
      join(dir, "iglo.types.ts"),
    ]);
    expect(generated.exitCode).toBe(0);

    writeFileSync(join(dir, "types-app.ts"), typesApp);
    writeFileSync(join(dir, "official-app.ts"), officialApp);
    writeFileSync(join(dir, "live.ts"), liveApp);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const tsc = Bun.spawn(
      [join(repoRoot, "node_modules/.bin/tsc"), "-p", join(dir, "tsconfig.json")],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await tsc.exited;
    const output =
      (await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text());
    expect(output).toBe("");
    expect(code).toBe(0);
  });

  test("the responses of a running server match the generated types", async () => {
    const dir = tempDir();
    const dataDir = join(dir, "pb_data");
    const created = await run(["--dir", dataDir, "superuser", "upsert", email, password]);
    expect(created.exitCode).toBe(0);
    const schema = join(dir, "iglo.schema.json");
    writeFileSync(schema, JSON.stringify(typesSchema, null, 2));
    // the types of the same file, then the start that applies it
    const generated = await run([
      "--dir",
      dataDir,
      "schema",
      "types",
      "--schema",
      schema,
      "--out",
      join(dir, "iglo.types.ts"),
    ]);
    expect(generated.exitCode).toBe(0);
    writeFileSync(join(dir, "live.ts"), liveApp);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const server = await startServer(["--schema", schema], dataDir);
    try {
      const proc = Bun.spawn([process.execPath, "run", join(dir, "live.ts")], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          IGLO_URL: server.url,
          IGLO_EMAIL: email,
          IGLO_PASSWORD: password,
        },
      });
      const code = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe("types ok");
      expect(code).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

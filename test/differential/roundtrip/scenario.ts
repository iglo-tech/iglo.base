// The write-heavy scenario of the round-trip suite. Every leg runs the same
// writes under its own tag ("a", "b", "c"), so its collections and records
// exist next to the last leg's, and then changes what the last leg wrote: an
// upstream write is changed by iglo.base and an iglo.base write by upstream.
//
// All ids are given, except where the point is that the server generates one
// (`state.generatedIds`). Collection and field ids are upstream's checksums of
// their names, so they compare exactly.

import { png, text } from "@test/differential/files/cases";
import { rid } from "@test/differential/resolver/schema";
import type { Client, RoundTripScenario } from "@test/differential/roundtrip/run";

export const tags = ["a", "b", "c"];
export const password = "1234567890";

export function file(name: string, content: Uint8Array | string, type = "text/plain"): File {
  return new File([typeof content === "string" ? text(content) : content], name, { type });
}

export function picture(name: string): File {
  return file(name, png, "image/png");
}

function form(values: Record<string, string | string[] | File | File[]>): FormData {
  const out = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      out.append(key, item);
    }
  }
  return out;
}

function records(collection: string, id?: string): string {
  return `/api/collections/${collection}/records${id === undefined ? "" : `/${id}`}`;
}

function collectionPath(name: string): string {
  return `/api/collections/${name}`;
}

async function collectionId(c: Client, name: string): Promise<string> {
  return (await c.get(collectionPath(name))).id as string;
}

interface SignIn {
  collection: string;
  email: string;
  password: string;
  // the name the token keeps across legs; none for a sign-in that only proves
  // the password
  keep?: string;
  userAgent?: string;
}

async function signIn(c: Client, s: SignIn): Promise<void> {
  const res = await c.post(
    `/api/collections/${s.collection}/auth-with-password`,
    { identity: s.email, password: s.password },
    { token: "", userAgent: s.userAgent ?? "roundtrip" },
  );
  if (s.keep !== undefined && res?.token !== undefined) {
    c.state.tokens.set(`${s.collection} ${s.keep}`, res.token as string);
  }
}

// every token issued before this leg still works here
async function checkTokens(c: Client): Promise<void> {
  for (const [name, token] of c.state.tokens) {
    const collection = name.split(" ")[0] as string;
    await c.post(`/api/collections/${collection}/auth-refresh`, undefined, { token });
  }
}

export function settingsBody(tag: string, smtpPort: number): Record<string, unknown> {
  return {
    meta: {
      appName: `Round trip ${tag}`,
      appURL: `http://${tag}.example.com`,
      senderName: `Sender "${tag}" ż`,
      senderAddress: `${tag}@example.com`,
      hideControls: false,
    },
    smtp: { enabled: true, host: "127.0.0.1", port: smtpPort, tls: false },
    batch: { enabled: true, maxRequests: 50, timeout: 3 },
    logs: { maxDays: 7, minLevel: 0, logIP: true },
    s3: { enabled: false, bucket: `bucket-${tag}`, region: "eu", secret: `s3-secret-${tag}` },
    rateLimits: {
      enabled: false,
      rules: [{ label: "*:auth", maxRequests: 100 + tags.indexOf(tag), duration: 3 }],
    },
    trustedProxy: { headers: ["X-Real-IP"], useLeftmostIP: true },
  };
}

// the JSON bodies at the edges of each field type; raw text keeps what
// JSON.stringify would change
function edgeBodies(tag: string, people: string[]): { id: string; raw: string }[] {
  const [alice, bob, carol] = people as [string, string, string];
  const raw = (name: string, members: string): { id: string; raw: string } => {
    const id = rid(`${tag}${name}`);
    return { id, raw: `{"id":"${id}",${members}}` };
  };
  return [
    { id: rid(`${tag}e00`), raw: `{"id":"${rid(`${tag}e00`)}"}` },
    raw(
      "e01",
      `"t":"  spaces kept  ","j":{"2":"b","1":"a","10":{"9":true,"8":false}},"n":0.1,"b":true`,
    ),
    raw(
      "e02",
      `"t":"zażółć 😀 e\\u0301 \\"'\\\\","j":{"big":12345678901234567890,"dec":1.10,"exp":1e3}`,
    ),
    raw("e03", `"t":"","ed":"","em":"","u":"","d":"","s1":"","sm":[],"j":null,"r1":"","rm":[]`),
    raw("e04", `"j":[],"n":-0,"b":false`),
    raw("e05", `"j":"","n":1.7976931348623157e308`),
    raw("e06", `"j":{},"n":-1e-7`),
    raw("e07", `"j":0,"n":9007199254740993`),
    raw("e08", `"j":false,"n":1e21`),
    raw("e09", `"j":"text \\u00e9 \\ud83d\\ude00","n":123456789012345680000`),
    raw("e10", `"j":[1,[2,[3,{"a":null}]],"x",1.50,-0],"n":"12.50"`),
    raw("e11", `"j":12345678901234567890123,"b":"true"`),
    raw("e12", `"d":"0001-01-01 00:00:00.000Z","em":"edge.üser@example.com"`),
    raw("e13", `"d":"9999-12-31 23:59:59.999Z","u":"https://example.com/a?b=c#d"`),
    raw("e14", `"d":"2024-02-29T23:59:59+02:00","ed":"<p>zażółć &amp; <a href=\\"x\\">l</a></p>"`),
    raw("e15", `"d":"2024-03-10 01:02:03","s1":"b"`),
    raw("e16", `"d":"2024-03-10","sm":["c","a","a","b"]`),
    raw("e17", `"g":{"lon":-180,"lat":-90},"rm":["${alice}","${bob}","${alice}"]`),
    raw("e18", `"g":{"lon":180,"lat":90},"r1":"${carol}"`),
    raw("e19", `"g":{"lon":0.1234567890123456,"lat":-0.000001},"pw":"pässwörd-1234"`),
    raw("e20", `"g":{"lon":0,"lat":0},"pw":"${"x".repeat(71)}"`),
    raw("e21", `"t":"${"long ".repeat(1000)}","ed":"<div>${"x".repeat(10000)}</div>"`),
    raw("e22", `"t":"line\\nbreak\\ttab","secret":"hidden value","rm":[]`),
    raw("e23", `"j" : { "spaced" : [ 1 , 2 ] ,\n "2":1 , "1":2.0 }`),
  ];
}

function allFields(people: string): Record<string, unknown>[] {
  return [
    { name: "t", type: "text" },
    { name: "ed", type: "editor", convertURLs: true },
    { name: "n", type: "number" },
    { name: "b", type: "bool" },
    { name: "em", type: "email" },
    { name: "u", type: "url" },
    { name: "d", type: "date" },
    { name: "s1", type: "select", values: ["a", "b", "c"], maxSelect: 1 },
    { name: "sm", type: "select", values: ["a", "b", "c", "d"], maxSelect: 4 },
    { name: "j", type: "json" },
    { name: "g", type: "geoPoint" },
    { name: "r1", type: "relation", collectionId: people, maxSelect: 1 },
    { name: "rm", type: "relation", collectionId: people, maxSelect: 5 },
    { name: "pw", type: "password", cost: 4, hidden: true },
    { name: "secret", type: "text", hidden: true },
    { name: "f1", type: "file", maxSelect: 1, maxSize: 1048576 },
    {
      name: "fm",
      type: "file",
      maxSelect: 6,
      maxSize: 1048576,
      thumbs: ["50x50", "50x50t", "0x30", "30x0", "40x40f", "40x40b"],
    },
    { name: "fp", type: "file", maxSelect: 1, maxSize: 1048576, protected: true },
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];
}

interface LegIds {
  people: string;
  all: string;
  kids: string;
  refs: string;
}

async function createCollections(c: Client, tag: string): Promise<LegIds> {
  const people = `rt${tag}_people`;
  const all = `rt${tag}_all`;
  const peopleId = (
    await c.post("/api/collections", {
      name: people,
      type: "auth",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "@request.auth.id = id",
      deleteRule: null,
      manageRule: null,
      passwordAuth: { enabled: true, identityFields: ["email"] },
      authAlert: { enabled: true },
      fields: [
        { name: "nick", type: "text", max: 40 },
        { name: "avatar", type: "file", maxSelect: 1, maxSize: 1048576 },
      ],
      indexes: [`CREATE INDEX idx_${tag}_people_nick ON ${people} (nick)`],
    })
  ).id as string;
  const allId = (
    await c.post("/api/collections", {
      name: all,
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: allFields(peopleId),
      indexes: [
        `CREATE INDEX idx_${tag}_all_n ON ${all} (n)`,
        `CREATE UNIQUE INDEX idx_${tag}_all_em ON ${all} (em) WHERE em != ''`,
      ],
    })
  ).id as string;
  const kids = (
    await c.post("/api/collections", {
      name: `rt${tag}_kids`,
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "title", type: "text" },
        {
          name: "parent",
          type: "relation",
          collectionId: allId,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        { name: "doc", type: "file", maxSelect: 1, maxSize: 1048576 },
      ],
    })
  ).id as string;
  const refs = (
    await c.post("/api/collections", {
      name: `rt${tag}_refs`,
      type: "base",
      listRule: `@request.auth.id != ""`,
      viewRule: null,
      fields: [
        { name: "one", type: "relation", collectionId: allId, maxSelect: 1 },
        { name: "many", type: "relation", collectionId: allId, maxSelect: 4 },
      ],
    })
  ).id as string;
  await c.post("/api/collections", {
    name: `rt${tag}_view`,
    type: "view",
    listRule: "",
    viewRule: "",
    viewQuery: `SELECT id, t, n, r1, created FROM ${all} WHERE n > 0`,
  });
  await c.post("/api/collections", {
    name: `rt${tag}_counts`,
    type: "view",
    listRule: "",
    viewRule: "",
    viewQuery: `SELECT p.id, p.nick, COUNT(a.id) AS total FROM ${people} p LEFT JOIN ${all} a ON a.r1 = p.id GROUP BY p.id`,
  });
  return { people: peopleId, all: allId, kids, refs };
}

async function createPeople(c: Client, tag: string): Promise<string[]> {
  const people = `rt${tag}_people`;
  const ids: string[] = [];
  for (const name of ["alice", "bob", "carol"]) {
    const id = rid(`${tag}${name}`);
    ids.push(id);
    await c.post(records(people), {
      id,
      email: `${name}.${tag}@example.com`,
      emailVisibility: name === "alice",
      verified: true,
      password,
      passwordConfirm: password,
      nick: `${name} ż`,
    });
  }
  await c.request("PATCH", records(people, ids[0]), {
    form: form({ avatar: picture("avatar.png") }),
  });
  return ids;
}

// fields and modifiers on one record after the other
async function writeRecords(c: Client, tag: string, ids: LegIds, people: string[]): Promise<void> {
  const all = `rt${tag}_all`;
  for (const body of edgeBodies(tag, people)) {
    await c.request("POST", records(all), { raw: body.raw });
  }

  // a record id the server generates
  const generated = await c.post(records(all), { t: "generated id", n: 1 });
  if (generated?.id !== undefined) {
    c.state.generatedIds.add(generated.id as string);
    await c.post(records(`rt${tag}_refs`), { one: generated.id, many: [generated.id] });
    c.state.generatedIds.add(
      (await c.get(`${records(`rt${tag}_refs`)}?sort=-@rowid&perPage=1`)).items[0].id,
    );
  }

  // multipart: every value arrives as text
  await c.request("POST", records(all), {
    form: form({
      id: rid(`${tag}form1`),
      t: "from a form",
      n: "1e3",
      b: "1",
      j: `{"2":1,"1":2,"dec":1.10,"big":12345678901234567890}`,
      sm: ["a", "b"],
      rm: [people[0] as string, people[1] as string],
      g: `{"lon":12.5,"lat":-45.25}`,
      f1: file("zażółć plik (1).txt", "single file"),
      fm: [
        picture("first.png"),
        picture("second.png"),
        file("a.b.TAR.GZ", "archive"),
        file("noext", "x"),
      ],
      fp: file("private.txt", "protected file"),
    }),
  });
  await c.request("POST", records(all), {
    form: form({
      id: rid(`${tag}form2`),
      "@jsonPayload": `{"t":"from a payload","j":{"3":3,"1":1},"n":7,"s1":"c"}`,
      f1: picture("payload.png"),
    }),
  });

  // modifiers
  const target = rid(`${tag}form1`);
  await c.patch(records(all, target), {
    "n+": 5,
    "sm+": "c",
    "+sm": "d",
    "rm+": people[2],
  });
  await c.patch(records(all, target), { "n-": 1.5, "sm-": ["a"], "rm-": people[0] });
  const stored = await c.get(records(all, target));
  await c.request("PATCH", records(all, target), {
    form: form({
      "fm+": file("appended.txt", "appended"),
      "+fm": picture("prepended.png"),
      "fm-": (stored?.fm ?? []).slice(1, 2) as string[],
    }),
  });
  await c.request("PATCH", records(all, rid(`${tag}form2`)), {
    form: form({ f1: picture("replacement.png") }),
  });
  await c.patch(records(all, rid(`${tag}form1`)), { f1: null });
  await c.patch(records(all, rid(`${tag}e15`)), {
    t: "updated",
    j: { z: 1, "2": 2 },
    d: "",
    g: { lon: 1.5, lat: 2.5 },
    pw: "changed-password",
    s1: "",
  });

  // thumbs of every declared size
  const pictured = await c.get(records(all, target));
  for (const name of (pictured?.fm ?? []) as string[]) {
    if (name.endsWith(".png")) {
      for (const size of ["50x50", "50x50t", "0x30", "30x0", "40x40f", "40x40b"]) {
        await c.get(`/api/files/${ids.all}/${target}/${name}?thumb=${size}`, { token: "" });
      }
    }
  }

  // a unique index refuses, and nothing stays behind
  await c.post(records(all), { id: rid(`${tag}dup1`), em: `dup.${tag}@example.com` });
  await c.post(
    records(all),
    { id: rid(`${tag}dup2`), em: `dup.${tag}@example.com` },
    { expect: 400 },
  );
}

async function cascades(c: Client, tag: string, ids: LegIds): Promise<void> {
  const all = `rt${tag}_all`;
  const kids = `rt${tag}_kids`;
  const refs = `rt${tag}_refs`;

  // the parent of the leg itself, and one left for the next leg to delete
  for (const name of ["par1", "par2"]) {
    await c.request("POST", records(all), {
      form: form({ id: rid(`${tag}${name}`), t: name, f1: picture(`${name}.png`) }),
    });
    await c.request("POST", records(kids), {
      form: form({
        id: rid(`${tag}${name}kid`),
        title: `kid of ${name}`,
        parent: rid(`${tag}${name}`),
        doc: file(`${name}.txt`, name),
      }),
    });
    await c.post(records(refs), {
      id: rid(`${tag}${name}ref`),
      one: rid(`${tag}${name}`),
      many: [rid(`${tag}${name}`), rid(`${tag}e01`)],
    });
  }
  await c.deleteRecord(all, ids.all, rid(`${tag}par1`));
  c.deletedWith(ids.kids, rid(`${tag}par1kid`));
}

async function batches(c: Client, tag: string): Promise<void> {
  const all = `rt${tag}_all`;
  await c.post("/api/batch", {
    requests: [
      { method: "POST", url: records(all), body: { id: rid(`${tag}bat1`), t: "batch one", n: 2 } },
      { method: "POST", url: records(all), body: { id: rid(`${tag}bat2`), t: "batch two" } },
      {
        method: "PATCH",
        url: records(all, rid(`${tag}bat1`)),
        body: { "n+": 3, j: { "2": "x", "1": "y" } },
      },
      { method: "PUT", url: records(all), body: { id: rid(`${tag}bat3`), t: "upsert new" } },
      { method: "PUT", url: records(all), body: { id: rid(`${tag}bat2`), t: "upsert old" } },
      { method: "DELETE", url: records(all, rid(`${tag}bat2`)) },
    ],
  });
  const fileBatch = new FormData();
  fileBatch.append(
    "@jsonPayload",
    JSON.stringify({
      requests: [
        { method: "POST", url: records(all), body: { id: rid(`${tag}bat4`), t: "with a file" } },
      ],
    }),
  );
  fileBatch.append("requests.0.f1", picture("batch.png"));
  await c.request("POST", "/api/batch", { form: fileBatch });

  // the second item fails, so the first must leave no row and no file
  const failing = new FormData();
  failing.append(
    "@jsonPayload",
    JSON.stringify({
      requests: [
        { method: "POST", url: records(all), body: { id: rid(`${tag}bat5`), t: "rolled back" } },
        { method: "PATCH", url: records(all, rid("nothing")), body: { t: "missing" } },
      ],
    }),
  );
  failing.append("requests.0.f1", picture("rolled-back.png"));
  await c.request("POST", "/api/batch", { form: failing, expect: 400 });
}

async function changeFields(
  c: Client,
  name: string,
  change: (fields: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  const current = await c.get(collectionPath(name));
  await c.patch(collectionPath(name), { fields: change(current.fields) });
}

async function schemaChanges(c: Client, tag: string): Promise<void> {
  const sch = `rt${tag}_sch`;
  await c.post("/api/collections", {
    name: sch,
    type: "base",
    listRule: null,
    fields: [
      { name: "a", type: "text" },
      { name: "b", type: "text" },
      { name: "c", type: "text" },
      { name: "drop_me", type: "number" },
      { name: "m", type: "select", values: ["x", "y", "z"], maxSelect: 3 },
      { name: "rel", type: "relation", collectionId: "pbc_3142635823", maxSelect: 3 },
      {
        name: "custom",
        type: "text",
        autogeneratePattern: "[a-z]{0}fixed",
      },
    ],
    indexes: [
      `CREATE INDEX idx_${tag}_sch_a ON ${sch} (a)`,
      `CREATE INDEX idx_${tag}_sch_b ON ${sch} (b)`,
      `CREATE UNIQUE INDEX idx_${tag}_sch_c ON ${sch} (c) WHERE c != ''`,
    ],
  });
  for (const n of [1, 2, 3]) {
    await c.post(records(sch), {
      id: rid(`${tag}sch${n}`),
      a: `a${n}`,
      b: `b${n}`,
      c: `c${n}`,
      drop_me: n,
      m: n === 1 ? ["z", "x"] : n === 2 ? ["y"] : [],
    });
  }

  // add
  await changeFields(c, sch, (fields) => [...fields, { name: "added", type: "bool" }]);
  await c.patch(records(sch, rid(`${tag}sch1`)), { added: true });
  // rename, with an index on the field
  const beforeRename = await c.get(collectionPath(sch));
  await c.patch(collectionPath(sch), {
    fields: (beforeRename.fields as Record<string, unknown>[]).map((f) =>
      f["name"] === "b" ? { ...f, name: "b_renamed" } : f,
    ),
    indexes: (beforeRename.indexes as string[]).map((s) => s.replace(/\(`?b`?\)/, "(`b_renamed`)")),
  });
  // drop
  await changeFields(c, sch, (fields) => fields.filter((f) => f["name"] !== "drop_me"));
  // multi to single keeps the last value
  await changeFields(c, sch, (fields) =>
    fields.map((f) => (f["name"] === "m" ? { ...f, maxSelect: 1 } : f)),
  );
  // rename the collection
  const renamed = `rt${tag}_renamed`;
  await c.patch(collectionPath(sch), { name: renamed });
  // indexes
  const current = await c.get(collectionPath(renamed));
  await c.patch(collectionPath(renamed), {
    indexes: [
      ...(current.indexes as string[]).filter((s) => !s.includes(`idx_${tag}_sch_a`)),
      `CREATE INDEX idx_${tag}_sch_added ON ${renamed} (added, c DESC)`,
    ],
  });
  // rules
  await c.patch(collectionPath(renamed), {
    listRule: "",
    viewRule: `a != ""`,
    createRule: `@request.auth.id != ""`,
    updateRule: `@request.auth.collectionName = "_superusers"`,
    deleteRule: null,
  });
  await c.patch(collectionPath(`rt${tag}_view`), {
    viewQuery: `SELECT id, t, n, r1, b, created FROM rt${tag}_all WHERE n >= 0`,
    listRule: `@request.auth.id != ""`,
  });

  // emptied, imported and deleted collections
  const tmp = await c.post("/api/collections", {
    name: `rt${tag}_tmp`,
    type: "base",
    fields: [{ name: "doc", type: "file", maxSelect: 1, maxSize: 1048576 }],
  });
  await c.request("POST", records(`rt${tag}_tmp`), {
    form: form({ id: rid(`${tag}tmp1`), doc: file("tmp.txt", "gone with the truncate") }),
  });
  await c.delete(`${collectionPath(`rt${tag}_tmp`)}/truncate`);
  c.deletedWith(tmp.id as string, rid(`${tag}tmp1`));
  await c.delete(collectionPath(`rt${tag}_tmp`));
  await c.request("PUT", "/api/collections/import", {
    json: {
      deleteMissing: false,
      collections: [
        {
          name: `rt${tag}_imp`,
          type: "base",
          listRule: "",
          fields: [
            { name: "title", type: "text" },
            { name: "num", type: "number" },
          ],
          indexes: [`CREATE INDEX idx_${tag}_imp ON rt${tag}_imp (title)`],
        },
      ],
    },
    expect: 204,
  });
}

async function superusers(c: Client, tag: string, previous: string | undefined): Promise<void> {
  const email = `super.${tag}@example.com`;
  const id = rid(`${tag}super`);
  await c.post(records("_superusers"), { id, email, password, passwordConfirm: password });
  await signIn(c, { collection: "_superusers", email, password, keep: tag });
  await c.post(records("_superusers"), {
    id: rid(`${tag}super2`),
    email: `second.${tag}@example.com`,
    password,
    passwordConfirm: password,
  });
  await c.patch(records("_superusers", rid(`${tag}super2`)), {
    password: "new-password-1",
    passwordConfirm: "new-password-1",
  });
  await signIn(c, {
    collection: "_superusers",
    email: `second.${tag}@example.com`,
    password: "new-password-1",
  });
  if (previous !== undefined) {
    await c.delete(records("_superusers", rid(`${previous}super2`)));
  }
}

async function authOrigins(c: Client, tag: string, previous: string | undefined): Promise<void> {
  const people = `rt${tag}_people`;
  const email = `alice.${tag}@example.com`;
  // the first sign-in stores the origin; a second one from elsewhere alerts
  await signIn(c, { collection: people, email, password, keep: "alice", userAgent: "origin one" });
  await signIn(c, { collection: people, email, password, userAgent: "origin two" });
  await signIn(c, { collection: people, email, password, userAgent: "origin one" });
  await c.post(`/api/collections/${people}/auth-refresh`, undefined, {
    token: c.state.tokens.get(`${people} alice`) as string,
  });
  if (previous !== undefined) {
    const earlier = `rt${previous}_people`;
    await signIn(c, {
      collection: earlier,
      email: `alice.${previous}@example.com`,
      password,
      userAgent: `origin of ${tag}`,
    });
  }
}

// what this leg changes in the last leg's data
async function touchPrevious(c: Client, tag: string, p: string): Promise<void> {
  const all = `rt${p}_all`;
  const people = `rt${p}_people`;
  const allId = await collectionId(c, all);
  const kidsId = await collectionId(c, `rt${p}_kids`);

  await c.patch(records(all, rid(`${p}e02`)), {
    t: `changed in leg ${tag}`,
    "n+": 1,
    "sm+": "b",
    "rm+": rid(`${p}alice`),
  });
  // files: add, replace and remove, and new thumbs of the old files
  const form1 = rid(`${p}form1`);
  const stored = await c.get(records(all, form1));
  const names = (stored?.fm ?? []) as string[];
  await c.request("PATCH", records(all, form1), {
    form: form({
      "fm+": picture(`added-${tag}.png`),
      "fm-": names.slice(0, 1),
    }),
  });
  await c.request("PATCH", records(all, rid(`${p}form2`)), {
    form: form({ f1: file(`replaced-${tag}.txt`, "replaced") }),
  });
  const picturedNames = (await c.get(records(all, form1)))?.fm as string[] | undefined;
  for (const name of picturedNames ?? []) {
    if (name.endsWith(".png")) {
      await c.get(`/api/files/${allId}/${form1}/${name}?thumb=30x0`, { token: "" });
    }
  }
  // cascade over the other server's rows
  await c.deleteRecord(all, allId, rid(`${p}par2`));
  c.deletedWith(kidsId, rid(`${p}par2kid`));
  await c.get(`${records(`rt${p}_refs`)}/${rid(`${p}par2ref`)}`);

  await c.deleteRecord(all, allId, rid(`${p}e03`));
  await c.deleteRecord(all, allId, rid(`${p}bat4`));

  await c.post("/api/batch", {
    requests: [
      { method: "PUT", url: records(all), body: { id: rid(`${p}e04`), t: `upsert ${tag}` } },
      { method: "PATCH", url: records(all, rid(`${p}e05`)), body: { b: true } },
      { method: "DELETE", url: records(all, rid(`${p}e06`)) },
    ],
  });

  // schema of the other server's collections
  const renamed = `rt${p}_renamed`;
  const before = await c.get(collectionPath(renamed));
  await c.patch(collectionPath(renamed), {
    fields: [
      ...(before.fields as Record<string, unknown>[]).filter((f) => f["name"] !== "c"),
      { name: `added_${tag}`, type: "number" },
    ],
    indexes: (before.indexes as string[]).filter(
      (s) => !s.includes(`idx_${p}_sch_c`) && !s.includes(`idx_${p}_sch_added`),
    ),
  });
  const beforeRename = await c.get(collectionPath(renamed));
  await c.patch(collectionPath(renamed), {
    fields: (beforeRename.fields as Record<string, unknown>[]).map((f) =>
      f["name"] === "b_renamed" ? { ...f, name: `b_${tag}` } : f,
    ),
    indexes: (beforeRename.indexes as string[]).map((s) =>
      s.replace(/\(`?b_renamed`?\)/, `(\`b_${tag}\`)`),
    ),
  });
  await c.patch(collectionPath(renamed), {
    name: `rt${p}_again`,
    indexes: [`CREATE INDEX idx_${p}_again ON rt${p}_again (a)`],
    deleteRule: "",
  });
  await changeFields(c, all, (fields) => [...fields, { name: `note_${tag}`, type: "text" }]);
  await c.patch(records(all, rid(`${p}e01`)), { [`note_${tag}`]: "new column" });

  // passwords of the other server
  await signIn(c, { collection: people, email: `bob.${p}@example.com`, password });
  await c.patch(records(people, rid(`${p}carol`)), {
    password: `new-${tag}-password`,
    passwordConfirm: `new-${tag}-password`,
  });
  await signIn(c, {
    collection: people,
    email: `carol.${p}@example.com`,
    password: `new-${tag}-password`,
  });
  await c.deleteRecord(people, await collectionId(c, people), rid(`${p}bob`));
}

export interface ScenarioOptions {
  smtpPort: number;
  // the superuser who signs in on every leg
  superuser: { email: string; password: string };
  // writes to the starting data, per leg
  existing?: (c: Client, tag: string) => Promise<void>;
}

export function writeScenario(options: ScenarioOptions): RoundTripScenario {
  return {
    async leg(c, leg) {
      const tag = tags[leg] as string;
      const previous = tags[leg - 1];

      await checkTokens(c);
      await c.patch("/api/settings", settingsBody(tag, options.smtpPort));
      await signIn(c, {
        collection: "_superusers",
        email: options.superuser.email,
        password: options.superuser.password,
        keep: `main ${tag}`,
        userAgent: `superuser ${tag}`,
      });

      const ids = await createCollections(c, tag);
      const people = await createPeople(c, tag);
      await writeRecords(c, tag, ids, people);
      await cascades(c, tag, ids);
      await batches(c, tag);
      await schemaChanges(c, tag);
      await superusers(c, tag, previous);
      await authOrigins(c, tag, previous);
      await options.existing?.(c, tag);
      if (previous !== undefined) {
        await touchPrevious(c, tag, previous);
      }
    },
    reads(leg) {
      const out: { path: string; token: string }[] = [];
      for (const tag of tags.slice(0, leg + 1)) {
        const people = `rt${tag}_people`;
        const token = `${people} alice`;
        // a list only an auth record may read, and a rule on a relation
        out.push({ path: `${records(`rt${tag}_refs`)}?sort=@rowid`, token });
        out.push({ path: `${records(`rt${tag}_refs`)}?sort=@rowid`, token: "" });
        out.push({ path: `${records(people)}?sort=@rowid&expand=avatar`, token: "" });
      }
      return out;
    },
  };
}

// the writes to upstream's fixture: records of every kind that were there
// before any leg, files included
export async function fixtureWrites(c: Client, tag: string): Promise<void> {
  const leg = tags.indexOf(tag);
  await c.patch(records("demo2", "llvuca81nly1qls"), {
    title: `fixture ${tag}`,
    active: leg === 1,
  });
  await c.patch(records("demo1", "al1h9ijdeojtsjy"), {
    text: `edited in leg ${tag}`,
    "number+": 1,
    json: { "2": tag, "1": "z" },
    point: { lon: leg, lat: -leg },
  });
  await c.request("PATCH", records("demo1", "imy661ixudk5izi"), {
    form: form({ "file_many+": file(`fixture-${tag}.txt`, tag) }),
  });
  const demo1 = await c.get(records("demo1", "84nmscqy84lsi1t"));
  await c.request("PATCH", records("demo1", "84nmscqy84lsi1t"), {
    form: form({ "file_many-": ((demo1?.file_many ?? []) as string[]).slice(0, 1) }),
  });
  await signIn(c, {
    collection: "clients",
    email: "test@example.com",
    password,
    keep: `fixture ${tag}`,
    userAgent: `fixture ${tag}`,
  });
  await changeFields(c, "demo3", (fields) => [...fields, { name: `added_${tag}`, type: "text" }]);
  const demo2Index = await c.get(collectionPath("demo2"));
  await c.patch(collectionPath("demo2"), {
    indexes: [
      ...(demo2Index.indexes as string[]),
      `CREATE INDEX idx_fixture_${tag} ON demo2 (${["title, active", "active, title", "active DESC, title"][leg]})`,
    ],
  });
}

// settings only, for a leg sequence that changes --encryptionEnv
export function settingsScenario(smtpPort: number): RoundTripScenario {
  return {
    async leg(c, leg) {
      const stored = await c.get("/api/settings");
      if (leg > 0 && stored?.meta?.appName !== `Round trip ${tags[leg - 1]}`) {
        c.state.failures.push(`leg ${leg + 1}: settings: ${JSON.stringify(stored?.meta)}`);
      }
      await c.patch("/api/settings", settingsBody(tags[leg] as string, smtpPort));
    },
  };
}

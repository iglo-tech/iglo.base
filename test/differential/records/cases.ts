// The collections and record payloads of the records reference test
// (records.test.ts). Values are JSON text, so numbers beyond 2^53 and the
// member order of json values reach upstream exactly as written.

export interface FieldDef {
  name: string;
  type: string;
  [setting: string]: unknown;
}

// the auth collection: the default auth fields plus a text, a hidden text
// and a single file field
export const usersCollection = "ref_users";
export const usersFields: FieldDef[] = [
  { name: "name", type: "text", max: 40 },
  { name: "secret", type: "text", hidden: true },
  { name: "avatar", type: "file", maxSelect: 1, maxSize: 1048576 },
  { name: "created", type: "autodate", onCreate: true },
  { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
];

// the base collection: every field type (relations to the auth collection
// are added with its id)
export const allCollection = "ref_all";
export function allFields(usersId: string): FieldDef[] {
  return [
    { name: "title", type: "text", max: 20 },
    { name: "note", type: "text", hidden: true },
    { name: "num", type: "number" },
    { name: "int", type: "number", onlyInt: true },
    { name: "flag", type: "bool" },
    { name: "mail", type: "email" },
    { name: "link", type: "url" },
    { name: "body", type: "editor" },
    { name: "when", type: "date" },
    { name: "one", type: "select", maxSelect: 1, values: ["a", "b", "ü", "漢字"] },
    { name: "many", type: "select", maxSelect: 4, values: ["a", "b", "ü", "漢字"] },
    { name: "data", type: "json" },
    { name: "doc", type: "file", maxSelect: 1, maxSize: 1048576 },
    { name: "docs", type: "file", maxSelect: 5, maxSize: 1048576 },
    { name: "owner", type: "relation", maxSelect: 1, collectionId: usersId },
    { name: "team", type: "relation", maxSelect: 5, collectionId: usersId },
    { name: "loc", type: "geoPoint" },
    { name: "secretLoc", type: "geoPoint", hidden: true },
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];
}

// a file part of a multipart request: [field key, file name, content]
export type FilePart = [string, string, string];

// one request: the JSON body members as JSON text, and the files (sent
// multipart with the members under @jsonPayload)
export interface Payload {
  json: Record<string, string>;
  files?: FilePart[];
}

const q = JSON.stringify;

// ---------------------------------------------------------------------
// users

const userNames = [
  "",
  "Ann",
  "Zoë Ünïcødé",
  "漢字テスト",
  "emoji 🎉🚀",
  "a".repeat(40),
  'quote " backslash \\',
  "line\nbreak\ttab",
  "<script>&amp;</script>",
  "\u2028\u2029",
  "  spaces  ",
  "0",
  "null",
  "true",
  "-1.5e3",
  "ŁÓDŹ",
];

export function userPayloads(): Payload[] {
  return userNames.map((name, i): Payload => {
    const json: Record<string, string> = {
      email: q(`user${i}@example.com`),
      password: q("1234567890"),
      passwordConfirm: q("1234567890"),
      emailVisibility: q(i % 2 === 0),
      verified: q(i % 3 === 0),
      name: q(name),
    };
    if (i % 4 !== 1) {
      json.secret = q(`secret ${i}`);
    }
    const files: FilePart[] = i % 5 === 2 ? [["avatar", `avatar ${i}.txt`, `avatar ${i}`]] : [];
    return { json, files };
  });
}

// updates of the users: [user index, payload]
export function userUpdates(): [number, Payload][] {
  return [
    [0, { json: { emailVisibility: q(true), name: q("updated 0") } }],
    [1, { json: { emailVisibility: q(false), verified: q(true) } }],
    [2, { json: { secret: q(""), name: q("ü".repeat(40)) } }],
    [3, { json: { email: q("CHANGED3@Example.COM") } }],
    [4, { json: {}, files: [["avatar", "new avatar.txt", "new"]] }],
    [7, { json: { avatar: q(null) } }],
  ];
}

// ---------------------------------------------------------------------
// base records

const titles = [
  "",
  "hello",
  "ünïcødé 漢字 🎉",
  "a".repeat(20),
  'q"\\</>&',
  "\u2028x\u2029",
  "line\nbreak",
  "  trimmed?  ",
];

// number fields: JSON number text
const nums = [
  "0",
  "-1.5",
  "1e300",
  "9007199254740993",
  "-9007199254740993",
  "123456789.123456789",
  "1e-7",
  "0.1",
  "-0",
  "5e-324",
  "1.7976931348623157e308",
  "1234567",
];

const ints = [
  "0",
  "42",
  "-9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "1e18",
  "-1e18",
  "-9223372036854775808",
];

const mails = [q(""), q("a@example.com"), q("UPPER@Example.COM"), q("x.y+z@sub.example.org")];

const links = [
  q(""),
  q("https://example.com"),
  q("https://example.com/path?q=1&b=%C3%BC#frag"),
  q("http://localhost:8090/ü"),
];

const bodies = [
  q(""),
  q("<p>hi</p>"),
  q("<p>ünïcødé <b>bold</b> &amp; 🎉</p>"),
  q("<div>" + "x".repeat(2000) + "</div>"),
];

const dates = [
  q(""),
  q("2024-01-02 03:04:05.678Z"),
  q("2024-01-02T03:04:05Z"),
  q("1970-01-01 00:00:00.000Z"),
  q("2024-06-30 23:59:59.999+02:00"),
  q("9999-12-31 23:59:59.999Z"),
  q("0001-01-01 00:00:00.000Z"),
];

const ones = [q(""), q("a"), q("ü"), q("漢字")];

const manys = [q([]), q(["a"]), q(["b", "a"]), q(["ü", "漢字", "a", "b"]), q(["a", "a", "b"])];

// json values, as raw text
const jsons = [
  "null",
  `{"b":1,"a":2,"10":3,"2":4,"":5}`,
  "[1,2,3]",
  "12345678901234567890123",
  `{"n":1.000000000000000000001,"big":-98765432109876543210}`,
  `"str"`,
  "true",
  `{"nested":{"x":[null,{"y":-0}],"z":1e300}}`,
  `{"dup":"ü","esc":"\\u00fc\\n\\u2028"}`,
  `[{"10":1,"9":2,"a":3}]`,
  "0.1",
  `"漢字 🎉"`,
  "{}",
  "[]",
  `{"a" : 1 , "b" :[ 1 , 2 ] }`,
];

const geoPoints = [
  `{"lon":0,"lat":0}`,
  `{"lon":-180,"lat":90}`,
  `{"lon":180,"lat":-90}`,
  `{"lon":23.456789012345,"lat":-12.3}`,
  `{"lat":1.5,"lon":2.5}`,
];

function pick<T>(list: readonly T[], i: number, step = 1): T {
  return list[(i * step) % list.length] as T;
}

// the base records: field values cycle through the edge value lists, with
// different strides, so that the 50 records combine them differently
export function allPayloads(userIds: readonly string[]): Payload[] {
  const out: Payload[] = [];
  for (let i = 0; i < 50; i++) {
    const json: Record<string, string> = {
      title: q(pick(titles, i)),
      num: pick(nums, i),
      int: pick(ints, i, 3),
      flag: q(i % 2 === 1),
      mail: pick(mails, i),
      link: pick(links, i, 3),
      body: pick(bodies, i),
      when: pick(dates, i, 2),
      one: pick(ones, i),
      many: pick(manys, i, 3),
      data: pick(jsons, i),
      loc: pick(geoPoints, i),
    };
    if (i % 3 !== 0) {
      json.note = q(`hidden note ${i} ü`);
    }
    if (i % 4 === 1) {
      json.secretLoc = `{"lon":${i},"lat":${-i / 4}}`;
    }
    if (i % 5 !== 4) {
      json.owner = q(pick(userIds, i));
    }
    if (i % 3 === 2) {
      json.team = q([pick(userIds, i), pick(userIds, i + 3), pick(userIds, i + 7)]);
    }
    const files: FilePart[] = [];
    if (i % 6 === 1) {
      files.push(["doc", `doc ${i}.txt`, `doc ${i}`]);
    }
    if (i % 7 === 3) {
      files.push(["docs", "a.txt", "a"], ["docs", "b ü.txt", "b"], ["docs", "c.json", "{}"]);
    }
    out.push({ json, files });
  }
  return out;
}

// updates of the base records: [record index, payload]; "$firstDoc" in a
// member is replaced with the stored name of the record's first "docs" file
export function allUpdates(userIds: readonly string[]): [number, Payload][] {
  return [
    [0, { json: { title: q("updated"), data: `{"z":1,"y":[2]}` } }],
    [1, { json: { "num+": "2.5", "int-": "1" } }],
    [2, { json: { "many+": q("a"), "+team": q(userIds[0]) } }],
    [3, { json: { flag: q(false), when: q("") } }],
    [4, { json: { data: "99999999999999999999999999" } }],
    [5, { json: { loc: `{"lon":-0.5,"lat":0.25}`, one: q("b") } }],
    [6, { json: { "team-": q(userIds[6]) } }],
    [7, { json: { doc: q(null) } }],
    [10, { json: {}, files: [["docs+", "added.txt", "added"]] }],
    [12, { json: { note: q(""), owner: q("") } }],
    [13, { json: { data: "null", many: q([]) } }],
    [17, { json: { "docs-": q(["$firstDoc"]) } }],
    [20, { json: { int: "-1", num: "1e-300" } }],
    [25, { json: { body: q("<p>updated ünï</p>"), link: q("") } }],
    [30, { json: { title: q("x".repeat(20)), mail: q("new@example.com") } }],
    [33, { json: { data: `{"10":1,"1":2,"b":3,"a":4}` } }],
  ];
}

// ---------------------------------------------------------------------
// numbers by storage class

// a json and a number field, whose columns (JSON, NUMERIC) store whole
// numbers as INTEGER and the others as REAL; the rows are read back by
// storage class (INTEGER in decimal, REAL with Go's float formatting)
export const numsCollection = "ref_nums";
export const numsFields: FieldDef[] = [
  { name: "j", type: "json" },
  { name: "n", type: "number" },
];

// JSON number text, saved through the API as both fields' value
export const numberTexts = [
  "1234567",
  "-1000000",
  "999999",
  "1000000",
  "9007199254740991",
  "-9007199254740991",
  "9223372036854775807",
  "-9223372036854775808",
  "0",
  "-0.0",
  "5.0",
  "1e21",
  "1.5e-7",
  "123456789.0",
  "123456789.5",
];

export function numsPayloads(): Payload[] {
  return numberTexts.map((text) => ({ json: { j: text, n: text } }));
}

// rows inserted with SQL on upstream's data.db: [id, j, n] as SQL literals.
// A number column holds an exact INTEGER the API, which saves a float64,
// cannot store (within 2^53, where the float64 DBExport stores it back as
// the same INTEGER).
export const numsSQLRows: [string, string, string][] = [
  ["sqlnum000000001", "1234567", "1234567"],
  ["sqlnum000000002", "-1000000", "-1000000"],
  ["sqlnum000000003", "9007199254740991", "9007199254740991"],
  ["sqlnum000000004", "-9007199254740991", "-9007199254740991"],
  ["sqlnum000000005", "9223372036854775807", "1000000"],
  ["sqlnum000000006", "-9223372036854775808", "999999"],
  ["sqlnum000000007", "1e21", "1e21"],
  ["sqlnum000000008", "-0.0", "-0.0"],
  ["sqlnum000000009", "1.5e-7", "1.5e-7"],
  ["sqlnum000000010", "123456789.0", "123456789.0"],
  ["sqlnum000000011", "'[1234567,1e6,5.0]'", "0"],
  ["sqlnum000000012", "NULL", "0"],
];

// a view over the numbers whose expression columns have no affinity, so
// that whole REAL values (5.0, 1000000.0) stay REAL
export const numsViewCollection = "ref_nums_view";
export const numsViewQuery =
  "SELECT id, 5.0 AS a, 123456789.0 AS b, -0.0 AS c, 1e21 AS d, 1.5e-7 AS e, 1000000.0 AS f, " +
  "999999.0 AS g, 1234567 AS h, -9223372036854775808 AS i, j, n FROM ref_nums";

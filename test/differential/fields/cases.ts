// The settings and record values the fields reference test submits to
// upstream (test/differential/fields/fields.test.ts). Values are JSON
// texts, sent as they are in the request body.

export type FieldDef = Record<string, unknown> & { name: string; type: string };

// Field settings upstream accepts: one collection per field type, one
// field per entry (named "<type>_<index>").
export const validSettings: Record<string, Record<string, unknown>[]> = {
  text: [
    { min: 2, max: 10, pattern: "^[a-z]+$", help: "<b>Help</b> & more", presentable: true },
    { autogeneratePattern: "[a-z]{5}", required: true, hidden: true },
    { max: 9007199254740991, pattern: String.raw`^\p{L}+$` },
    { min: 5, max: 5, autogeneratePattern: String.raw`\d{5}` },
  ],
  editor: [{ maxSize: 1024, convertURLs: true, required: true }, { maxSize: 9007199254740991 }],
  number: [
    { min: 1.5, max: 1e21 },
    { min: -5, max: 5, onlyInt: true, required: true },
    { min: 0 },
    { max: 1e-7 },
    { min: 0.1, max: 0.30000000000000004 },
    { min: -0, max: 123456789.125 },
  ],
  bool: [{ required: true, help: "x" }, { system: true }],
  email: [
    { onlyDomains: ["example.com", "sub.example.co.uk"] },
    { exceptDomains: ["a.b"], required: true },
  ],
  url: [{ onlyDomains: ["example.com"] }, { exceptDomains: ["a.io", "b.example.org"] }],
  date: [
    { min: "2024-01-01 00:00:00.000Z", max: "2025-01-01 10:00:00.123Z" },
    { min: "2024-01-01T10:00:00+02:00" },
    { max: "2024-05-05", required: true },
    // min after max is accepted: upstream's range check discards its rules
    { min: "2030-01-01 00:00:00.000Z", max: "2020-01-01 00:00:00.000Z" },
    { min: "garbage", max: "2024-01-02 03:04:05.123456789Z" },
  ],
  autodate: [
    { onCreate: true },
    { onUpdate: true },
    { onCreate: true, onUpdate: true, hidden: true },
  ],
  select: [
    { values: ["a", "b", "<c>"], maxSelect: 3 },
    { values: ["x"], maxSelect: 1, required: true },
    { values: ["a", "b"] },
  ],
  json: [{ maxSize: 100 }, { required: true, presentable: true }],
  geoPoint: [{ required: true, presentable: true }, { help: "<&> " }],
};

// Field settings upstream rejects: one collection each, with the field
// after the default "id" field. Error messages here must not depend on
// random values (autogenerate patterns are literals).
export const invalidSettings: FieldDef[] = [
  { name: "f", type: "text", min: -1 },
  { name: "f", type: "text", max: -1 },
  { name: "f", type: "text", min: 5, max: 3 },
  { name: "f", type: "text", pattern: "(invalid" },
  { name: "f", type: "text", autogeneratePattern: "(x" },
  { name: "f", type: "text", pattern: String.raw`^\d+$`, autogeneratePattern: "abc" },
  { name: "f", type: "text", max: 9007199254740992 },
  { name: "f", type: "text", help: "h".repeat(301) },
  { name: "a_via_b", type: "text" },
  { name: "expand", type: "text" },
  { name: "bad name", type: "text" },
  { name: "f", type: "text", id: "i".repeat(101) },
  { name: "f", type: "text", primaryKey: true, hidden: true },
  { name: "f", type: "text", autogeneratePattern: String.raw`\pX` },
  { name: "f", type: "text", max: 2, autogeneratePattern: "é\t\u0001x" },
  { name: "f", type: "editor", maxSize: -1 },
  { name: "f", type: "editor", maxSize: 9007199254740992 },
  { name: "f", type: "number", min: 1.5, onlyInt: true },
  { name: "f", type: "number", min: 5, max: 1 },
  { name: "f", type: "number", max: 2.5, onlyInt: true },
  { name: "f", type: "number", min: 1e21, max: 1e20 },
  { name: "f", type: "number", min: 0, max: -1 },
  { name: "f", type: "number", min: 1e20, onlyInt: true },
  { name: "f", type: "bool", name2: "ignored", help: "b".repeat(301) },
  { name: "f", type: "email", onlyDomains: ["example.com"], exceptDomains: ["a.com"] },
  { name: "f", type: "email", onlyDomains: ["-bad.com", "ok.com", "a..b"] },
  { name: "f", type: "url", exceptDomains: ["not a domain"] },
  { name: "f", type: "email", onlyDomains: ["例え.jp", "xn--r8jz45g.jp"] },
  { name: "f", type: "url", exceptDomains: ["xn--fsqu00a.xn--0zwm56d"] },
  { name: "f", type: "url", exceptDomains: ["localhost"] },
  { name: "f", type: "date", help: "d".repeat(301), min: "2024-01-01" },
  { name: "f", type: "autodate" },
  { name: "f", type: "autodate", system: true },
  { name: "f", type: "select", values: [] },
  { name: "f", type: "select", values: ["a", "b"], maxSelect: 3 },
  { name: "f", type: "select", values: ["a"], maxSelect: -1 },
  { name: "f", type: "json", maxSize: -5 },
  { name: "f", type: "geoPoint", help: "g".repeat(301) },
];

export interface ValueCollection {
  name: string;
  fields: FieldDef[];
}

// The collections records are created in. Fields are not required, so
// that each record only fails on the submitted value; the r_* collections
// hold one required field each.
export const valueCollections: ValueCollection[] = [
  {
    name: "v_text",
    fields: [
      { name: "t", type: "text" },
      { name: "tm", type: "text", min: 2, max: 4 },
      { name: "tp", type: "text", pattern: String.raw`^\w+$` },
    ],
  },
  {
    name: "v_editor",
    fields: [
      { name: "e", type: "editor" },
      { name: "es", type: "editor", maxSize: 10 },
    ],
  },
  {
    name: "v_number",
    fields: [
      { name: "n", type: "number" },
      { name: "nr", type: "number", min: -1.5, max: 10 },
      { name: "ni", type: "number", onlyInt: true },
      { name: "nm", type: "number", min: 0.5 },
    ],
  },
  { name: "v_bool", fields: [{ name: "b", type: "bool" }] },
  {
    name: "v_email",
    fields: [
      { name: "em", type: "email" },
      { name: "emo", type: "email", onlyDomains: ["example.com"] },
      { name: "eme", type: "email", exceptDomains: ["example.com", "test.org"] },
    ],
  },
  {
    name: "v_url",
    fields: [
      { name: "u", type: "url" },
      { name: "uo", type: "url", onlyDomains: ["example.com"] },
      { name: "ue", type: "url", exceptDomains: ["example.com"] },
    ],
  },
  {
    name: "v_date",
    fields: [
      { name: "d", type: "date" },
      {
        name: "dr",
        type: "date",
        min: "2020-01-01 00:00:00.000Z",
        max: "2030-01-01 00:00:00.000Z",
      },
    ],
  },
  {
    name: "v_select",
    fields: [
      { name: "s", type: "select", values: ["a", "b", "c"] },
      { name: "sm", type: "select", values: ["a", "b", "c"], maxSelect: 2 },
    ],
  },
  {
    name: "v_json",
    fields: [
      { name: "j", type: "json" },
      { name: "js", type: "json", maxSize: 10 },
    ],
  },
  { name: "v_geo", fields: [{ name: "g", type: "geoPoint" }] },
  { name: "r_text", fields: [{ name: "t", type: "text", required: true }] },
  { name: "r_editor", fields: [{ name: "e", type: "editor", required: true }] },
  { name: "r_number", fields: [{ name: "n", type: "number", required: true }] },
  { name: "r_bool", fields: [{ name: "b", type: "bool", required: true }] },
  { name: "r_email", fields: [{ name: "em", type: "email", required: true }] },
  { name: "r_url", fields: [{ name: "u", type: "url", required: true }] },
  { name: "r_date", fields: [{ name: "d", type: "date", required: true }] },
  { name: "r_select", fields: [{ name: "s", type: "select", values: ["a"], required: true }] },
  { name: "r_json", fields: [{ name: "j", type: "json", required: true }] },
  { name: "r_geo", fields: [{ name: "g", type: "geoPoint", required: true }] },
];

// [collection, body key, JSON text of the value]
export type ValueCase = [string, string, string];

const q = (s: string): string => JSON.stringify(s);

function cases(collection: string, key: string, values: string[]): ValueCase[] {
  return values.map((v) => [collection, key, v]);
}

export const valueCases: ValueCase[] = [
  // text
  ...cases("v_text", "t", [
    q("abc"),
    q(""),
    "123",
    "12.5",
    "true",
    "null",
    "[1,2]",
    `{"a":1}`,
    q("ü日本"),
    q("a".repeat(5001)),
    q("a".repeat(5000)),
    "1e21",
    "-0",
    "0.1",
    "1e-7",
  ]),
  ...cases("v_text", "tm", [q("a"), q("ab"), q("abcd"), q("abcde"), q("абвг"), q("абвгд")]),
  ...cases("v_text", "tp", [q("abc_1"), q("a-b"), q(""), q("日本")]),
  ...cases("r_text", "t", [q(""), q("x"), "null", "0"]),
  // editor
  ...cases("v_editor", "e", [q("<p>hi</p>"), q(""), "5", "false"]),
  ...cases("v_editor", "es", [q("1234567890"), q("12345678901"), q("ééééé"), q("éééééé")]),
  ...cases("r_editor", "e", [q(""), q("x")]),
  // number
  ...cases("v_number", "n", [
    "0",
    "1",
    "-1",
    "1.5",
    q("12"),
    q("1e3"),
    q("0x10"),
    q("0x1p-2"),
    q("1_000"),
    q("abc"),
    q(""),
    "true",
    "false",
    "null",
    "1e308",
    q("inf"),
    q("NaN"),
    q("-Infinity"),
    q("1e400"),
    "[1]",
    `{"a":1}`,
    "1e-7",
    "123456789.123",
    "-0",
    "9007199254740993",
  ]),
  ...cases("v_number", "nr", ["-2", "-1.5", "0", "10", "10.0001", "5"]),
  ...cases("v_number", "ni", [
    "1.5",
    "2",
    q("2.0"),
    "1e20",
    "-1e20",
    "9223372036854775807",
    "-9223372036854775808",
    "4611686018427387904.5",
  ]),
  ...cases("v_number", "nm", ["0.4", "0.5", "-0.1"]),
  ...cases("v_number", "n+", ["5"]),
  ...cases("v_number", "n-", [q("2.5")]),
  ...cases("r_number", "n", ["0", "1", q("0"), "-0"]),
  // bool
  ...cases("v_bool", "b", [
    "true",
    "false",
    q("true"),
    q("false"),
    q("1"),
    q("0"),
    q("t"),
    q("yes"),
    q("TRUE"),
    q("True"),
    "1",
    "0",
    "2",
    "null",
    q(""),
    "[true]",
    `{"a":1}`,
    "0.5",
  ]),
  ...cases("r_bool", "b", ["false", "true", q("false"), q("T")]),
  // email
  ...cases("v_email", "em", [
    q("a@example.com"),
    q("invalid"),
    q(""),
    q("a@b"),
    "123",
    q("user@sub.example.com"),
    q("A@EXAMPLE.COM"),
    q("a b@c.com"),
  ]),
  ...cases("v_email", "emo", [q("a@example.com"), q("a@other.com"), q("a@EXAMPLE.COM")]),
  ...cases("v_email", "eme", [q("a@example.com"), q("a@test.org"), q("a@ok.net")]),
  ...cases("r_email", "em", [q(""), q("a@b.co")]),
  // url
  ...cases("v_url", "u", [
    q("https://example.com"),
    q("example.com"),
    q("ftp://a.b"),
    q("not a url"),
    q(""),
    q("http://例子.测试"),
    q("mailto:a@b.com"),
  ]),
  ...cases("v_url", "uo", [
    q("https://example.com/x"),
    q("https://example.com:8080"),
    q("https://other.com"),
    q("https://sub.example.com"),
    q("example.com"),
  ]),
  ...cases("v_url", "ue", [q("https://example.com"), q("https://other.com")]),
  ...cases("r_url", "u", [q(""), q("https://a.b")]),
  // date
  ...cases("v_date", "d", [
    q("2024-01-02 03:04:05.678Z"),
    q("2024-01-02"),
    q("2024-01-02T03:04:05Z"),
    q("2024-01-02T03:04:05+02:00"),
    q("invalid"),
    q(""),
    "1700000000",
    q("1700000000"),
    "null",
    q("2024-01-02 03:04:05"),
    q("Mon, 02 Jan 2006 15:04:05 MST"),
    q("2024-01-02 03:04:05.123456789Z"),
    q("02 Jan 2006"),
    "true",
  ]),
  ...cases("v_date", "dr", [
    q("2019-12-31 23:59:59.999Z"),
    q("2020-01-01 00:00:00.000Z"),
    q("2030-01-01 00:00:00.001Z"),
    q("2025-06-01"),
    q("2030-01-01T02:00:00+02:00"),
  ]),
  ...cases("r_date", "d", [q(""), q("2024-01-01"), q("nope")]),
  // select
  ...cases("v_select", "s", [
    q("a"),
    q("d"),
    q(""),
    `["a","b"]`,
    `["b","a"]`,
    "null",
    "1",
    `["a","a"]`,
    q(`["a","b"]`),
    q("a b"),
    "[]",
  ]),
  ...cases("v_select", "sm", [
    `["a"]`,
    `["a","b"]`,
    `["a","b","c"]`,
    q("a"),
    "[]",
    `["a","x"]`,
    q(`["b","a"]`),
    `["","a"]`,
    `[1,"a"]`,
    `["b","b","a"]`,
  ]),
  ...cases("v_select", "sm+", [`["c"]`, q("b")]),
  ...cases("v_select", "+sm", [q("b")]),
  ...cases("v_select", "sm-", [q("a")]),
  ...cases("r_select", "s", ["[]", q("a"), q("")]),
  // json
  ...cases("v_json", "j", [
    q("abc"),
    q(""),
    q("null"),
    q("true"),
    q("123"),
    q("1.0"),
    q("1e2"),
    q("1e-7"),
    q("-0"),
    q("[1, 2]"),
    q(`{"b":1,"a":2}`),
    q(`{"a":1,"a":2}`),
    q("[1,]"),
    q(`"quoted"`),
    q(" [1]"),
    q("0x10"),
    q("-"),
    `{"b":1,"a":[1,2]}`,
    "[3,1]",
    "12.5",
    "true",
    "null",
    q("\u0007bell"),
    q("tab\there"),
    q("ü"),
    q(`{"big":12345678901234567890}`),
    q("1e21"),
    q("1e400"),
    q(`["\\ud800"]`),
    `{"x":"<&>"}`,
    "1e-7",
  ]),
  ...cases("v_json", "js", [q(`"12345678"`), q(`"123456789"`), "[1,2,3,4,5]", "[1,2,3,4]"]),
  ...cases("r_json", "j", [
    q("null"),
    q(`""`),
    q("[]"),
    q("{}"),
    q(" [] "),
    q("0"),
    "null",
    "{}",
    q("x"),
  ]),
  // geoPoint
  ...cases("v_geo", "g", [
    `{"lon":1,"lat":2}`,
    `{"lat":-91,"lon":0}`,
    `{"lat":0,"lon":181}`,
    q(`{"lon":10,"lat":20}`),
    "null",
    "{}",
    q("invalid"),
    `{"lon":"a"}`,
    `{"lon":1.5,"lat":-90}`,
    `{"lon":-180,"lat":90}`,
    `{"lon":1e-7,"lat":0.1}`,
    `{"LON":5,"Lat":6}`,
  ]),
  ...cases("r_geo", "g", [`{"lon":0,"lat":0}`, `{"lon":1,"lat":0}`, "null"]),
];

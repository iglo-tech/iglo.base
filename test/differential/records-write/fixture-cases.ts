// Records create, update and delete on upstream's fixture
// (records-write.test.ts), as a guest, users, clients, nologin and a
// superuser (upstream's fixture tokens), in this order on one pair of
// servers.

import type { WriteCase } from "@test/differential/records-write/write-case";

export type FixtureIdentity = "guest" | "users" | "clients" | "nologin" | "superuser";

const json = (v: unknown) => JSON.stringify(v);

const demo1 = "/api/collections/demo1/records";
const demo2 = "/api/collections/demo2/records";
const demo5 = "/api/collections/demo5/records";

// a multipart body of one part per [name, content], each with an empty
// filename parameter (Go's ReadForm keeps such parts as form values),
// after plain value parts
const emptyFilenameBoundary = "4f6a0e9c2d7b1a5e8c3f6d9b2a7e1c4f8d3b6a9e2c5f8b1d4a7e0c3f6b9d";
function emptyFilenameParts(
  parts: [string, string][],
  values: Record<string, string> = {},
): {
  body: string;
  headers: Record<string, string>;
} {
  let body = "";
  for (const [name, content] of Object.entries(values)) {
    body +=
      `--${emptyFilenameBoundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n${content}\r\n`;
  }
  for (const [name, content] of parts) {
    body +=
      `--${emptyFilenameBoundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"; filename=""\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${content}\r\n`;
  }
  body += `--${emptyFilenameBoundary}--\r\n`;
  return {
    body,
    headers: { "Content-Type": `multipart/form-data; boundary=${emptyFilenameBoundary}` },
  };
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

// a demo2 create body in which the first `cut` bytes of token end at byte
// `at`, where jsontext's reads split it (a 64-byte buffer doubling when
// 3/4 full); the token is in the title, or is the active value, and the
// title is padded to place it
function boundaryBody(at: number, id: string, token: string, cut: number, inTitle = true): string {
  const body = (pad: string) =>
    inTitle
      ? `{"id":"${id}","title":"${pad}${token}"}`
      : `{"id":"${id}","title":"${pad}","active":${token}}`;
  // the bytes before the token
  const prefix = byteLength(body("")) - byteLength(token) - (inTitle ? 2 : 1);
  return body("p".repeat(at - cut - prefix));
}

export const fixtureCases: WriteCase[] = [
  // demo1: nil rules, every field type
  {
    name: "demo1: guest create (nil rule)",
    as: "guest",
    method: "POST",
    url: demo1,
    body: json({ text: "x" }),
  },
  {
    name: "demo1: superuser create with every field",
    as: "superuser",
    method: "POST",
    url: `${demo1}?expand=rel_one,rel_many`,
    body: json({
      id: "wfixdemo1000001",
      text: "hello",
      bool: true,
      url: "https://example.com",
      select_one: "optionB",
      select_many: ["optionA", "optionC"],
      number: 12.5,
      email: "x@example.com",
      datetime: "2024-05-06 07:08:09.123Z",
      json: { b: [1, 2], a: { "2": 1, "1": 2 } },
      rel_one: "imy661ixudk5izi",
      rel_many: ["oap640cot4yru2s", "4q1xlclmfloku33"],
      point: { lon: 1.25, lat: -3.5 },
    }),
  },
  {
    name: "demo1: superuser file names removal",
    as: "superuser",
    method: "PATCH",
    url: `${demo1}/84nmscqy84lsi1t`,
    body: json({ "file_many-": ["test_QZFjKjXchk.txt", "logo_vcfJJG5TAh.svg"], file_one: null }),
  },
  {
    name: "demo1: superuser select and relation modifiers",
    as: "superuser",
    method: "PATCH",
    url: `${demo1}/al1h9ijdeojtsjy`,
    body: json({
      "+select_many": "optionA",
      "select_many-": "optionB",
      "rel_many-": ["4q1xlclmfloku33"],
      "rel_many+": "oap640cot4yru2s",
      "number+": 5,
    }),
  },
  {
    name: "demo1: superuser json raw text",
    as: "superuser",
    method: "PATCH",
    url: `${demo1}/imy661ixudk5izi`,
    body: '{"json":{"z":1,"a":[1.50,2e3,12345678901234567890],"s":"\\u00e9"}}',
  },
  {
    name: "demo1: superuser invalid values",
    as: "superuser",
    method: "PATCH",
    url: `${demo1}/imy661ixudk5izi`,
    body: json({
      url: "nope",
      email: "nope",
      select_one: "optionZ",
      datetime: "nope",
      rel_one: "missing",
      point: { lon: 500, lat: 0 },
    }),
  },
  {
    name: "demo1: users update (nil rule)",
    as: "users",
    method: "PATCH",
    url: `${demo1}/imy661ixudk5izi`,
    body: json({ text: "x" }),
  },
  {
    name: "demo1: superuser delete with references",
    as: "superuser",
    method: "DELETE",
    url: `${demo1}/al1h9ijdeojtsjy`,
  },
  // demo2: public rules, required title, unique title index
  {
    name: "demo2: guest create",
    as: "guest",
    method: "POST",
    url: demo2,
    body: json({ id: "wfixdemo2000001", title: "abc", active: "true" }),
  },
  {
    name: "demo2: clients create without a title",
    as: "clients",
    method: "POST",
    url: demo2,
    body: json({ active: true }),
  },
  {
    name: "demo2: nologin update to a duplicate title",
    as: "nologin",
    method: "PATCH",
    url: `${demo2}/wfixdemo2000001`,
    body: json({ title: "test1" }),
  },
  {
    name: "demo2: users update with expand and fields",
    as: "users",
    method: "PATCH",
    url: `${demo2}/wfixdemo2000001?fields=id,title`,
    body: json({ title: "abcd" }),
  },
  {
    name: "demo2: guest delete",
    as: "guest",
    method: "DELETE",
    url: `${demo2}/wfixdemo2000001`,
  },
  {
    name: "demo2: guest delete missing",
    as: "guest",
    method: "DELETE",
    url: `${demo2}/wfixdemo2000001`,
  },
  // demo5: @request.body rules with modifiers
  {
    name: "demo5: create with select and relation modifiers",
    as: "guest",
    method: "POST",
    url: demo5,
    body: json({
      id: "wfixdemo5000001",
      total: 3,
      "select_many+": ["a", "b"],
      "+select_many": "c",
      "rel_many+": "qzaqccwrmva4o1n",
    }),
  },
  {
    name: "demo5: update that keeps total (rule on the resolved body)",
    as: "guest",
    method: "PATCH",
    url: `${demo5}/wfixdemo5000001`,
    body: json({ "select_many-": "a" }),
  },
  {
    name: "demo5: update with total+ resolving to 3",
    as: "guest",
    method: "PATCH",
    url: `${demo5}/la4y2w4o98acwuj`,
    body: json({ "total+": 1, "select_many+": ["d", "e"] }),
  },
  {
    name: "demo5: update over select maxSelect",
    as: "guest",
    method: "PATCH",
    url: `${demo5}/wfixdemo5000001`,
    body: json({ total: 3, "select_many+": ["a", "d", "e"] }),
  },
  {
    name: "demo5: delete without the query param",
    as: "users",
    method: "DELETE",
    url: `${demo5}/wfixdemo5000001`,
  },
  {
    name: "demo5: delete with the query param",
    as: "users",
    method: "DELETE",
    url: `${demo5}/wfixdemo5000001?test=`,
  },
  // auth collections
  {
    name: "nologin: guest create",
    as: "guest",
    method: "POST",
    url: "/api/collections/nologin/records",
    body: json({
      id: "wfixnologin0001",
      email: "fix1@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
      username: "fixuser1",
    }),
  },
  {
    name: "nologin: nologin user updates another record's email",
    as: "nologin",
    method: "PATCH",
    url: "/api/collections/nologin/records/wfixnologin0001",
    body: json({ email: "fix2@example.com" }),
  },
  {
    name: "clients: superuser create with a duplicated username",
    as: "superuser",
    method: "POST",
    url: "/api/collections/clients/records",
    body: json({
      email: "fix3@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
      username: "clients57772",
    }),
  },
  {
    name: "users: superuser creates a user with a relation and expand",
    as: "superuser",
    method: "POST",
    url: "/api/collections/users/records?expand=rel",
    body: json({
      id: "wfixusers000001",
      email: "fix4@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
      rel: "llvuca81nly1qls",
      emailVisibility: true,
    }),
  },
  {
    name: "users: users token updates its own name",
    as: "users",
    method: "PATCH",
    url: "/api/collections/users/records/4q1xlclmfloku33?expand=rel",
    body: json({ name: "renamed" }),
  },
  {
    name: "users: superuser delete with external auths",
    as: "superuser",
    method: "DELETE",
    url: "/api/collections/users/records/bgs820n361vj1qd",
  },
  // multipart parts with an empty filename are values, not uploads
  {
    name: "demo1: superuser multipart file_one with an empty filename and no content",
    as: "superuser",
    method: "POST",
    url: demo1,
    ...emptyFilenameParts([["file_one", ""]], { id: "wfixdemo1000002" }),
  },
  {
    name: "demo2: superuser multipart title with an empty filename",
    as: "superuser",
    method: "POST",
    url: demo2,
    ...emptyFilenameParts([["title", "hello"]], { id: "wfixdemo2000010" }),
  },
  {
    name: "demo1: superuser multipart update with empty-filename text and file_many",
    as: "superuser",
    method: "PATCH",
    url: `${demo1}/al1h9ijdeojtsjy`,
    ...emptyFilenameParts([
      ["text", "from an empty filename"],
      ["file_many", ""],
    ]),
  },
  // chunked JSON bodies: only the first value counts against the body
  // limit (32 MiB for demo2), as jsontext.Decoder reads no further
  {
    name: "demo2: guest chunked create with trailing spaces past the body limit",
    as: "guest",
    method: "POST",
    url: demo2,
    chunked: [
      [json({ id: "wfixdemo2000011", title: "largechunked" }), 1],
      [" ", (32 << 20) + 1],
    ],
  },
  {
    name: "demo2: guest chunked create whose value ends at the body limit",
    as: "guest",
    method: "POST",
    url: demo2,
    chunked: [
      [" ", (32 << 20) - json({ id: "wfixdemo2000012", title: "chunkedatlimit" }).length],
      [json({ id: "wfixdemo2000012", title: "chunkedatlimit" }), 1],
      [" ", 1000],
    ],
  },
  {
    name: "demo2: guest chunked create whose value ends past the body limit",
    as: "guest",
    method: "POST",
    url: demo2,
    chunked: [
      [" ", (32 << 20) + 1 - json({ id: "wfixdemo2000013", title: "chunkedpastlimit" }).length],
      [json({ id: "wfixdemo2000013", title: "chunkedpastlimit" }), 1],
      [" ", 1000],
    ],
  },
  {
    name: "demo2: guest chunked create with a syntax error and trailing spaces",
    as: "guest",
    method: "POST",
    url: demo2,
    chunked: [
      ['{"id":"wfixdemo2000014","title" "x"', 1],
      [" ", (32 << 20) + 1],
    ],
  },
  // JSON tokens cut by jsontext's read boundaries: incomplete, not invalid
  {
    name: "demo2: guest create with a surrogate pair escape cut after the high surrogate at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000015", "\\ud83d\\ude00", 6),
  },
  {
    name: "demo2: guest create with a surrogate pair escape cut after its backslash at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000016", "\\ud83d\\ude00", 7),
  },
  {
    name: "demo2: guest create with a surrogate pair escape cut after \\u at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000017", "\\ud83d\\ude00", 8),
  },
  {
    name: "demo2: guest create with a surrogate pair escape cut in the low half's digits at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000018", "\\ud83d\\ude00", 10),
  },
  {
    name: "demo2: guest create with a \\u escape cut after \\u at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000019", "\\u00e9", 2),
  },
  {
    name: "demo2: guest create with a \\u escape cut in its digits at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000020", "\\ud83d\\ude00", 4),
  },
  {
    name: "demo2: guest create with an escape cut after its backslash at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000021", "\\/", 1),
  },
  {
    name: "demo2: guest create with a 4-byte UTF-8 character cut after 2 bytes at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000022", "\u{1f600}", 2),
  },
  {
    name: "demo2: guest create with a 3-byte UTF-8 character cut after 1 byte at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000023", "\u20ac", 1),
  },
  {
    name: "demo2: guest create with a literal cut after 3 bytes at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000024", "true", 3, false),
  },
  {
    name: "demo2: guest create with a literal cut after 2 bytes at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000025", "null", 2, false),
  },
  {
    name: "demo2: guest create with a surrogate pair escape cut after the high surrogate at 128 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(128, "wfixdemo2000026", "\\ud83d\\ude00", 6),
  },
  {
    name: "demo2: guest create with a 4-byte UTF-8 character cut after 3 bytes at 128 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(128, "wfixdemo2000027", "\u{1f600}", 3),
  },
  {
    name: "demo2: guest create with a surrogate pair escape cut after its backslash at 256 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(256, "wfixdemo2000028", "\\ud83d\\ude00", 7),
  },
  {
    name: "demo2: guest create with a lone high surrogate escape before x at 64 bytes",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000029", "\\ud83dx", 6),
  },
  {
    name: "demo2: guest create with a lone high surrogate escape before x",
    as: "guest",
    method: "POST",
    url: demo2,
    body: boundaryBody(64, "wfixdemo2000030", "\\ud83dx", 30),
  },
  // view collections
  {
    name: "view1: superuser update",
    as: "superuser",
    method: "PATCH",
    url: "/api/collections/view1/records/84nmscqy84lsi1t",
    body: json({ text: "x" }),
  },
];

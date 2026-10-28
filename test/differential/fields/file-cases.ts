// The file field settings and uploads the reference test submits to
// upstream (test/differential/fields/file.test.ts).
//
// An upload case is one multipart request: its parts in order, each a
// text value or a file (name and content). An update case first creates a
// record with its `before` parts, then sends its parts with PATCH; in its
// text values "$0", "$1", ... stand for the before record's stored file
// names (of the field the key names).
//
// File names avoid `"`, `\` and CR/LF: Bun's formData() and Go's
// multipart reader decode those differently (quoted multipart parameters
// are M3.2's, see docs/status.md).

import type { FieldDef } from "@test/differential/fields/cases";

// Settings upstream accepts: one collection per entry, one field each.
export const validSettings: FieldDef[] = [
  { name: "f", type: "file" },
  { name: "f", type: "file", maxSelect: 1 },
  { name: "f", type: "file", maxSelect: 3, maxSize: 1000 },
  { name: "f", type: "file", maxSelect: 99, required: true },
  { name: "f", type: "file", maxSize: 10 },
  { name: "f", type: "file", maxSize: 0, maxSelect: 0 },
  { name: "f", type: "file", maxSize: 9007199254740991, maxSelect: 9007199254740991 },
  { name: "f", type: "file", mimeTypes: ["image/png"] },
  {
    name: "f",
    type: "file",
    maxSelect: 2,
    mimeTypes: ["image/png", "image/jpeg", "text/plain; charset=utf-8", "anything"],
  },
  { name: "f", type: "file", mimeTypes: [] },
  { name: "f", type: "file", thumbs: ["100x100", "0x50", "50x0", "10x10t", "10x10b", "20x20f"] },
  { name: "f", type: "file", thumbs: ["100x200", "100x200", "007x8"] },
  { name: "f", type: "file", thumbs: ["", "10x10"] }, // empty values pass NotIn and Match
  { name: "f", type: "file", protected: true },
  { name: "f", type: "file", protected: true, required: true, maxSelect: 2 },
  { name: "f", type: "file", hidden: true, presentable: true, help: "<b>files</b> & help" },
  { name: "f", type: "file", system: true },
  { name: "f", type: "file", mimeTypes: null, thumbs: null },
];

// Settings upstream rejects.
export const invalidSettings: FieldDef[] = [
  { name: "f", type: "file", thumbs: ["0x0"] },
  { name: "f", type: "file", thumbs: ["100x200", "0x0t"] },
  { name: "f", type: "file", thumbs: ["0x0b", "0x0f", "1x1"] },
  { name: "f", type: "file", thumbs: ["100x"] },
  { name: "f", type: "file", thumbs: ["abc", "10x10x", "10X10", " 10x10", "10x10 "] },
  { name: "f", type: "file", maxSize: -1 },
  { name: "f", type: "file", maxSize: 9007199254740992 },
  { name: "f", type: "file", maxSelect: -1 },
  { name: "f", type: "file", maxSelect: 9007199254740992 },
  { name: "f", type: "file", maxSelect: -5, maxSize: -5, thumbs: ["0x0"] },
  { name: "", type: "file" },
  { name: "f_ż", type: "file" },
  { name: "f", type: "file", help: "x".repeat(301) },
];

// Field JSON texts sent unchanged (large or invalid int settings).
export const rawSettings: string[] = [
  `{"name":"f","type":"file","maxSize":9007199254740993}`,
  `{"name":"f","type":"file","maxSelect":9223372036854775807}`,
  `{"name":"f","type":"file","maxSize":-9223372036854775808}`,
  `{"name":"f","type":"file","maxSize":1.5}`,
  `{"name":"f","type":"file","maxSelect":1e3}`,
  `{"name":"f","type":"file","mimeTypes":"image/png"}`,
  `{"name":"f","type":"file","thumbs":[1]}`,
];

export interface ValueCollection {
  name: string;
  fields: FieldDef[];
}

// The collections the uploads go to.
export const valueCollections: ValueCollection[] = [
  { name: "fsingle", fields: [{ name: "f", type: "file" }] },
  { name: "fmulti", fields: [{ name: "files", type: "file", maxSelect: 3, maxSize: 1000 }] },
  { name: "fsmall", fields: [{ name: "doc", type: "file", maxSelect: 2, maxSize: 10 }] },
  {
    name: "fmime",
    fields: [
      { name: "img", type: "file", maxSelect: 2, mimeTypes: ["image/png", "image/jpeg"] },
      { name: "txt", type: "file", mimeTypes: ["text/plain"] },
    ],
  },
  {
    name: "freq",
    fields: [
      { name: "req", type: "file", maxSelect: 2, required: true },
      { name: "opt", type: "file", protected: true },
    ],
  },
  { name: "fmany", fields: [{ name: "many", type: "file", maxSelect: 99 }] },
];

// file contents
export const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
]);
export const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
export const gif = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
export const pdf = new TextEncoder().encode("%PDF-1.7\n%test\n");
export const html = new TextEncoder().encode("<!DOCTYPE html><html><body>x</body></html>");
export const json = new TextEncoder().encode(`{"a":1}`);
export const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);

export type Content = string | Uint8Array | { size: number };

export type Part = [key: string, value: string] | [key: string, name: string, content: Content];

export interface UploadCase {
  collection: string;
  before?: Part[];
  parts: Part[];
}

const t = (key: string, name: string, content: Content = "hello"): Part => [key, name, content];
const v = (key: string, value: string): Part => [key, value];

const mb5 = 5 * 2 ** 20;

export const uploadCases: UploadCase[] = [
  // single, default settings
  { collection: "fsingle", parts: [t("f", "test.txt")] },
  { collection: "fsingle", parts: [t("f", "first.txt"), t("f", "second.txt")] },
  { collection: "fsingle", parts: [t("f", "zażółć gęślą jaźń.txt")] },
  { collection: "fsingle", parts: [t("f", "日本語.png", png)] },
  { collection: "fsingle", parts: [t("f", "😀 emoji 😀.PNG", png)] },
  { collection: "fsingle", parts: [t("f", "archive.tar.gz")] },
  { collection: "fsingle", parts: [t("f", "v1.2.3.zip")] },
  { collection: "fsingle", parts: [t("f", "noext", png)] },
  { collection: "fsingle", parts: [t("f", "noext")] },
  { collection: "fsingle", parts: [t("f", "noext", pdf)] },
  { collection: "fsingle", parts: [t("f", "noext", ole)] },
  { collection: "fsingle", parts: [t("f", "noext", new Uint8Array([0, 1, 2, 3]))] },
  { collection: "fsingle", parts: [t("f", "a".repeat(400) + ".txt")] },
  { collection: "fsingle", parts: [t("f", "ż".repeat(200) + "abc.txt")] },
  { collection: "fsingle", parts: [t("f", "b" + "ą".repeat(150) + ".ąą")] },
  { collection: "fsingle", parts: [t("f", "x." + "e".repeat(40))] },
  { collection: "fsingle", parts: [t("f", "name.a." + "b".repeat(18))] },
  { collection: "fsingle", parts: [t("f", "name.ąę.txt")] },
  { collection: "fsingle", parts: [t("f", "...")] },
  { collection: "fsingle", parts: [t("f", ".hidden")] },
  { collection: "fsingle", parts: [t("f", "dir/sub/a.txt")] },
  { collection: "fsingle", parts: [t("f", "file.?")] },
  { collection: "fsingle", parts: [t("f", "a  b! c d  . 456")] },
  { collection: "fsingle", parts: [t("f", "Test File.TXT")] },
  { collection: "fsingle", parts: [t("f", "myTestDB.json", json)] },
  { collection: "fsingle", parts: [t("f", "ab")] },
  { collection: "fsingle", parts: [v("f", "abc.txt")] },
  { collection: "fsingle", parts: [v("f", "")] },
  { collection: "fsingle", parts: [t("f", "big.bin", { size: mb5 + 1 })] },
  { collection: "fsingle", parts: [t("f", "max.bin", { size: mb5 })] },
  // size limits and maxSelect
  { collection: "fsmall", parts: [t("doc", "eleven.txt", "x".repeat(11))] },
  { collection: "fsmall", parts: [t("doc", "ten.txt", "x".repeat(10))] },
  {
    collection: "fsmall",
    parts: [t("doc", "a.txt", "x"), t("doc", "b.txt", "x"), t("doc", "c.txt", "x")],
  },
  { collection: "fsmall", parts: [t("doc", "ok.txt", "x"), t("doc", "big.txt", "x".repeat(20))] },
  {
    collection: "fsmall",
    parts: [t("doc", "ż".repeat(200) + ".txt", "x".repeat(20))],
  },
  // multiple
  { collection: "fmulti", parts: [t("files", "a.txt"), t("files", "b.txt"), t("files", "c.txt")] },
  {
    collection: "fmulti",
    parts: [t("files", "a.txt"), t("files", "b.txt"), t("files", "c.txt"), t("files", "d.txt")],
  },
  { collection: "fmulti", parts: [t("files", "same.txt"), t("files", "same.txt")] },
  { collection: "fmulti", parts: [t("files+", "a.txt"), t("files+", "b.txt")] },
  { collection: "fmulti", parts: [t("+files", "a.txt")] },
  { collection: "fmulti", parts: [v("files", "plain.txt"), t("files", "a.txt")] },
  { collection: "fmulti", parts: [v("files", "x".repeat(300)), v("files", "y.txt")] },
  { collection: "fmulti", parts: [t("files-", "a.txt")] },
  // MIME types
  { collection: "fmime", parts: [t("img", "a.png", png)] },
  { collection: "fmime", parts: [t("img", "a.jpg", jpeg), t("img", "b.png", png)] },
  { collection: "fmime", parts: [t("img", "a.png", "not an image")] },
  { collection: "fmime", parts: [t("img", "image.txt", png)] },
  { collection: "fmime", parts: [t("img", "a.gif", gif)] },
  { collection: "fmime", parts: [t("img", "ok.png", png), t("img", "bad.pdf", pdf)] },
  { collection: "fmime", parts: [t("txt", "a.txt", "plain text")] },
  { collection: "fmime", parts: [t("txt", "a.html", html)] },
  { collection: "fmime", parts: [t("txt", "a.json", json)] },
  { collection: "fmime", parts: [t("txt", "żółw " + "ź".repeat(200) + ".txt", png)] },
  { collection: "fmime", parts: [t("img", "a.png", gif), t("txt", "b.txt", pdf)] },
  // required and protected
  { collection: "freq", parts: [v("other", "x")] },
  { collection: "freq", parts: [t("req", "a.txt")] },
  { collection: "freq", parts: [t("opt", "a.txt")] },
  { collection: "freq", parts: [t("req", "a.txt"), t("opt", "b.txt")] },
  {
    collection: "fmany",
    parts: Array.from({ length: 12 }, (_, i) => t("many", `file ${i}.txt`)),
  },
  { collection: "fmany", parts: [t("many", "My Photo.JPG", jpeg), t("many", "x.tar.gz", "x")] },

  // updates
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [t("files+", "c.txt")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [t("+files", "c.txt")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt"), t("files", "c.txt")],
    parts: [t("files+", "d.txt")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [v("files-", "$0")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [v("files-", "$0"), v("files-", "$1")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [v("files", "$1")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [v("files", "$1"), t("files", "c.txt")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [v("files", "unknown.txt")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [v("files-", "$0"), t("files+", "c.txt")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [v("files", "$1"), v("files", "$0")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [v("files", "$0"), v("files", "$1"), v("files-", "$0")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt"), t("files", "b.txt")],
    parts: [t("+files", "c.txt"), t("+files", "d.txt")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt")],
    parts: [t("files+", "big.txt", "x".repeat(1001))],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt")],
    parts: [t("files", "new ünï.txt")],
  },
  {
    collection: "fmulti",
    before: [t("files", "a.txt")],
    parts: [v("files-", "unknown.txt"), t("files+", "noext", png)],
  },
  { collection: "fsingle", before: [t("f", "a.txt")], parts: [t("f", "b.txt")] },
  { collection: "fsingle", before: [t("f", "a.txt")], parts: [v("f", "")] },
  { collection: "fsingle", before: [t("f", "a.txt")], parts: [v("f-", "$0")] },
  { collection: "fsingle", before: [t("f", "a.txt")], parts: [t("f+", "b.txt")] },
  { collection: "fsingle", before: [t("f", "a.txt")], parts: [v("f", "$0")] },
  { collection: "fsingle", before: [t("f", "a.txt")], parts: [v("f", "other.txt")] },
  { collection: "fsingle", before: [t("f", "a.txt")], parts: [t("f", "ż".repeat(200) + ".txt")] },
  { collection: "freq", before: [t("req", "a.txt")], parts: [v("req-", "$0")] },
  {
    collection: "freq",
    before: [t("req", "a.txt"), t("req", "b.txt")],
    parts: [v("req-", "$1")],
  },
  { collection: "fmime", before: [t("img", "a.png", png)], parts: [t("img+", "b.txt", "text")] },
  {
    collection: "fmime",
    before: [t("img", "a.png", png)],
    parts: [t("img+", "b.jpg", jpeg)],
  },
  {
    collection: "fsmall",
    before: [t("doc", "a.txt", "x")],
    parts: [t("doc+", "b.txt", "x".repeat(11))],
  },
];

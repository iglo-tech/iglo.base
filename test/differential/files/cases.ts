// The record file cases test/differential/files/files.test.ts sends to
// both servers, in order.
//
// A case is one request to the records API of one of the collections
// below (created through upstream's API on a copy of the vendored
// fixture). `ref` names the record a create stores or a later case
// addresses; each server keeps its own ids and file names under the ref.
// In text values and JSON bodies "$<ref>.<field>.<i>" stands for that
// server's i-th stored name of the field (the stored value is read from
// the server's last response for the ref).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fixtureDir } from "@test/scenarios/fixture";

export interface TextPart {
  name: string;
  value: string;
}

export interface FilePart {
  name: string;
  filename: string;
  content: Uint8Array;
  type?: string;
}

export type Part = TextPart | FilePart;

export interface FileCase {
  name: string;
  method: "POST" | "PATCH" | "DELETE" | "GET";
  collection: string;
  // the record a PATCH, DELETE or GET addresses, or the one a POST stores
  ref?: string;
  parts?: Part[];
  // a JSON body instead of parts
  json?: Record<string, unknown>;
  // the multipart Content-Type's boundary parameter, as written (quoted)
  quotedBoundary?: string;
  // upstream's status
  status: number;
}

const encoder = new TextEncoder();

export function text(s: string): Uint8Array {
  return encoder.encode(s);
}

// a PNG from the fixture (upstream's 300_...png)
export const png = readFileSync(
  join(fixtureDir, "storage/9n89pl5vkct6330/la4y2w4o98acwuj/300_uh_lkx91_hvb_Da8K5pl069.png"),
);

const file = (name: string, filename: string, content: Uint8Array | string): FilePart => ({
  name,
  filename,
  content: typeof content === "string" ? text(content) : content,
});

const value = (name: string, v: string): TextPart => ({ name, value: v });

// The collections, all rules "" (guests may write).
export const collections: Record<string, unknown>[] = [
  {
    name: "fsingle",
    type: "base",
    fields: [
      { name: "title", type: "text" },
      { name: "doc", type: "file", maxSelect: 1, maxSize: 1000 },
    ],
  },
  {
    name: "fmulti",
    type: "base",
    fields: [
      { name: "title", type: "text" },
      { name: "docs", type: "file", maxSelect: 3, maxSize: 100000 },
      { name: "img", type: "file", maxSelect: 1, mimeTypes: ["image/png"] },
      { name: "prot", type: "file", maxSelect: 2, protected: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_fmulti_title ON fmulti (title) WHERE title != ''"],
  },
  {
    name: "freq",
    type: "base",
    fields: [{ name: "doc", type: "file", maxSelect: 1, required: true }],
  },
  {
    name: "fchild",
    type: "base",
    fields: [
      {
        name: "parent",
        type: "relation",
        collectionId: "fmulti",
        maxSelect: 1,
        cascadeDelete: true,
      },
      { name: "att", type: "file", maxSelect: 1 },
    ],
  },
];

const longAscii = "a".repeat(290) + ".txt";
// 127 two-byte characters and "x": the 255-byte cut is a whole character
const longCutWhole = "é".repeat(127) + "x" + "é".repeat(10) + ".txt";
// two "x" and two-byte characters: byte 255 is the first half of one
const longCutInside = "xx" + "é".repeat(140) + ".txt";

export const cases: FileCase[] = [
  // single file field
  {
    name: "single: create with a file",
    status: 200,
    method: "POST",
    collection: "fsingle",
    ref: "s1",
    parts: [value("title", "one"), file("doc", "hello.txt", "hello")],
  },
  {
    name: "single: create without a file",
    status: 200,
    method: "POST",
    collection: "fsingle",
    ref: "s2",
    parts: [value("title", "none")],
  },
  {
    name: "single: maxSize failure",
    status: 400,
    method: "POST",
    collection: "fsingle",
    parts: [file("doc", "big.txt", "x".repeat(1001))],
  },
  {
    name: "single: replace the file (the old one is deleted)",
    status: 200,
    method: "PATCH",
    collection: "fsingle",
    ref: "s1",
    parts: [file("doc", "replaced.txt", "new content")],
  },
  {
    name: "single: two files for a single field keep the last one",
    status: 200,
    method: "PATCH",
    collection: "fsingle",
    ref: "s2",
    parts: [file("doc", "first.txt", "1"), file("doc", "second.txt", "2")],
  },
  {
    name: "single: remove the file with an empty value",
    status: 200,
    method: "PATCH",
    collection: "fsingle",
    ref: "s1",
    parts: [value("doc", "")],
  },
  {
    name: "single: doc- removes the file",
    status: 200,
    method: "PATCH",
    collection: "fsingle",
    ref: "s2",
    json: { "doc-": "$s2.doc.0" },
  },
  {
    name: "single: a plain new file name is refused",
    status: 400,
    method: "PATCH",
    collection: "fsingle",
    ref: "s2",
    json: { doc: "made_up_abcdefghij.txt" },
  },

  // multiple files
  {
    name: "multi: create with two docs, an image and a protected file",
    status: 200,
    method: "POST",
    collection: "fmulti",
    ref: "m1",
    parts: [
      value("title", "m1"),
      file("docs", "a.txt", "aaa"),
      file("docs", "b.md", "# b"),
      file("img", "pic.png", png),
      file("prot", "secret.txt", "secret"),
    ],
  },
  {
    name: "multi: maxSelect failure",
    status: 400,
    method: "POST",
    collection: "fmulti",
    parts: [
      file("docs", "1.txt", "1"),
      file("docs", "2.txt", "2"),
      file("docs", "3.txt", "3"),
      file("docs", "4.txt", "4"),
    ],
  },
  {
    name: "multi: mimeTypes failure",
    status: 400,
    method: "POST",
    collection: "fmulti",
    parts: [file("img", "not-a-png.png", "plain text")],
  },
  {
    name: "multi: maxSize failure on the second file",
    status: 400,
    method: "POST",
    collection: "fmulti",
    parts: [file("docs", "ok.txt", "ok"), file("docs", "huge.txt", "y".repeat(100001))],
  },
  {
    name: "multi: docs+ appends",
    status: 200,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    parts: [file("docs+", "c.txt", "ccc")],
  },
  {
    name: "multi: docs+ over maxSelect fails",
    status: 400,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    parts: [file("docs+", "d.txt", "ddd")],
  },
  {
    name: "multi: docs- removes one file",
    status: 200,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    parts: [value("docs-", "$m1.docs.1")],
  },
  {
    name: "multi: +docs prepends",
    status: 200,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    parts: [file("+docs", "first.txt", "first")],
  },
  {
    name: "multi: remove and add in one request",
    status: 200,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    parts: [value("docs-", "$m1.docs.0"), file("docs+", "e.txt", "eee")],
  },
  {
    name: "multi: set the kept names explicitly (the others are deleted)",
    status: 200,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    json: { docs: ["$m1.docs.1"] },
  },
  {
    name: "multi: text-only update keeps the files",
    status: 200,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    json: { title: "m1 renamed" },
  },
  {
    name: "multi: replace the protected files",
    status: 200,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    parts: [file("prot", "p1.txt", "p1"), file("prot", "p2.txt", "p2")],
  },
  {
    name: "multi: the same file name twice in one request",
    status: 200,
    method: "POST",
    collection: "fmulti",
    ref: "m2",
    parts: [value("title", "m2"), file("docs", "same.txt", "1"), file("docs", "same.txt", "2")],
  },
  {
    name: "multi: plain names in a JSON create are refused",
    status: 400,
    method: "POST",
    collection: "fmulti",
    json: { docs: ["a_abcdefghij.txt"] },
  },

  // failed saves leave no new files
  {
    name: "failed create (unique title) leaves no files",
    status: 400,
    method: "POST",
    collection: "fmulti",
    parts: [value("title", "m2"), file("docs", "orphan.txt", "orphan"), file("img", "o.png", png)],
  },
  {
    name: "failed update (unique title) keeps the old files and leaves no new ones",
    status: 400,
    method: "PATCH",
    collection: "fmulti",
    ref: "m1",
    parts: [value("title", "m2"), file("docs+", "orphan2.txt", "orphan2")],
  },
  {
    name: "required file missing",
    status: 400,
    method: "POST",
    collection: "freq",
    parts: [value("doc", "")],
  },
  {
    name: "required file given",
    status: 200,
    method: "POST",
    collection: "freq",
    ref: "q1",
    parts: [file("doc", "req.txt", "required")],
  },

  // file names
  {
    name: "name: non-ASCII",
    status: 200,
    method: "POST",
    collection: "fmulti",
    ref: "n1",
    parts: [file("docs", "żółw ü 😀.txt", "x"), file("docs", "日本語.md", "y")],
  },
  {
    name: "name: 300 ASCII characters",
    status: 200,
    method: "POST",
    collection: "fmulti",
    ref: "n2",
    parts: [file("docs", longAscii, "x")],
  },
  {
    name: "name: the 255-byte metadata cut between characters",
    status: 200,
    method: "POST",
    collection: "fmulti",
    ref: "n3",
    parts: [file("docs", longCutWhole, "x")],
  },
  {
    name: "name: the 255-byte metadata cut inside a character (400)",
    status: 400,
    method: "POST",
    collection: "fmulti",
    parts: [file("docs", longCutInside, "x")],
  },
  {
    name: "name: no extension, detected from the content",
    status: 200,
    method: "POST",
    collection: "fmulti",
    ref: "n4",
    parts: [file("docs", "image", png), file("docs", "notes", "plain")],
  },
  {
    name: "name: dots, double extension, spaces and symbols",
    status: 200,
    method: "POST",
    collection: "fmulti",
    ref: "n5",
    parts: [
      file("docs", ".hidden", "h"),
      file("docs", "archive.tar.gz", "gz"),
      file("docs", "My File (1)!.TXT", "t"),
    ],
  },
  {
    name: "name: quotes and backslashes",
    status: 200,
    method: "POST",
    collection: "fmulti",
    ref: "n6",
    parts: [file("docs", 'a "quoted" \\ name.txt', "q")],
  },
  {
    name: "name: an empty file",
    status: 200,
    method: "POST",
    collection: "fmulti",
    parts: [file("docs", "empty.txt", "")],
  },
  {
    name: "quoted multipart boundary with a semicolon",
    status: 200,
    method: "POST",
    collection: "fsingle",
    ref: "s3",
    quotedBoundary: '"abc;def=1"',
    parts: [value("title", "quoted"), file("doc", "q.txt", "quoted boundary")],
  },

  // deletes
  {
    name: "delete a record removes its directory",
    status: 204,
    method: "DELETE",
    collection: "fsingle",
    ref: "s3",
  },
  {
    name: "child with a file",
    status: 200,
    method: "POST",
    collection: "fchild",
    ref: "c1",
    parts: [value("parent", "$m2.id"), file("att", "child.txt", "child")],
  },
  {
    name: "cascade delete removes the child's files",
    status: 204,
    method: "DELETE",
    collection: "fmulti",
    ref: "m2",
  },
  {
    name: "delete a record with a protected file",
    status: 204,
    method: "DELETE",
    collection: "fmulti",
    ref: "m1",
  },
  {
    name: "read back a record",
    status: 200,
    method: "GET",
    collection: "fmulti",
    ref: "n1",
  },
];

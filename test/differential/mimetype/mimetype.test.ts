// MIME detection (src/tools/mimetype) against the reference PocketBase
// v0.41.0 binary. Not part of `bun test`: run `bun run test:reference`.
//
// For each corpus sample (corpus.ts), iglo.base's detect() gives a type m.
// A collection gets file fields whose mimeTypes are:
//   - accept: [m.string()], the detected type as String() gives it;
//   - base: [" " + the type without parameters in upper case + " "];
//   - alias<i>: [one of m's aliases], for each alias;
//   - reject: the strings of all m's ancestors (or "application/x-unknown"
//     for the root), which exclude m and its aliases.
// The sample is uploaded through POST /api/collections/{c}/records to each
// field alone. Upstream checks it with DetectReader and Is
// (core/validators/file.go): the upload must fail with
// validation_invalid_mime_type exactly when none of the field's mimeTypes
// satisfies m.is(); for accept, base and alias that means it is accepted,
// for reject that it is rejected (unless an ancestor has m's own type
// string, as application/json above HAR, which is.is() then accepts too).
//
// The sample is also uploaded as "sample" (no extension) to a field without
// mimeTypes. Upstream names the file with the detected Extension(), and
// stores String() as the blob's content type after mime.ParseMediaType and
// FormatMediaType (tools/filesystem, the blob writer), failing the upload
// when that parse fails. So: the upload succeeds exactly when
// parseMediaType(m.string()) does, the stored name ends with m.extension(),
// and the content type in the .attrs file is m.string() whenever formatting
// gives the same text back (no parameter, or a token parameter value).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MIME } from "@/tools/mimetype/mime";
import { parseMediaType } from "@/tools/mimetype/mediatype";
import { detect } from "@/tools/mimetype/mimetype";

import { runUpstream } from "@test/differential/db/fixture";
import { corpus, type Sample } from "@test/differential/mimetype/corpus";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const email = "mimetype@example.com";
const password = "1234567890";

let root: string;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-mimetype-ref-"));
  dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });
  const res = await fetch(`${upstream.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(res.status).toBe(200);
  token = ((await res.json()) as { token: string }).token;
});

afterAll(async () => {
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

// The value Go decodes from JSON.stringify(s): a lone surrogate (the string
// form of an invalid UTF-8 byte) arrives as U+FFFD.
function viaJSON(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}

// mime.FormatMediaType(mime.ParseMediaType(s)) when it is s itself: no
// parameters, or one parameter whose value is a token.
function formatsAsItself(s: string): boolean {
  const [, params, err] = parseMediaType(s);
  if (err !== null || params === null) {
    return false;
  }
  return [...params.values()].every((v) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(v));
}

interface Field {
  name: string;
  mimeTypes: string[];
}

function fieldsFor(m: MIME): Field[] {
  const [base] = parseMediaType(m.string());
  const ancestors: string[] = [];
  for (let p = m.parent(); p !== null; p = p.parent()) {
    ancestors.push(p.string());
  }
  return [
    { name: "accept", mimeTypes: [m.string()] },
    { name: "base", mimeTypes: [` ${base.toUpperCase()} `] },
    ...m.aliases.map((alias, i) => ({ name: `alias${i}`, mimeTypes: [alias] })),
    { name: "reject", mimeTypes: ancestors.length > 0 ? ancestors : ["application/x-unknown"] },
  ];
}

async function api(method: string, path: string, body: string | FormData) {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const res = await fetch(`${upstream.url}${path}`, {
    method,
    headers: {
      authorization: token,
      ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

// Upstream reloads its whole collection cache after each collection save,
// from a snapshot read inside the save. Two saves at once can leave a cache
// without the other one's collection (a 404 "Missing or invalid collection
// context." on its next upload), so collections are created one at a time;
// uploads still run concurrently.
let schemaLock: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = schemaLock.then(fn, fn);
  schemaLock = run.catch(() => undefined);
  return run;
}

async function check(sample: Sample, i: number): Promise<string[]> {
  const problems: string[] = [];
  const m = detect(sample.data);
  const fields = fieldsFor(m);
  const name = `m${i}`;
  const created = await serialized(() =>
    api(
      "POST",
      "/api/collections",
      JSON.stringify({
        name,
        type: "base",
        fields: [
          { name: "plain", type: "file", maxSelect: 1, maxSize: 1 << 24 },
          ...fields.map((f) => ({
            name: f.name,
            type: "file",
            maxSelect: 1,
            maxSize: 1 << 24,
            mimeTypes: f.mimeTypes,
          })),
        ],
      }),
    ),
  );
  if (created.status !== 200) {
    return [`create collection: ${created.status} ${created.text}`];
  }
  const collectionId = (JSON.parse(created.text) as { id: string }).id;

  const upload = (field: string) => {
    const form = new FormData();
    form.append(field, new Blob([sample.data]), "sample");
    return api("POST", `/api/collections/${name}/records`, form);
  };

  for (const f of fields) {
    const accepted = f.mimeTypes.some((t) => m.is(viaJSON(t)));
    const res = await upload(f.name);
    const body = JSON.parse(res.text) as { data?: Record<string, { code?: string }> };
    const rejected = body.data?.[f.name]?.code === "validation_invalid_mime_type";
    if (rejected === accepted) {
      problems.push(
        `${f.name} ${JSON.stringify(f.mimeTypes)}: iglo.base ${accepted ? "accepts" : "rejects"}, upstream ${res.status} ${res.text}`,
      );
    }
  }

  const stored = parseMediaType(m.string())[2] === null;
  const plain = await upload("plain");
  if ((plain.status === 200) !== stored) {
    problems.push(
      `plain upload: iglo.base ${stored ? "stores" : "fails"}, upstream ${plain.status} ${plain.text}`,
    );
  }
  if (plain.status === 200) {
    const record = JSON.parse(plain.text) as { id: string; plain: string };
    const ext = record.plain.slice("sample_".length + 10);
    if (ext !== m.extension()) {
      problems.push(`extension: iglo.base ${m.extension()}, upstream ${record.plain}`);
    }
    if (formatsAsItself(m.string())) {
      const attrs = JSON.parse(
        readFileSync(
          join(dataDir, "storage", collectionId, record.id, `${record.plain}.attrs`),
          "utf8",
        ),
      ) as Record<string, unknown>;
      if (attrs["user.content_type"] !== m.string()) {
        problems.push(
          `content type: iglo.base ${m.string()}, upstream ${String(attrs["user.content_type"])}`,
        );
      }
    }
  }
  return problems.map((p) => `${sample.name} (${m.string()}): ${p}`);
}

test("uploads are accepted and rejected by mimeTypes as iglo.base's detection predicts", async () => {
  expect(corpus.length).toBeGreaterThanOrEqual(200);
  const problems: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < corpus.length) {
      const i = next++;
      problems.push(...(await check(corpus[i] as Sample, i)));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  expect(problems).toEqual([]);
}, 600_000);

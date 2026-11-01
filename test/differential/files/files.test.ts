// Record files (src/fields/file.ts, src/tools/filesystem, the multipart
// spill and the storage deletes) against the reference PocketBase v0.41.0
// binary. Not part of `bun test`: run `bun run test:reference`.
//
// Setup: upstream creates the collections of cases.ts on a copy of the
// vendored fixture; both servers then serve their own copy of that
// pb_data. Every case is sent to both (each with its own record ids and
// stored file names, see cases.ts). After each case:
//
//   - the responses must be equal, except for generated values: a new
//     record's id, its created/updated (by format) and the random parts of
//     generated file names (same length, differing only in [a-z0-9]
//     characters). Each upstream value pairs with one iglo.base value
//     across the whole run;
//   - pb_data/storage of the test collections must hold the same files on
//     both sides, with iglo.base's ids and names mapped to upstream's
//     through those pairs, and every file and `.attrs` sidecar must be
//     byte-identical (`.attrs` holds the content type, the original name
//     and the MD5).
//
// Round trips: (a) upstream on a copy of iglo.base's pb_data lists the
// records, serves every stored file (GET /api/files/...) with the bytes and
// content type upstream serves for its own, and replaces and deletes them;
// (b) iglo.base on a copy of upstream's pb_data keeps, replaces and
// deletes upstream's files. Collection delete has no HTTP endpoint in
// iglo.base yet (M3.4); test/app/filesystem.test.ts covers it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cases, collections, png } from "@test/differential/files/cases";
import {
  compareJSON,
  compareRes,
  multipartBody,
  Pairing,
  req,
  type Res,
  sendCase,
  type Side,
} from "@test/differential/files/record-requests";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { startServer, type RunningServer } from "@test/support/executable";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

// -------------------------------------------------------------------
// storage trees

// relative path -> bytes, for every file under dir
function tree(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!existsSync(dir)) {
    return out;
  }
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isFile()) {
      out.set(name, readFileSync(path));
    } else if (st.isDirectory() && readdirSync(path).length === 0) {
      out.set(name + "/", new Uint8Array());
    }
  }
  return out;
}

function compareStorage(
  upDir: string,
  igDir: string,
  collectionIds: string[],
  pairing: Pairing,
): string[] {
  const out: string[] = [];
  for (const cid of collectionIds) {
    const up = tree(join(upDir, "storage", cid));
    const ig = tree(join(igDir, "storage", cid));
    const mapped = new Map<string, Uint8Array>();
    for (const [path, bytes] of ig) {
      const upPath = path
        .split("/")
        .map((seg) => {
          const attrs = seg.endsWith(".attrs") ? ".attrs" : "";
          const base = attrs === "" ? seg : seg.slice(0, -attrs.length);
          return (pairing.backward.get(base) ?? base) + attrs;
        })
        .join("/");
      mapped.set(upPath, bytes);
    }
    const upKeys = [...up.keys()].toSorted();
    const igKeys = [...mapped.keys()].toSorted();
    if (upKeys.join("\n") !== igKeys.join("\n")) {
      out.push(
        `storage/${cid}: upstream [${upKeys.join(", ")}] != iglo.base [${igKeys.join(", ")}]`,
      );
      continue;
    }
    for (const k of upKeys) {
      const a = up.get(k) as Uint8Array;
      const b = mapped.get(k) as Uint8Array;
      if (Buffer.compare(a, b) !== 0) {
        out.push(
          `storage/${cid}/${k}: bytes differ: ${new TextDecoder().decode(a).slice(0, 300)} != ${new TextDecoder().decode(b).slice(0, 300)}`,
        );
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------

function items(r: Res): Record<string, unknown>[] {
  return (JSON.parse(r.text) as { items: Record<string, unknown>[] }).items;
}

function byId(x: Record<string, unknown>, y: Record<string, unknown>): number {
  return String(x.id).localeCompare(String(y.id));
}

const roots: string[] = [];
const running: { stop(): Promise<unknown> }[] = [];

afterAll(async () => {
  await Promise.allSettled(running.map((s) => s.stop()));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-files-"));
  roots.push(root);
  return root;
}

async function stop(server: { stop(): Promise<unknown> }): Promise<void> {
  await server.stop();
  running.splice(running.indexOf(server), 1);
}

describe("record files", () => {
  let baseDir: string;
  let upDir: string;
  let igDir: string;
  let upstream: UpstreamServer;
  let igloBase: RunningServer;
  const collectionIds = new Map<string, string>();
  const pairing = new Pairing();
  const up: Side = { url: "", records: new Map() };
  const ig: Side = { url: "", records: new Map() };

  beforeAll(async () => {
    const root = newRoot();
    baseDir = join(root, "base", "pb_data");
    copyDataDir(fixtureDir, baseDir);
    const setup = await startUpstream({ dataDir: baseDir });
    running.push(setup);
    try {
      for (const def of collections) {
        const body = JSON.parse(JSON.stringify(def)) as { fields: Record<string, unknown>[] };
        for (const f of body.fields) {
          if (typeof f.collectionId === "string") {
            f.collectionId = collectionIds.get(f.collectionId);
          }
        }
        const res = await req(
          setup.url,
          "POST",
          "/api/collections",
          JSON.stringify({
            ...body,
            listRule: "",
            viewRule: "",
            createRule: "",
            updateRule: "",
            deleteRule: "",
          }),
          "application/json",
        );
        if (res.status !== 200) {
          throw new Error(`collection ${String(def.name)}: ${res.status} ${res.text}`);
        }
        collectionIds.set(def.name as string, (JSON.parse(res.text) as { id: string }).id);
      }
    } finally {
      await stop(setup);
    }

    upDir = join(root, "upstream", "pb_data");
    igDir = join(root, "iglo-base", "pb_data");
    copyDataDir(baseDir, upDir);
    copyDataDir(baseDir, igDir);
    [upstream, igloBase] = await Promise.all([
      startUpstream({ dataDir: upDir }),
      startServer([], igDir),
    ]);
    running.push(upstream, igloBase);
    up.url = upstream.url;
    ig.url = igloBase.url;
  }, 60_000);

  for (const c of cases) {
    test(c.name, async () => {
      const upRes = await sendCase(c, up);
      const igRes = await sendCase(c, ig);
      const diffs = compareRes(upRes, igRes, pairing);

      // the background storage delete after a record delete
      await Bun.sleep(c.method === "DELETE" ? 300 : 50);

      // the stored record reads back the same
      if (upRes.status === 200 && c.ref !== undefined && c.method !== "DELETE") {
        const path = `/api/collections/${c.collection}/records/`;
        const [a, b] = await Promise.all([
          req(up.url, "GET", path + String(up.records.get(c.ref)?.id)),
          req(ig.url, "GET", path + String(ig.records.get(c.ref)?.id)),
        ]);
        diffs.push(...compareRes(a, b, pairing).map((d) => `read back: ${d}`));
      }

      diffs.push(...compareStorage(upDir, igDir, [...collectionIds.values()], pairing));
      expect({ status: upRes.status, diffs }).toEqual({ status: c.status, diffs: [] });
    });
  }

  test("cases cover successes and failures", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  // (a) upstream reads, serves, replaces and deletes iglo.base's files
  test("round trip: upstream on iglo.base's pb_data", async () => {
    await stop(igloBase);
    await stop(upstream);
    const root = newRoot();
    const fromIglo = join(root, "pb_data");
    copyDataDir(igDir, fromIglo);
    const [onIglo, onOwn] = await Promise.all([
      startUpstream({ dataDir: fromIglo }),
      startUpstream({ dataDir: upDir }),
    ]);
    running.push(onIglo, onOwn);
    const diffs: string[] = [];
    try {
      // every record lists the same
      for (const name of collectionIds.keys()) {
        const path = `/api/collections/${name}/records?perPage=500`;
        const [a, b] = await Promise.all([
          req(onOwn.url, "GET", path),
          req(onIglo.url, "GET", path),
        ]);
        if (a.status !== 200) {
          diffs.push(`${name}: list ${a.status}`);
        }
        const key = (x: Record<string, unknown>): string =>
          pairing.backward.get(String(x.id)) ?? String(x.id);
        compareJSON(
          items(a).toSorted(byId),
          items(b).toSorted((x, y) => key(x).localeCompare(key(y))),
          name,
          pairing,
          diffs,
        );
      }

      // every stored file is served with the same bytes and content type
      let served = 0;
      for (const [ref, rec] of ig.records) {
        const upRec = up.records.get(ref);
        if (upRec === undefined) {
          continue;
        }
        const collection = String(rec.collectionName);
        for (const field of ["doc", "docs", "img", "att"]) {
          const names = ([] as unknown[])
            .concat(rec[field] ?? [])
            .filter((n) => n !== "") as string[];
          const upNames = ([] as unknown[])
            .concat(upRec[field] ?? [])
            .filter((n) => n !== "") as string[];
          for (const [i, n] of names.entries()) {
            const [a, b] = await Promise.all([
              req(
                onOwn.url,
                "GET",
                `/api/files/${collection}/${String(upRec.id)}/${encodeURIComponent(upNames[i] as string)}`,
              ),
              req(
                onIglo.url,
                "GET",
                `/api/files/${collection}/${String(rec.id)}/${encodeURIComponent(n)}`,
              ),
            ]);
            if (
              a.status !== b.status ||
              a.contentType !== b.contentType ||
              Buffer.compare(a.body, b.body) !== 0
            ) {
              diffs.push(
                `${ref}.${field}.${i}: ${a.status} ${a.contentType} / ${b.status} ${b.contentType}`,
              );
            }
            served++;
          }
        }
      }
      expect(served).toBeGreaterThan(5);

      // upstream replaces and deletes iglo.base's files
      const n5 = ig.records.get("n5") as Record<string, unknown>;
      const n5Dir = join(fromIglo, "storage", collectionIds.get("fmulti") as string, String(n5.id));
      const oldNames = n5.docs as string[];
      const patch = await req(
        onIglo.url,
        "PATCH",
        `/api/collections/fmulti/records/${String(n5.id)}`,
        JSON.stringify({ "docs-": [oldNames[0]] }),
        "application/json",
      );
      expect(patch.status).toBe(200);
      expect(existsSync(join(n5Dir, oldNames[0] as string))).toBe(false);
      expect(existsSync(join(n5Dir, (oldNames[0] as string) + ".attrs"))).toBe(false);
      expect(existsSync(join(n5Dir, oldNames[1] as string))).toBe(true);
      const del = await req(
        onIglo.url,
        "DELETE",
        `/api/collections/fmulti/records/${String(n5.id)}`,
      );
      expect(del.status).toBe(204);
      await Bun.sleep(300);
      expect(existsSync(n5Dir)).toBe(false);
    } finally {
      await stop(onIglo);
      await stop(onOwn);
    }
    expect(diffs).toEqual([]);
  }, 60_000);

  // (b) iglo.base keeps, replaces and deletes upstream's files
  test("round trip: iglo.base on upstream's pb_data", async () => {
    const root = newRoot();
    const fromUp = join(root, "pb_data");
    copyDataDir(upDir, fromUp);
    const server = await startServer([], fromUp);
    running.push(server);
    try {
      const fmulti = collectionIds.get("fmulti") as string;
      const n1 = up.records.get("n1") as Record<string, unknown>;
      const n4 = up.records.get("n4") as Record<string, unknown>;
      const n1Dir = join(fromUp, "storage", fmulti, String(n1.id));
      const n4Dir = join(fromUp, "storage", fmulti, String(n4.id));
      const n1Before = tree(n1Dir);

      // replace: the old upstream file and its .attrs go, the other stays
      const [first, second] = n4.docs as string[];
      const body = multipartBody(
        [
          { name: "docs-", value: first as string },
          { name: "docs+", filename: "new.png", content: png },
        ],
        "roundtripboundary",
        { url: "", records: new Map() },
      );
      const patch = await req(
        server.url,
        "PATCH",
        `/api/collections/fmulti/records/${String(n4.id)}`,
        body,
        "multipart/form-data; boundary=roundtripboundary",
      );
      expect(patch.status).toBe(200);
      const saved = JSON.parse(patch.text) as { docs: string[] };
      expect(saved.docs[0]).toBe(second as string);
      expect(existsSync(join(n4Dir, first as string))).toBe(false);
      expect(existsSync(join(n4Dir, (first as string) + ".attrs"))).toBe(false);
      expect(existsSync(join(n4Dir, second as string))).toBe(true);
      expect(existsSync(join(n4Dir, saved.docs[1] as string))).toBe(true);

      // delete: the record's directory goes
      const del = await req(
        server.url,
        "DELETE",
        `/api/collections/fmulti/records/${String(n4.id)}`,
      );
      expect(del.status).toBe(204);
      await Bun.sleep(300);
      expect(existsSync(n4Dir)).toBe(false);

      // an untouched record's files are kept as they are
      const n1After = tree(n1Dir);
      expect([...n1After.keys()].toSorted()).toEqual([...n1Before.keys()].toSorted());
      for (const [k, v] of n1Before) {
        expect(Buffer.compare(n1After.get(k) as Uint8Array, v)).toBe(0);
      }
    } finally {
      await stop(server);
    }
  }, 60_000);
});

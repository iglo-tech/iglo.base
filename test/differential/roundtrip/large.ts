// bun run test:roundtrip:large [-- --records <n>]
//
// The round trip on a generated dataset: a fresh install, on which each of the
// first two legs writes <n> records (20,000 by default) through the API and
// the last leg 10% of that, next to the suite's whole scenario, and the same
// comparisons as roundtrip.test.ts. Not part of `bun run test:reference`.
//
// Every record's values come from a seeded generator, so a control and a
// subject run write the same data. Most records go through the batch API, as
// bulk writes do; every 40th is a multipart create with a file.

import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { Rng } from "@test/differential/fuzz/rng";
import { rid } from "@test/differential/resolver/schema";
import {
  type Client,
  freshStart,
  freshSuperuser,
  roundTrip,
  type RoundTripScenario,
  signedIn,
} from "@test/differential/roundtrip/run";
import { file, picture, tags, writeScenario } from "@test/differential/roundtrip/scenario";
import { sharedSmtpSink } from "@test/support/smtp-sink";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { records: { type: "string", default: "20000" } },
});
const recordCount = Number(values.records);

const seed = 3600;
const batchSize = 50;
const words = ["alfa", "żółw", "gamma", "delta 😀", "epsilon", "ζήτα", "eta", "theta"];
const maxDiskBytes = 1024 ** 3;

function recordId(tag: string, n: number): string {
  return rid(`${tag}g${String(n).padStart(8, "0")}`);
}

// a record's fields, the same in every run
function recordBody(rng: Rng, tag: string, n: number): Record<string, unknown> {
  const owner = n > 0 && rng.chance(0.5) ? recordId(tag, rng.int(n)) : "";
  const many: string[] = [];
  if (n > 0) {
    for (let i = rng.int(4); i > 0; i--) {
      many.push(recordId(tag, rng.int(n)));
    }
  }
  return {
    id: recordId(tag, n),
    title: `${rng.pick(words)} ${n}`,
    body: `<p>${rng.pick(words)}</p>`.repeat(1 + rng.int(8)),
    n: rng.chance(0.2) ? rng.int(1000) : rng.int(2_000_000) / 1000 - 1000,
    flag: rng.chance(0.5),
    at: rng.chance(0.1)
      ? ""
      : `20${10 + rng.int(20)}-0${1 + rng.int(9)}-1${rng.int(9)} 12:00:00.000Z`,
    picks: ["a", "b", "c", "d"].filter(() => rng.chance(0.4)),
    data: rng.chance(0.1)
      ? null
      : { [String(rng.int(100))]: rng.pick(words), "1": n, nested: { "10": [n, rng.next()] } },
    point: { lon: rng.int(360_000) / 1000 - 180, lat: rng.int(180_000) / 1000 - 90 },
    owner,
    many,
  };
}

async function createCollection(c: Client, tag: string): Promise<string> {
  const name = `big${tag}_items`;
  const created = await c.post("/api/collections", {
    name,
    type: "base",
    listRule: "",
    viewRule: "",
    fields: [
      { name: "title", type: "text" },
      { name: "body", type: "editor" },
      { name: "n", type: "number" },
      { name: "flag", type: "bool" },
      { name: "at", type: "date" },
      { name: "picks", type: "select", values: ["a", "b", "c", "d"], maxSelect: 4 },
      { name: "data", type: "json" },
      { name: "point", type: "geoPoint" },
      { name: "doc", type: "file", maxSelect: 2, maxSize: 1048576 },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      `CREATE INDEX idx_big${tag}_n ON ${name} (n)`,
      `CREATE INDEX idx_big${tag}_at ON ${name} (at, flag)`,
    ],
  });
  const id = created.id as string;
  await c.patch(`/api/collections/${name}`, {
    fields: [
      ...(await c.get(`/api/collections/${name}`)).fields,
      { name: "owner", type: "relation", collectionId: id, maxSelect: 1 },
      { name: "many", type: "relation", collectionId: id, maxSelect: 3 },
    ],
  });
  return id;
}

async function writeRecords(c: Client, tag: string, count: number): Promise<void> {
  const name = `big${tag}_items`;
  const path = `/api/collections/${name}/records`;
  const rng = new Rng(seed, tags.indexOf(tag));
  let pending: { method: string; url: string; body: unknown }[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length > 0) {
      await c.post("/api/batch", { requests: pending });
      pending = [];
    }
  };
  for (let n = 0; n < count; n++) {
    const body = recordBody(rng, tag, n);
    if (n % 40 === 0) {
      // the references must exist before this request
      await flush();
      const form = new FormData();
      form.append("@jsonPayload", JSON.stringify(body));
      form.append(
        "doc",
        n % 200 === 0
          ? picture(`image-${n}.png`)
          : file(`file-${n}.txt`, `${rng.pick(words)}\n`.repeat(1 + rng.int(800))),
      );
      await c.request("POST", path, { form });
      continue;
    }
    pending.push({ method: "POST", url: path, body });
    if (pending.length === batchSize) {
      await flush();
    }
  }
  await flush();

  // later writes to what is there: modifiers, then deletes
  for (let n = 0; n + 1 < count / 10; n++) {
    pending.push({
      method: "PATCH",
      url: `${path}/${recordId(tag, 1 + rng.int(count - 1))}`,
      body: { "n+": 1, title: `updated ${n}`, "picks+": "a" },
    });
    if (pending.length === batchSize) {
      await flush();
    }
  }
  await flush();
  for (let n = count - 1; n > count - 1 - Math.ceil(count / 100); n--) {
    if (n % 40 !== 0) {
      pending.push({ method: "DELETE", url: `${path}/${recordId(tag, n)}`, body: undefined });
    }
    if (pending.length === batchSize) {
      await flush();
    }
  }
  await flush();
}

function generated(smtpPort: number): RoundTripScenario {
  const whole = writeScenario({ smtpPort, superuser: freshSuperuser });
  return {
    ...whole,
    async leg(c, leg) {
      await whole.leg(c, leg);
      const tag = tags[leg] as string;
      await createCollection(c, tag);
      await writeRecords(c, tag, leg === 2 ? Math.ceil(recordCount / 10) : recordCount);
    },
  };
}

function diskBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    total += lstatSync(join(dir, name)).size;
  }
  return total;
}

const root = mkdtempSync(join(tmpdir(), "iglo-base-roundtrip-large-"));
let exitCode = 0;
try {
  const started = Date.now();
  const outcome = await roundTrip(
    await freshStart(root),
    signedIn(generated(sharedSmtpSink().port)),
  );
  const bytes = diskBytes(outcome.control.dataDir) + diskBytes(outcome.subject.dataDir);
  const rows = (outcome.subjectSnapshot.sections.get(`table biga_items`) ?? []).length;
  console.log(
    `${rows} records in the first leg's collection, ${(bytes / 1024 ** 2).toFixed(0)} MiB on disk for both runs, ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  if (bytes > maxDiskBytes) {
    console.log(`more than ${maxDiskBytes} bytes on disk`);
    exitCode = 1;
  }
  for (const difference of outcome.differences.slice(0, 60)) {
    console.log(difference);
  }
  if (outcome.differences.length > 0) {
    console.log(`${outcome.differences.length} differences`);
    exitCode = 1;
  } else {
    console.log("no differences");
  }
  outcome.control.remove();
  outcome.subject.remove();
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);

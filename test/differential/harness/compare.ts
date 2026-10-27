// Compares upstream's and iglo.base's responses to the same scenario request
// after normalization. The normalization rules are code, below; a later task
// that needs a new rule adds a function to `rules` (or a header to
// `comparedHeaders`) in this file.
//
// What is compared:
//
// - the status code;
// - the headers in `comparedHeaders`, by value (or both absent);
// - the body: when both bodies are JSON, structurally (see compareJson);
//   otherwise byte for byte.
//
// Structural JSON comparison: the same kind of value; literals and numbers
// by their exact text (so 1 and 1.0 differ, as they do on the wire);
// strings by their decoded value (escaping does not matter); arrays item by
// item; objects by their member names, in order, then member by member.
// Before that default, the first rule in `rules` that applies to the
// upstream value decides instead:
//
// - jsonFieldValues: a `json` field value of a record (an object with a
//   `collectionId` whose collection has a json field of that name in the
//   starting data) is compared as raw bytes, because iglo.base passes
//   stored JSON through as text (AGENTS.md);
// - generatedValues: an ID, token or timestamp that is not in the starting
//   data was generated while serving the request, so iglo.base's value only
//   has to have the same format and not be in the starting data either.
//   Within one scenario the pairing must be consistent: an upstream value
//   always pairs with the same iglo.base value and the other way around, so
//   that equal values stay equal and different ones stay different. Values
//   from the starting data (fixture IDs, stored timestamps) fall through to
//   the default and must match exactly.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseJson, type JsonNode } from "@test/scenarios/json";
import type { ScenarioResponse } from "@test/scenarios/request";

// content-type and upstream's securityHeaders (apis/middlewares.go)
export const comparedHeaders = [
  "content-type",
  "x-xss-protection",
  "x-content-type-options",
  "x-frame-options",
  "cross-origin-opener-policy",
];

// What both servers start from: the scenario's prepared fixture copy.
export interface StartingData {
  // whether the text occurs in the starting databases
  contains(text: string): boolean;
  // json field names, by collection id
  jsonFields: Map<string, Set<string>>;
}

// Reads the starting data from a pb_data directory that no server uses
// (opening it may add -shm and -wal files). The copy is opened read-write:
// macOS's system SQLite cannot open a WAL database read-only without an
// existing -shm file.
export function readStartingData(dataDir: string): StartingData {
  const bytes = Buffer.concat(
    ["data.db", "auxiliary.db"].map((name) => readFileSync(join(dataDir, name))),
  );
  const jsonFields = new Map<string, Set<string>>();
  const db = new Database(join(dataDir, "data.db"));
  try {
    const rows = db.query("SELECT id, fields FROM _collections").all() as {
      id: string;
      fields: string;
    }[];
    for (const row of rows) {
      const fields = JSON.parse(row.fields) as { name: string; type: string }[];
      jsonFields.set(row.id, new Set(fields.filter((f) => f.type === "json").map((f) => f.name)));
    }
  } finally {
    db.close();
  }
  return { contains: (value) => bytes.includes(value), jsonFields };
}

export interface Format {
  name: string;
  pattern: RegExp;
}

// formats of generated values (core/record_model.go default id, JWTs,
// tools/types DateTime's JSON form)
export const formats: Format[] = [
  { name: "id", pattern: /^[a-z0-9]{15}$/ },
  { name: "token", pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ },
  { name: "timestamp", pattern: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/ },
];

// where a value is in a body
export interface Location {
  // e.g. ["items", 0, "id"]
  path: (string | number)[];
  // the objects that contain it, innermost last
  parents: Extract<JsonNode, { kind: "object" }>[];
  start: StartingData;
}

export type Comparison = { by: "raw" } | { by: "format"; format: Format };

export type Rule = (upstream: JsonNode, at: Location) => Comparison | undefined;

const jsonFieldValues: Rule = (_upstream, at) => {
  const record = at.parents.at(-1);
  const name = at.path.at(-1);
  const collectionId = record?.entries.find(([key]) => key === "collectionId")?.[1];
  if (typeof name === "string" && collectionId?.kind === "string") {
    if (at.start.jsonFields.get(collectionId.value)?.has(name)) {
      return { by: "raw" };
    }
  }
  return undefined;
};

const generatedValues: Rule = (upstream, at) => {
  if (upstream.kind !== "string" || at.start.contains(upstream.value)) {
    return undefined;
  }
  const format = formats.find((f) => f.pattern.test(upstream.value));
  return format && { by: "format", format };
};

export const rules: Rule[] = [jsonFieldValues, generatedValues];

// Generated values paired so far in one scenario, per format.
export class Pairing {
  private readonly forward = new Map<string, string>();
  private readonly backward = new Map<string, string>();

  // false if either value is already paired with another one
  pair(format: Format, upstream: string, igloBase: string): boolean {
    const up = `${format.name}:${upstream}`;
    const ig = `${format.name}:${igloBase}`;
    const known = this.forward.get(up);
    if (known !== undefined || this.backward.has(ig)) {
      return known === ig;
    }
    this.forward.set(up, ig);
    this.backward.set(ig, up);
    return true;
  }
}

// The differences between the two responses, one line each.
export function compareResponses(
  upstream: ScenarioResponse,
  igloBase: ScenarioResponse,
  start: StartingData,
  pairing = new Pairing(),
): string[] {
  const differences: string[] = [];
  if (upstream.status !== igloBase.status) {
    differences.push(`status: upstream ${upstream.status}, iglo.base ${igloBase.status}`);
  }
  for (const name of comparedHeaders) {
    const up = upstream.headers.get(name);
    const ig = igloBase.headers.get(name);
    if (up !== ig) {
      differences.push(`header ${name}: upstream ${show(up)}, iglo.base ${show(ig)}`);
    }
  }

  const upJson = tryParse(upstream.body);
  const igJson = tryParse(igloBase.body);
  if (upJson && igJson) {
    compareJson(upJson, igJson, { path: [], parents: [], start }, pairing, differences);
  } else if (upJson || igJson) {
    differences.push(
      `body: upstream ${upJson ? "is" : "is not"} JSON, iglo.base ${igJson ? "is" : "is not"}`,
    );
  } else if (!Buffer.from(upstream.body).equals(Buffer.from(igloBase.body))) {
    differences.push(
      `body: upstream ${show(text(upstream.body))}, iglo.base ${show(text(igloBase.body))}`,
    );
  }
  return differences;
}

export function compareJson(
  up: JsonNode,
  ig: JsonNode,
  at: Location,
  pairing: Pairing,
  differences: string[],
): void {
  const where = at.path.length === 0 ? "body" : `body ${at.path.join(".")}`;
  const differ = (detail: string) =>
    differences.push(`${where}: ${detail}: upstream ${up.raw}, iglo.base ${ig.raw}`);

  const comparison = rules.reduce<Comparison | undefined>(
    (found, rule) => found ?? rule(up, at),
    undefined,
  );
  if (comparison?.by === "raw") {
    if (up.raw !== ig.raw) {
      differ("raw JSON differs");
    }
    return;
  }
  if (comparison?.by === "format") {
    const { format } = comparison;
    if (up.kind !== "string" || ig.kind !== "string" || !format.pattern.test(ig.value)) {
      differ(`not both ${format.name}s`);
    } else if (at.start.contains(ig.value)) {
      differ(`generated ${format.name} expected, iglo.base's is in the starting data`);
    } else if (!pairing.pair(format, up.value, ig.value)) {
      differ(`${format.name}s not paired consistently`);
    }
    return;
  }

  if (up.kind !== ig.kind) {
    differ("different kinds");
    return;
  }
  if (up.kind === "string" && ig.kind === "string") {
    if (up.value !== ig.value) {
      differ("different strings");
    }
  } else if (up.kind === "array" && ig.kind === "array") {
    if (up.items.length !== ig.items.length) {
      differ(`${up.items.length} items vs ${ig.items.length}`);
      return;
    }
    up.items.forEach((item, i) => {
      compareJson(
        item,
        ig.items[i] as JsonNode,
        { ...at, path: [...at.path, i] },
        pairing,
        differences,
      );
    });
  } else if (up.kind === "object" && ig.kind === "object") {
    const upNames = up.entries.map(([name]) => name);
    const igNames = ig.entries.map(([name]) => name);
    if (upNames.join("\0") !== igNames.join("\0")) {
      differ(`members [${upNames.join(", ")}] vs [${igNames.join(", ")}]`);
      return;
    }
    up.entries.forEach(([name, value], i) => {
      const inner = { path: [...at.path, name], parents: [...at.parents, up], start: at.start };
      compareJson(value, (ig.entries[i] as [string, JsonNode])[1], inner, pairing, differences);
    });
  } else if (up.raw !== ig.raw) {
    differ("different values");
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function tryParse(body: Uint8Array): JsonNode | undefined {
  try {
    return parseJson(utf8.decode(body));
  } catch {
    return undefined;
  }
}

function text(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function show(value: string | null): string {
  return value === null ? "(absent)" : JSON.stringify(value);
}

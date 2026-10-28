// Compares upstream's and iglo.base's responses to the same scenario request
// after normalization. The normalization rules are code, below; a later task
// that needs a new rule adds a key to `generatedKeys`, a function to `rules`
// or `unorderedObjects`, or a header to `comparedHeaders` in this file.
//
// What is compared:
//
// - the status code;
// - the headers in `comparedHeaders`, by value (or both absent);
// - the body, byte for byte, after generated values are replaced and the
//   members of unordered objects sorted (both below). iglo.base must
//   produce byte-identical JSON: member order, whitespace, string escaping,
//   number text and the text of `json` field values are part of the API
//   contract, whatever `fields` projects. When the bodies differ, a
//   structural diff reports where (see compareJson).
//
// Only API JSON responses are normalized: upstream's content-type is
// application/json and the request is not a file download (/api/files/...,
// whose bytes are the stored file's, whatever it contains). Every other body
// is compared byte for byte as it is.
//
// Generated values: a value upstream generates while serving the request
// (a new record's id, its created and updated timestamps, an auth token)
// differs from run to run, so it is compared by format only. When both
// bodies are JSON, a string is a generated value when
//
// - it sits at a key in `generatedKeys` (or one a function in `rules`
//   picks), has that key's format, is not in the starting data and is not
//   sent by the scenario in its URL or body; iglo.base's value at the same
//   place must have the same format and not be in the starting data or the
//   request either. Within one scenario the pairing must be consistent: an
//   upstream value always pairs with the same iglo.base value and the other
//   way around, so that equal values stay equal and different ones stay
//   different.
// - or it equals, as a whole JSON string, a value paired that way anywhere
//   in the scenario's responses (a relation to a new record's id).
//
// Each paired value is replaced by the same placeholder on both sides
// before the byte comparison. Everything else compares exactly: ordinary
// request data (a title that looks like an id), values from the starting
// data (fixture IDs, stored timestamps) and values the scenario sends.
//
// Unordered objects: upstream encodes a Go map with json/v2 and, unless it
// asks for json.Deterministic, the member order changes from response to
// response. The objects a function in `unorderedObjects` picks have their
// members sorted by name on both sides before the byte comparison; each
// member keeps its bytes (and the whitespace around it).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseJson, type JsonNode } from "@test/scenarios/json";
import type { ScenarioResponse } from "@test/scenarios/request";
import type { Scenario } from "@test/scenarios/scenario";

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
}

// Reads the starting data from a pb_data directory that no server uses.
export function readStartingData(dataDir: string): StartingData {
  const bytes = Buffer.concat(
    ["data.db", "data.db-wal", "auxiliary.db", "auxiliary.db-wal"]
      .map((name) => join(dataDir, name))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path)),
  );
  return { contains: (value) => bytes.includes(value) };
}

export interface Format {
  name: string;
  pattern: RegExp;
}

// formats of generated values
const id: Format = { name: "id", pattern: /^[a-z0-9]{15}$/ }; // core.GenerateDefaultRandomId
const token: Format = {
  name: "token",
  pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
}; // JWT
const timestamp: Format = {
  name: "timestamp",
  pattern: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/,
}; // types.DateTime's JSON form
const random = (length: number): Format => ({
  name: `random${length}`,
  pattern: new RegExp(`^[A-Za-z0-9]{${length}}$`),
}); // security.RandomString
const challenge: Format = { name: "challenge", pattern: /^[A-Za-z0-9_-]{43}$/ }; // security.S256Challenge

// Keys whose values upstream generates, with their format.
export const generatedKeys = new Map<string, Format>([
  // records (core/record_model.go: id, autodate fields named as in new
  // collections), collections (core/collection_model.go), logs
  // (core/log_model.go)
  ["id", id],
  ["created", timestamp],
  ["updated", timestamp],
  // auth responses (apis/record_helpers.go), file tokens (apis/file.go)
  ["token", token],
  // apis/record_auth_otp_request.go, apis/record_helpers.go (mfa)
  ["otpId", id],
  ["mfaId", id],
  // apis/record_auth_methods.go
  ["state", random(30)],
  ["codeVerifier", random(43)],
  ["codeChallenge", challenge],
  // apis/realtime.go (tools/subscriptions/client.go)
  ["clientId", random(40)],
]);

// What a rule sees of the scenario.
export interface Context {
  start: StartingData;
  // the scenario's request
  request: Pick<Scenario, "url" | "body" | "headers">;
}

// where a value is in a body
export interface Location {
  // e.g. ["items", 0, "id"]
  path: (string | number)[];
  // the objects that contain it, innermost last
  parents: Extract<JsonNode, { kind: "object" }>[];
  context: Context;
  // upstream's status code
  status: number;
}

// The format of a generated value expected at this location, if any.
export type Rule = (upstream: JsonNode, at: Location) => Format | undefined;

const atGeneratedKey: Rule = (_upstream, at) => {
  const key = at.path.at(-1);
  return typeof key === "string" ? generatedKeys.get(key) : undefined;
};

export const rules: Rule[] = [atGeneratedKey];

// Whether upstream writes the object's members in a random order.
export type OrderRule = (object: JsonNode, at: Location) => boolean;

// `fields` on a successful response (tools/router/event.go JSON): picker.Pick
// decodes the whole response into map[string]any, so every object, the
// values of `json` fields included, is a map. Errors are written with
// json.Deterministic (tools/router/router.go) and never picked.
const pickedFields: OrderRule = (_object, at) =>
  at.status >= 200 && at.status <= 299 && !!requestUrl(at.context)?.searchParams.get("fields");

// apis/health.go: `data` is a map[string]any.
const healthData: OrderRule = (_object, at) =>
  requestUrl(at.context)?.pathname === "/api/health" && at.path.join(".") === "data";

export const unorderedObjects: OrderRule[] = [pickedFields, healthData];

function requestUrl({ request }: Context): URL | undefined {
  try {
    return new URL(request.url, "http://example.com");
  } catch {
    return undefined;
  }
}

// Generated values paired so far in one scenario.
export class Pairing {
  // by format and value, the other side's value
  private readonly forward = new Map<string, string>();
  private readonly backward = new Map<string, string>();
  // by JSON string literal, the placeholder, per side
  readonly upstream = new Map<string, string>();
  readonly igloBase = new Map<string, string>();

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
    const placeholder = JSON.stringify(`<generated ${format.name} ${this.forward.size}>`);
    this.upstream.set(JSON.stringify(upstream), placeholder);
    this.igloBase.set(JSON.stringify(igloBase), placeholder);
    return true;
  }
}

// The differences between the two responses, one line each.
export function compareResponses(
  upstream: ScenarioResponse,
  igloBase: ScenarioResponse,
  context: Context,
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

  if (!isApiJson(upstream, context)) {
    if (!Buffer.from(upstream.body).equals(Buffer.from(igloBase.body))) {
      differences.push(
        `body: upstream ${show(text(upstream.body))}, iglo.base ${show(text(igloBase.body))}`,
      );
    }
    return differences;
  }

  const upText = utf8Text(upstream.body);
  const igText = utf8Text(igloBase.body);
  const upJson = upText === undefined ? undefined : tryParse(upText);
  const igJson = igText === undefined ? undefined : tryParse(igText);
  if (upJson && igJson) {
    const root: Location = { path: [], parents: [], context, status: upstream.status };
    pairGenerated(upJson, igJson, root, pairing, differences);
    const upNormal = normalizeBody(upJson, upText as string, root, pairing.upstream);
    const igNormal = normalizeBody(igJson, igText as string, root, pairing.igloBase);
    if (upNormal !== igNormal) {
      const before = differences.length;
      compareJson(parseJson(upNormal), parseJson(igNormal), [], differences);
      if (differences.length === before) {
        differences.push(formattingDifference(upNormal, igNormal));
      }
    }
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

// Finds the generated values in upstream's body and pairs each with
// iglo.base's value at the same place.
function pairGenerated(
  up: JsonNode,
  ig: JsonNode,
  at: Location,
  pairing: Pairing,
  differences: string[],
): void {
  if (up.kind === "string") {
    const format = rules.reduce<Format | undefined>(
      (found, rule) => found ?? rule(up, at),
      undefined,
    );
    if (!format || !isGenerated(format, up.value, at.context)) {
      return;
    }
    const differ = (detail: string) =>
      differences.push(`${where(at.path)}: ${detail}: upstream ${up.raw}, iglo.base ${ig.raw}`);
    if (ig.kind !== "string" || !format.pattern.test(ig.value)) {
      differ(`not both ${format.name}s`);
    } else if (!isGenerated(format, ig.value, at.context)) {
      differ(`generated ${format.name} expected, iglo.base's is in the starting data or request`);
    } else if (!pairing.pair(format, up.value, ig.value)) {
      differ(`${format.name}s not paired consistently`);
    }
  } else if (up.kind === "array" && ig.kind === "array") {
    up.items.forEach((item, i) => {
      const other = ig.items[i];
      if (other) {
        pairGenerated(item, other, { ...at, path: [...at.path, i] }, pairing, differences);
      }
    });
  } else if (up.kind === "object" && ig.kind === "object") {
    for (const [name, value] of up.entries) {
      const other = ig.entries.find(([n]) => n === name)?.[1];
      if (other) {
        pairGenerated(value, other, member(at, up, name), pairing, differences);
      }
    }
  }
}

function isGenerated(format: Format, value: string, context: Context): boolean {
  return format.pattern.test(value) && !context.start.contains(value) && !sent(value, context);
}

// whether upstream's response is API JSON that may carry generated values
function isApiJson(upstream: ScenarioResponse, context: Context): boolean {
  const type = upstream.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return false;
  }
  return !isFileDownload(context);
}

// GET/HEAD /api/files/{collection}/{record}/{filename} (apis/file.go); the
// file token endpoint, POST /api/files/token, answers API JSON
function isFileDownload(context: Context): boolean {
  const path = requestUrl(context)?.pathname ?? "";
  return /^\/api\/files\/[^/]+\/[^/]+\/[^/]+$/.test(path);
}

// whether the scenario's request carries the value: in the URL (raw or
// percent-decoded) or the raw body, or decoded from the body as upstream
// reads it (tools/router/unmarshal_request_data.go): a JSON string, a
// urlencoded form name or value, or a multipart part's text, including the
// strings of a JSON part such as @jsonPayload
function sent(value: string, { request }: Context): boolean {
  let url = request.url;
  try {
    url += `\n${decodeURIComponent(request.url)}`;
  } catch {
    // not percent-decodable: the raw URL is enough
  }
  const body =
    typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body);
  return url.includes(value) || body.includes(value) || bodyStrings(body, request).has(value);
}

function bodyStrings(body: string, request: Context["request"]): Set<string> {
  const found = jsonStrings(body);
  const type = requestHeader(request, "content-type") ?? "";
  if (/^application\/x-www-form-urlencoded\b/i.test(type)) {
    for (const [name, v] of new URLSearchParams(body)) {
      found.add(name);
      found.add(v);
    }
  }
  const boundary = /^multipart\/form-data\b.*?;\s*boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const split = part.indexOf("\r\n\r\n");
      if (split === -1) {
        continue;
      }
      const name = /\bname="([^"]*)"/.exec(part.slice(0, split))?.[1];
      const content = part.slice(split + 4).replace(/\r\n$/, "");
      if (name !== undefined) {
        found.add(name);
      }
      found.add(content);
      for (const s of jsonStrings(content)) {
        found.add(s);
      }
    }
  }
  return found;
}

function requestHeader(request: Context["request"], name: string): string | undefined {
  const entry = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

// the decoded string values (and member names) of a JSON text, if it is JSON
function jsonStrings(json: string): Set<string> {
  const found = new Set<string>();
  const node = json === "" ? undefined : tryParse(json);
  const walk = (n: JsonNode): void => {
    if (n.kind === "string") {
      found.add(n.value);
    } else if (n.kind === "array") {
      n.items.forEach(walk);
    } else if (n.kind === "object") {
      for (const [name, v] of n.entries) {
        found.add(name);
        walk(v);
      }
    }
  };
  if (node) {
    walk(node);
  }
  return found;
}

function member(at: Location, object: JsonNode & { kind: "object" }, name: string): Location {
  return { ...at, path: [...at.path, name], parents: [...at.parents, object] };
}

function end(node: JsonNode): number {
  return node.start + node.raw.length;
}

// The whole body text, normalized: the bytes before and after the root value
// stay as they are.
function normalizeBody(
  root: JsonNode,
  json: string,
  at: Location,
  replace: Map<string, string>,
): string {
  return json.slice(0, root.start) + normalize(root, json, at, replace) + json.slice(end(root));
}

// The body text with paired generated values replaced by their placeholder
// (`replace`, by JSON string literal) and the members of unordered objects
// sorted by name. Every other byte, whitespace included, stays.
function normalize(
  node: JsonNode,
  json: string,
  at: Location,
  replace: Map<string, string>,
): string {
  if (node.kind === "string") {
    return replace.get(node.raw) ?? node.raw;
  }
  if (node.kind === "array") {
    let out = "";
    let pos = node.start;
    node.items.forEach((item, i) => {
      out +=
        json.slice(pos, item.start) +
        normalize(item, json, { ...at, path: [...at.path, i] }, replace);
      pos = end(item);
    });
    return out + json.slice(pos, end(node));
  }
  if (node.kind !== "object" || node.entries.length === 0) {
    return node.raw;
  }
  // each member from just after the `{` or `,` before it to the end of its
  // value, and the separators between members
  const members: { name: string; text: string }[] = [];
  const separators: string[] = [];
  let pos = node.start + 1;
  for (const [name, value] of node.entries) {
    if (members.length > 0) {
      const next = json.indexOf(",", pos) + 1;
      separators.push(json.slice(pos, next));
      pos = next;
    }
    const inner = normalize(value, json, member(at, node, name), replace);
    members.push({ name, text: json.slice(pos, value.start) + inner });
    pos = end(value);
  }
  if (unorderedObjects.some((rule) => rule(node, at))) {
    members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const body = members.map((m, i) => (i === 0 ? "" : separators[i - 1]) + m.text).join("");
  return `{${body}${json.slice(pos, end(node))}`;
}

// Reports where two JSON values differ: kinds; literals and numbers by
// their exact text; strings by their decoded value; arrays item by item;
// objects by their member names, in order, then member by member.
export function compareJson(
  up: JsonNode,
  ig: JsonNode,
  path: (string | number)[],
  differences: string[],
): void {
  const differ = (detail: string) =>
    differences.push(`${where(path)}: ${detail}: upstream ${up.raw}, iglo.base ${ig.raw}`);
  if (up.kind !== ig.kind) {
    differ("different kinds");
  } else if (up.kind === "string" && ig.kind === "string") {
    if (up.value !== ig.value) {
      differ("different strings");
    }
  } else if (up.kind === "array" && ig.kind === "array") {
    if (up.items.length !== ig.items.length) {
      differ(`${up.items.length} items vs ${ig.items.length}`);
      return;
    }
    up.items.forEach((item, i) => {
      compareJson(item, ig.items[i] as JsonNode, [...path, i], differences);
    });
  } else if (up.kind === "object" && ig.kind === "object") {
    const upNames = up.entries.map(([name]) => name);
    const igNames = ig.entries.map(([name]) => name);
    if (upNames.join("\0") !== igNames.join("\0")) {
      differ(`members [${upNames.join(", ")}] vs [${igNames.join(", ")}]`);
      return;
    }
    up.entries.forEach(([name, value], i) => {
      compareJson(value, (ig.entries[i] as [string, JsonNode])[1], [...path, name], differences);
    });
  } else if (up.raw !== ig.raw) {
    differ("different values");
  }
}

// The same JSON value written differently (whitespace, string escaping):
// the first differing place in the normalized bodies.
function formattingDifference(up: string, ig: string): string {
  let i = 0;
  while (i < up.length && up[i] === ig[i]) {
    i++;
  }
  const from = Math.max(0, i - 20);
  return (
    `body: same JSON, different bytes at character ${i}: ` +
    `upstream ${show(up.slice(from, i + 20))}, iglo.base ${show(ig.slice(from, i + 20))}`
  );
}

function where(path: (string | number)[]): string {
  return path.length === 0 ? "body" : `body ${path.join(".")}`;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function utf8Text(body: Uint8Array): string | undefined {
  try {
    return utf8.decode(body);
  } catch {
    return undefined;
  }
}

function tryParse(json: string): JsonNode | undefined {
  try {
    return parseJson(json);
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

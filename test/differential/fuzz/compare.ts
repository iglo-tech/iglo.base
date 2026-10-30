// Sends a case to both servers and compares the answers: the status code; on
// success the page fields and the record ids; on an error the error body.
//
// The order is read from the sort text that was sent (classifySort):
//   - total: a key that identifies the record (id, @rowid) comes before any
//     multi-row key. The ids are compared in order.
//   - own-row: every key is on the record's own row or through single
//     relations, and records can tie. Two companion requests fetch the full
//     result with `,id` and `,-id` appended; both are compared in order. A
//     record's place differs between the two only inside a group of ties, so
//     each server's page must hold, at each position, a record of the group
//     at that position of its own full result.
//   - multi-row: a key passes a join that can multiply rows, and SQLite's
//     choice among the duplicates is not defined. A companion with the same
//     sort fetches the full result: the two sets are compared, and each page
//     must be a subset of its own server's set.
// A list that already holds every match needs a companion only for its order.
// A filter that reads the page size keeps it: its companions walk the pages.
// A case no companion can check is a difference of its own kind, never a pass.

import type { FuzzCase, Who } from "@test/differential/fuzz/generate";
import { printFilter } from "@test/differential/fuzz/filter-ast";
import type { CollectionModel, Model } from "@test/differential/fuzz/model";
import type { FuzzServers, TokenSet } from "@test/differential/fuzz/servers";

const requestTimeoutMs = 60_000;
// upstream's search.MaxPerPage and search.DefaultSortExprLimit
const maxPerPage = 1000;
const maxSortKeys = 8;
// a filter that reads the page size means something else on a full page
const pageSizeInFilter = /@request\.query\.perPage\b/;
// a filter that reads these means something else in any companion
const queryInFilter = /@request\.query\.(page|skipTotal|sort)\b/;

export interface Outcome {
  status: number;
  body: unknown;
}

export interface ListBody {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: { id: string }[];
}

export interface Difference {
  kind:
    | "transport"
    | "status"
    | "error-body"
    | "page-fields"
    | "ids"
    | "id-set"
    | "page-size"
    | "uncompared";
  detail: string;
}

export type SortClass = "total" | "own-row" | "multi-row";

export interface Comparison {
  // how the case was compared, for the report's case mix
  comparedAs: string;
  difference: Difference | null;
}

// one request to both servers; a failed request throws TransportError
export type Send = (path: string) => Promise<[Outcome, Outcome]>;

export class TransportError extends Error {}

export function sortText(c: FuzzCase): string | null {
  return c.rawSort ?? c.sort?.join(",") ?? null;
}

export function requestPath(c: FuzzCase): string {
  const params: { [name: string]: string } = { ...c.params };
  if (c.filter !== null) {
    params.filter = printFilter(c.filter);
  }
  const sort = sortText(c);
  if (sort !== null) {
    params.sort = sort;
  }
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `/api/collections/${c.collection}/records${query === "" ? "" : `?${query}`}`;
}

async function request(
  base: string,
  path: string,
  tokens: TokenSet,
  who: Who,
  headers: { [name: string]: string },
): Promise<Outcome | { error: string }> {
  try {
    const res = await fetch(base + path, {
      headers: { ...headers, ...(tokens[who] === "" ? {} : { authorization: tokens[who] }) },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, body: text };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// one sort key from upstream's ParseSortFromString and the path walk of
// core/record_field_resolver_runner.go; anything the walk does not know is
// taken as multi-row, the weakest claim about the order
function classifyKey(model: Model, base: CollectionModel, key: string): SortClass {
  if (key === "id" || key === "@rowid") {
    return "total";
  }
  if (key.startsWith("@")) {
    return "multi-row";
  }
  const props = key.split(".");
  let c = base;
  for (const [i, prop] of props.entries()) {
    const [name, modifier] = prop.split(":", 2);
    const field = c.fields.find((f) => f.name === name);
    if (field === undefined || modifier === "each") {
      // a back-relation, or a field no server accepts
      return "multi-row";
    }
    if (i === props.length - 1 || field.type === "json" || field.type === "geoPoint") {
      return "own-row";
    }
    const target = model.collections.get(field.target ?? "");
    if (target === undefined || field.multiple) {
      return "multi-row";
    }
    c = target;
  }
  return "multi-row";
}

function sortKeys(sort: string | null): string[] {
  return sort === null || sort === ""
    ? []
    : sort.split(",").map((key) => key.trim().replace(/^[-+]/, ""));
}

export function classifySort(model: Model, collection: string, sort: string | null): SortClass {
  const base = model.collections.get(collection) as CollectionModel;
  for (const key of sortKeys(sort)) {
    const keyClass = classifyKey(model, base, key);
    if (keyClass !== "own-row") {
      return keyClass;
    }
  }
  return "own-row";
}

function page(body: unknown): ListBody {
  return body as ListBody;
}

function ids(list: ListBody): string[] {
  return list.items.map((item) => item.id);
}

function holdsEveryMatch(list: ListBody): boolean {
  return (
    list.page === 1 &&
    (list.totalItems === -1
      ? list.items.length < list.perPage
      : list.items.length === list.totalItems)
  );
}

function fields(l: ListBody): number[] {
  return [l.page, l.perPage, l.totalItems, l.totalPages];
}

function sameIds(a: string[], b: string[]): boolean {
  return Bun.deepEquals(a, b);
}

function sameSet(a: string[], b: string[]): boolean {
  return Bun.deepEquals(a.toSorted(), b.toSorted());
}

function bothLists(kind: "ids" | "id-set", a: string[], b: string[], what: string): Difference {
  return { kind, detail: `${what}: upstream ${a.join(",")}; iglo.base ${b.join(",")}` };
}

// status and error body, the same for a case and its companions
function compareStatus(up: Outcome, ig: Outcome): Difference | null {
  if (up.status !== ig.status) {
    return {
      kind: "status",
      detail: `upstream ${up.status} ${JSON.stringify(up.body).slice(0, 300)}; iglo.base ${ig.status} ${JSON.stringify(ig.body).slice(0, 300)}`,
    };
  }
  if (up.status === 200 || Bun.deepEquals(up.body, ig.body)) {
    return null;
  }
  return {
    kind: "error-body",
    detail: `upstream ${JSON.stringify(up.body)}; iglo.base ${JSON.stringify(ig.body)}`,
  };
}

function compareFields(a: ListBody, b: ListBody): Difference | null {
  return Bun.deepEquals(fields(a), fields(b))
    ? null
    : {
        kind: "page-fields",
        detail: `upstream ${fields(a).join("/")}; iglo.base ${fields(b).join("/")}`,
      };
}

function withFullPage(c: FuzzCase, sort: string): FuzzCase {
  const { page: _page, skipTotal: _skipTotal, ...params } = c.params;
  return { ...c, sort: null, rawSort: sort, params: { ...params, perPage: String(maxPerPage) } };
}

interface FullLists {
  up: ListBody;
  ig: ListBody;
}

function filterText(c: FuzzCase): string {
  return c.filter === null ? "" : printFilter(c.filter);
}

function uncompared(detail: string): Difference {
  return { kind: "uncompared", detail };
}

// one page of a companion from both servers
async function fetchPage(path: string, send: Send): Promise<FullLists | Difference> {
  const [up, ig] = await send(path);
  const difference = compareStatus(up, ig);
  if (difference !== null) {
    return difference;
  }
  if (up.status !== 200) {
    return uncompared(`companion refused (${up.status}): ${path}`);
  }
  const lists = { up: page(up.body), ig: page(ig.body) };
  if (lists.up.totalItems > maxPerPage || lists.ig.totalItems > maxPerPage) {
    return uncompared(`over ${maxPerPage} matches: ${path}`);
  }
  return compareFields(lists.up, lists.ig) ?? lists;
}

function isFull(full: FullLists | Difference): full is FullLists {
  return "up" in full;
}

// the case's own page size, page by page, as one list
async function walkPages(c: FuzzCase, sort: string, send: Send): Promise<FullLists | Difference> {
  const { page: _page, skipTotal: _skipTotal, ...params } = c.params;
  const up: ListBody["items"] = [];
  const ig: ListBody["items"] = [];
  for (let n = 1; ; n++) {
    const walk = { ...c, sort: null, rawSort: sort, params: { ...params, page: String(n) } };
    const lists = await fetchPage(requestPath(walk), send);
    if (!isFull(lists)) {
      return lists;
    }
    up.push(...lists.up.items);
    ig.push(...lists.ig.items);
    if (n >= lists.up.totalPages) {
      const whole = (items: ListBody["items"]): ListBody => ({
        ...lists.up,
        page: 1,
        perPage: maxPerPage,
        totalPages: 1,
        items,
      });
      return { up: whole(up), ig: whole(ig) };
    }
  }
}

// the full result of the case's filter and token under `sort`, from both servers
function fetchFull(c: FuzzCase, sort: string, send: Send): Promise<FullLists | Difference> {
  return pageSizeInFilter.test(filterText(c))
    ? walkPages(c, sort, send)
    : fetchPage(requestPath(withFullPage(c, sort)), send);
}

// a page against the full result of the server that sent it
function checkOwnPage(side: string, list: ListBody, full: ListBody): Difference | null {
  if (list.totalItems !== -1 && list.totalItems !== full.totalItems) {
    return {
      kind: "page-fields",
      detail: `${side}: the page says ${list.totalItems} items, the full result has ${full.totalItems}`,
    };
  }
  const expected = Math.max(
    0,
    Math.min(list.perPage, full.totalItems - (list.page - 1) * list.perPage),
  );
  if (list.items.length !== expected) {
    return {
      kind: "page-size",
      detail: `${side}: ${list.items.length} items on page ${list.page}, expected ${expected} of ${full.totalItems}`,
    };
  }
  const all = new Set(ids(full));
  const stray = ids(list).filter((id) => !all.has(id));
  if (stray.length > 0 || new Set(ids(list)).size !== list.items.length) {
    return {
      kind: "id-set",
      detail: `${side}: page ${ids(list).join(",")} is not a subset of its full result ${ids(full).join(",")}`,
    };
  }
  return null;
}

// the group of ties at each position: a group ends where the first k ids are
// the same set under `,id` and under `,-id`
function tieGroups(asc: string[], desc: string[]): number[] {
  const groups: number[] = [];
  const open = new Set<string>();
  let group = 0;
  for (const [i, id] of asc.entries()) {
    const other = desc[i] as string;
    for (const value of [id, other]) {
      if (!open.delete(value)) {
        open.add(value);
      }
    }
    groups.push(group);
    if (open.size === 0) {
      group++;
    }
  }
  return groups;
}

// a page against the order of its own server's full result: the original sort
// leaves open only the order inside a group of ties
function checkOwnOrder(
  side: string,
  list: ListBody,
  asc: string[],
  desc: string[],
): Difference | null {
  const groups = tieGroups(asc, desc);
  const groupOf = new Map(asc.map((id, i) => [id, groups[i]]));
  const offset = (list.page - 1) * list.perPage;
  for (const [i, id] of ids(list).entries()) {
    if (groupOf.get(id) !== groups[offset + i]) {
      return {
        kind: "ids",
        detail: `${side}: ${id} at position ${offset + i} is out of order; full result ${asc.join(",")}`,
      };
    }
  }
  return null;
}

function checkPages(a: ListBody, b: ListBody, full: FullLists): Difference | null {
  return checkOwnPage("upstream", a, full.up) ?? checkOwnPage("iglo.base", b, full.ig);
}

async function compareOwnRow(
  c: FuzzCase,
  a: ListBody,
  b: ListBody,
  send: Send,
): Promise<Comparison> {
  const sort = sortText(c);
  const prefix = sort === null || sort === "" ? "" : `${sort},`;
  const asc = await fetchFull(c, `${prefix}id`, send);
  if (!isFull(asc)) {
    return { comparedAs: "set and id order", difference: asc };
  }
  const desc = await fetchFull(c, `${prefix}-id`, send);
  if (!isFull(desc)) {
    return { comparedAs: "set and id order", difference: desc };
  }
  const [upAsc, igAsc, upDesc, igDesc] = [ids(asc.up), ids(asc.ig), ids(desc.up), ids(desc.ig)];
  const difference = !sameIds(upAsc, igAsc)
    ? bothLists("ids", upAsc, igAsc, `full result by ${prefix}id`)
    : !sameIds(upDesc, igDesc)
      ? bothLists("ids", upDesc, igDesc, `full result by ${prefix}-id`)
      : (checkPages(a, b, asc) ??
        checkOwnOrder("upstream", a, upAsc, upDesc) ??
        checkOwnOrder("iglo.base", b, igAsc, igDesc));
  return { comparedAs: "set and id order", difference };
}

async function compareFullSets(
  c: FuzzCase,
  a: ListBody,
  b: ListBody,
  send: Send,
  as: string,
): Promise<Comparison> {
  // pages of an ambiguous sort can overlap, so a walk needs a total one
  const sort = pageSizeInFilter.test(filterText(c)) ? "id" : (sortText(c) ?? "");
  const full = await fetchFull(c, sort, send);
  if (!isFull(full)) {
    return { comparedAs: as, difference: full };
  }
  const difference = sameSet(ids(full.up), ids(full.ig))
    ? checkPages(a, b, full)
    : bothLists("id-set", ids(full.up), ids(full.ig), "full result");
  return { comparedAs: as, difference };
}

export async function compareOutcomes(
  model: Model,
  c: FuzzCase,
  up: Outcome,
  ig: Outcome,
  send: Send,
): Promise<Comparison> {
  const status = compareStatus(up, ig);
  if (status !== null || up.status !== 200) {
    return { comparedAs: "error body", difference: status };
  }
  const a = page(up.body);
  const b = page(ig.body);
  const sort = sortText(c);
  const order = classifySort(model, c.collection, sort);
  const fieldsDiffer = compareFields(a, b);
  if (fieldsDiffer !== null) {
    return { comparedAs: order === "total" ? "exact order" : "set only", difference: fieldsDiffer };
  }
  const [upIds, igIds] = [ids(a), ids(b)];
  if (order === "total") {
    return {
      comparedAs: "exact order",
      difference: sameIds(upIds, igIds) ? null : bothLists("ids", upIds, igIds, "page"),
    };
  }
  const everyMatch = holdsEveryMatch(a) || holdsEveryMatch(b);
  if (everyMatch && !sameSet(upIds, igIds)) {
    return { comparedAs: "set only", difference: bothLists("id-set", upIds, igIds, "page") };
  }
  if (everyMatch && (order === "multi-row" || upIds.length < 2)) {
    return { comparedAs: order === "multi-row" ? "set only" : "exact order", difference: null };
  }
  if (queryInFilter.test(filterText(c))) {
    return {
      comparedAs: "uncompared",
      difference: uncompared(`the filter reads a parameter companions change: ${requestPath(c)}`),
    };
  }
  if (order === "multi-row") {
    return compareFullSets(c, a, b, send, "set only");
  }
  return sortKeys(sort).length >= maxSortKeys
    ? compareFullSets(c, a, b, send, "set only: no room for an id sort key")
    : compareOwnRow(c, a, b, send);
}

export interface CaseResult {
  up: Outcome | null;
  ig: Outcome | null;
  comparedAs: string;
  difference: Difference | null;
}

export function sender(servers: FuzzServers, c: FuzzCase): Send {
  return async (path) => {
    const [up, ig] = await Promise.all([
      request(servers.upstream.url, path, servers.tokens.upstream, c.who, c.headers),
      request(servers.igloBase.url, path, servers.tokens.igloBase, c.who, c.headers),
    ]);
    if ("error" in up || "error" in ig) {
      throw new TransportError(
        `upstream ${"error" in up ? up.error : up.status}; iglo.base ${"error" in ig ? ig.error : ig.status}`,
      );
    }
    return [up, ig];
  };
}

export async function runCase(servers: FuzzServers, c: FuzzCase): Promise<CaseResult> {
  const send = sender(servers, c);
  let outcomes: [Outcome, Outcome] | null = null;
  try {
    outcomes = await send(requestPath(c));
    const [up, ig] = outcomes;
    return { up, ig, ...(await compareOutcomes(servers.model, c, up, ig, send)) };
  } catch (error) {
    if (!(error instanceof TransportError)) {
      throw error;
    }
    return {
      up: outcomes?.[0] ?? null,
      ig: outcomes?.[1] ?? null,
      comparedAs: "transport",
      difference: { kind: "transport", detail: error.message },
    };
  }
}

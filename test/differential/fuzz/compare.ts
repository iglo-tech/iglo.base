// Sends a case to both servers and compares the answers: the status code; on
// success the page fields and the record ids; on an error the error body.
//
// The ids are compared in order only when the order is total, that is the
// sort has an id or @rowid term and no term before it can have several values
// for one record (a DISTINCT list then picks one of the rows by the query
// plan). Otherwise records that tie may come back in any order: a list that
// holds every match is compared as a set, a partial page by its size.

import type { FuzzCase, Who } from "@test/differential/fuzz/generate";
import { printFilter } from "@test/differential/fuzz/filter-ast";
import type { FuzzServers, TokenSet } from "@test/differential/fuzz/servers";

const requestTimeoutMs = 60_000;

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
  kind: "transport" | "status" | "error-body" | "page-fields" | "ids" | "id-set" | "page-size";
  detail: string;
}

export function sortText(c: FuzzCase): string | null {
  return c.rawSort ?? (c.sort === null ? null : c.sort.map((t) => t.text).join(","));
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

export function orderIsTotal(c: FuzzCase): boolean {
  if (c.sort === null) {
    return false;
  }
  for (const term of c.sort) {
    if (term.multiRow) {
      return false;
    }
    if (term.unique) {
      return true;
    }
  }
  return false;
}

function page(body: unknown): ListBody {
  return body as ListBody;
}

export function holdsEveryMatch(list: ListBody): boolean {
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

export function compareOutcomes(c: FuzzCase, up: Outcome, ig: Outcome): Difference | null {
  if (up.status !== ig.status) {
    return {
      kind: "status",
      detail: `upstream ${up.status} ${JSON.stringify(up.body).slice(0, 300)}; iglo.base ${ig.status} ${JSON.stringify(ig.body).slice(0, 300)}`,
    };
  }
  if (up.status !== 200) {
    return Bun.deepEquals(up.body, ig.body)
      ? null
      : {
          kind: "error-body",
          detail: `upstream ${JSON.stringify(up.body)}; iglo.base ${JSON.stringify(ig.body)}`,
        };
  }
  const a = page(up.body);
  const b = page(ig.body);
  if (!Bun.deepEquals(fields(a), fields(b))) {
    return {
      kind: "page-fields",
      detail: `upstream ${fields(a).join("/")}; iglo.base ${fields(b).join("/")}`,
    };
  }
  const upIds = a.items.map((item) => item.id);
  const igIds = b.items.map((item) => item.id);
  const lists = `upstream ${upIds.join(",")}; iglo.base ${igIds.join(",")}`;
  if (orderIsTotal(c)) {
    return Bun.deepEquals(upIds, igIds) ? null : { kind: "ids", detail: lists };
  }
  if (holdsEveryMatch(a) || holdsEveryMatch(b)) {
    return Bun.deepEquals(upIds.toSorted(), igIds.toSorted())
      ? null
      : { kind: "id-set", detail: lists };
  }
  return upIds.length === igIds.length ? null : { kind: "page-size", detail: lists };
}

export interface CaseResult {
  up: Outcome | null;
  ig: Outcome | null;
  difference: Difference | null;
}

export async function runCase(servers: FuzzServers, c: FuzzCase): Promise<CaseResult> {
  const path = requestPath(c);
  const [up, ig] = await Promise.all([
    request(servers.upstream.url, path, servers.tokens.upstream, c.who, c.headers),
    request(servers.igloBase.url, path, servers.tokens.igloBase, c.who, c.headers),
  ]);
  if ("error" in up || "error" in ig) {
    return {
      up: "error" in up ? null : up,
      ig: "error" in ig ? null : ig,
      difference: {
        kind: "transport",
        detail: `upstream ${"error" in up ? up.error : up.status}; iglo.base ${"error" in ig ? ig.error : ig.status}`,
      },
    };
  }
  return { up, ig, difference: compareOutcomes(c, up, ig) };
}

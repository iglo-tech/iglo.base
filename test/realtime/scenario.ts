// The realtime scenario format. Upstream's realtime tests
// (apis/realtime_test.go) set up subscription clients in Go and check them
// in Go; here every step goes through HTTP: a scenario opens SSE streams
// (test/realtime/client.ts), subscribes, changes records through the
// records and collections APIs, and returns what it observed (statuses,
// bodies, the events of each stream). The shared single-request format of
// test/scenarios/scenario.ts cannot express these flows, so realtime has
// its own, run by the same two modes:
//
//   - `bun test` (test/realtime/scenarios.test.ts): iglo.base alone, on a
//     fresh copy of the vendored fixture, checked against upstream's
//     expectations (`check`);
//   - `bun run test:reference` (test/differential/realtime/): upstream
//     v0.41.0 and iglo.base, each on its own copy, both checked, and their
//     observations compared after normalizing client ids and timestamps.
//
// Hook-event expectations (ExpectedEvents, the enrich hook counts) are
// dropped: iglo.base has no hooks.

import { superuserToken } from "@test/scenarios/record-crud";
import { type HttpResult, jsonRequest, RealtimeStream, type SseEvent } from "@test/realtime/client";

export type Observation = { [key: string]: unknown };

export interface RealtimeScenario {
  // the Go test function (or "differential" for the extra cases)
  func: string;
  // the scenario or subtest name, verbatim from the Go file
  name: string;
  // event data compared as parsed JSON (the `fields` option: upstream's
  // picked maps have a random key order); byte for byte otherwise
  unorderedData?: boolean;
  // runs the scenario against one server
  run(ctx: ScenarioContext): Promise<Observation>;
  // upstream's expectations, checked on every server's observation; throws
  check?(o: Observation): void;
}

export class ScenarioContext {
  readonly #streams: RealtimeStream[] = [];

  constructor(readonly url: string) {}

  // opens a GET /api/realtime stream (closed after the scenario)
  async open(options: { localAddress?: string } = {}): Promise<RealtimeStream> {
    const stream = await RealtimeStream.open(this.url, options);
    this.#streams.push(stream);
    return stream;
  }

  // POST /api/realtime
  subscribe(
    clientId: string,
    subscriptions: string[] | undefined,
    token?: string,
    localAddress?: string,
  ): Promise<HttpResult> {
    const body: { [key: string]: unknown } = { clientId };
    if (subscriptions !== undefined) {
      body.subscriptions = subscriptions;
    }
    return jsonRequest(
      this.url,
      "POST",
      "/api/realtime",
      body,
      token ? { Authorization: token } : {},
      localAddress,
    );
  }

  // a raw POST /api/realtime body
  subscribeRaw(body: string, token?: string): Promise<HttpResult> {
    return jsonRequest(
      this.url,
      "POST",
      "/api/realtime",
      body,
      token ? { Authorization: token } : {},
    );
  }

  // a JSON API request (as the superuser unless token is set; "" for a guest)
  api(method: string, target: string, body?: unknown, token = superuserToken): Promise<HttpResult> {
    return jsonRequest(this.url, method, target, body, token ? { Authorization: token } : {});
  }

  // auth-with-password: the token of a record
  async authToken(collection: string, identity: string, password: string): Promise<string> {
    const res = await this.api(
      "POST",
      `/api/collections/${collection}/auth-with-password`,
      { identity, password },
      "",
    );
    if (res.status !== 200) {
      throw new Error(`auth-with-password ${collection} ${identity}: ${res.status} ${res.body}`);
    }
    return (JSON.parse(res.body) as { token: string }).token;
  }

  // a token of the record, from the superuser's impersonate endpoint
  async impersonate(collection: string, id: string): Promise<string> {
    const res = await this.api("POST", `/api/collections/${collection}/impersonate/${id}`, {});
    if (res.status !== 200) {
      throw new Error(`impersonate ${collection} ${id}: ${res.status} ${res.body}`);
    }
    return (JSON.parse(res.body) as { token: string }).token;
  }

  // a collection created through the API; returns its id, throws on failure
  async createCollection(collection: { [key: string]: unknown }): Promise<string> {
    const res = await this.api("POST", "/api/collections", collection);
    if (res.status !== 200) {
      throw new Error(`create collection: ${res.status} ${res.body}`);
    }
    return (JSON.parse(res.body) as { id: string }).id;
  }

  close(): void {
    for (const stream of this.#streams) {
      stream.close();
    }
  }
}

// a response as observed: status and body (JSON parsed when possible)
export function response(res: HttpResult): Observation {
  let body: unknown = res.body;
  try {
    body = res.body === "" ? "" : JSON.parse(res.body);
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

// the events of a stream after PB_CONNECT, as observed
export function events(list: SseEvent[]): Observation[] {
  return list.filter((e) => e.event !== "PB_CONNECT").map((e) => ({ ...e }));
}

// the events once the stream had none new for a while
export async function settled(stream: RealtimeStream): Promise<Observation[]> {
  return events(await stream.settle());
}

// the action and record id of each event, for the checks
export function actions(list: unknown): string[] {
  return (list as SseEvent[]).map((e) => {
    const data = JSON.parse(e.data) as { action: string; record: { id: string } };
    return `${e.event} ${data.action} ${data.record.id}`;
  });
}

// -------------------------------------------------------------------
// normalization for the differential comparison

const clientIdPattern = /\b[A-Za-z0-9]{40}\b/g;
const datePattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z/g;

// The observation as comparable text: client ids are numbered in order of
// appearance, timestamps replaced, and (unorderedData) event data parsed
// and its object keys sorted.
export function normalize(o: Observation, unorderedData: boolean): string {
  const ids = new Map<string, string>();
  const text = JSON.stringify(
    o,
    (key, value: unknown) => {
      if (unorderedData && key === "data" && typeof value === "string") {
        try {
          return sortKeys(JSON.parse(value));
        } catch {
          return value;
        }
      }
      return value;
    },
    2,
  );
  return text
    .replace(clientIdPattern, (id) => {
      let n = ids.get(id);
      if (n === undefined) {
        n = `<client${ids.size + 1}>`;
        ids.set(id, n);
      }
      return n;
    })
    .replace(datePattern, "<date>");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

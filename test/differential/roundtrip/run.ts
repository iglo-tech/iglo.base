// One round-trip run: three legs on one pb_data, each a server that starts on
// what the last one left, runs its part of the scenario and stops. A subject
// run is upstream, iglo.base, upstream; a control run is upstream three times.
//
// Around every switch of servers the same reads run twice, on the same data:
// at the end of a leg by the server that wrote it, and at the start of the next
// by the server that takes over. Both sides see one pb_data, so nothing is
// generated and the responses must be equal (`sweep`).
//
// Each server's requests are also recorded, so a test can compare a subject
// leg's writes with the control's.

import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpstream } from "@test/differential/db/fixture";
import {
  compareResponses,
  Pairing,
  readStartingData,
  type StartingData,
} from "@test/differential/harness/compare";
import {
  diffSnapshots,
  takeSnapshot,
  thumbPaths,
  type Snapshot,
} from "@test/differential/roundtrip/snapshot";
import type { ScenarioResponse } from "@test/scenarios/request";
import type { Scenario } from "@test/scenarios/scenario";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

export type Kind = "upstream" | "iglo.base";
export const subjectLegs: Kind[] = ["upstream", "iglo.base", "upstream"];
export const controlLegs: Kind[] = ["upstream", "upstream", "upstream"];

export const encryptionEnv = "ROUNDTRIP_ENCRYPTION_KEY";
export const encryptionKey = "roundtrip0encryption0key00000032";

// A parsed response. Scenario code reads what the request it just sent must
// have returned, and a missing member shows as a failed step.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

export interface Recorded {
  label: string;
  request: Scenario;
  response: ScenarioResponse;
}

export interface RequestOptions {
  // a JSON body, sent as JSON.stringify gives it
  json?: unknown;
  // a body sent as it is, with content-type application/json
  raw?: string;
  form?: FormData;
  // an Authorization value; the default is the run's superuser token
  token?: string;
  userAgent?: string;
  expect?: number;
}

// what stays the same across a run's legs
export class RunState {
  readonly failures: string[] = [];
  // tokens by name, issued by any leg
  readonly tokens = new Map<string, string>();
  // record ids the scenario left to the server
  readonly generatedIds = new Set<string>();
  // storage directories that must be gone before a server stops
  readonly gone: string[] = [];
  superuserToken: string;

  constructor(superuserToken: string) {
    this.superuserToken = superuserToken;
  }
}

// An API client bound to one leg's server. A wrong status is a failure of the
// run, which goes on: one difference should not hide the next.
export class Client {
  readonly recorded: Recorded[] = [];

  constructor(
    readonly url: string,
    readonly dataDir: string,
    readonly state: RunState,
    readonly leg: number,
  ) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Json> {
    const res = await this.send(method, path, options);
    const expect = options.expect ?? (method === "DELETE" ? 204 : 200);
    const text = new TextDecoder().decode(res.body);
    if (res.status !== expect) {
      this.state.failures.push(
        `leg ${this.leg + 1}: ${method} ${path}: status ${res.status}, expected ${expect}: ${text.slice(0, 500)}`,
      );
    }
    if (text === "") {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  get(path: string, options?: RequestOptions): Promise<Json> {
    return this.request("GET", path, options);
  }

  post(path: string, json: unknown, options: RequestOptions = {}): Promise<Json> {
    return this.request("POST", path, { ...options, json });
  }

  patch(path: string, json: unknown, options: RequestOptions = {}): Promise<Json> {
    return this.request("PATCH", path, { ...options, json });
  }

  delete(path: string, options?: RequestOptions): Promise<Json> {
    return this.request("DELETE", path, options);
  }

  // A record delete: its files go in the background, so the leg waits for
  // their directory before the server stops.
  async deleteRecord(collection: string, collectionId: string, id: string): Promise<void> {
    await this.delete(`/api/collections/${collection}/records/${id}`);
    this.state.gone.push(join("storage", collectionId, id));
  }

  // the storage directory of a record a cascade deletes
  deletedWith(collectionId: string, id: string): void {
    this.state.gone.push(join("storage", collectionId, id));
  }

  async send(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ScenarioResponse> {
    const token = options.token ?? this.state.superuserToken;
    const headers: Record<string, string> = {};
    if (token !== "") {
      headers["Authorization"] = token;
    }
    if (options.userAgent !== undefined) {
      headers["User-Agent"] = options.userAgent;
    }
    let body: string | Uint8Array | undefined;
    if (options.form !== undefined) {
      const encoded = new Response(options.form);
      headers["Content-Type"] = encoded.headers.get("content-type") as string;
      body = new Uint8Array(await encoded.arrayBuffer());
    } else if (options.raw !== undefined || options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = options.raw ?? JSON.stringify(options.json);
    }
    const res = await fetch(this.url + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const response: ScenarioResponse = {
      status: res.status,
      headers: res.headers,
      body: new Uint8Array(await res.arrayBuffer()),
    };
    const request: Scenario = {
      name: path,
      method,
      url: path,
      headers,
      ...(body === undefined ? {} : { body }),
      expectedStatus: 0,
    };
    this.recorded.push({ label: `${method} ${path}`, request, response });
    return response;
  }
}

export interface RoundTripScenario {
  // the writes of one leg (0, 1, 2)
  leg(client: Client, leg: number): Promise<void>;
  // more GET paths for the sweep, with the name of the token to send them
  // with ("" for a guest); an unset token skips the read
  reads?: (leg: number) => { path: string; token: string }[];
}

interface SweepEntry {
  key: string;
  request: Scenario;
  response: ScenarioResponse;
}

function requestFor(path: string): Scenario {
  return { name: path, method: "GET", url: path, expectedStatus: 0 };
}

const perPage = 500;

interface Listed {
  id: string;
  name: string;
  type: string;
  fields: { name: string; type: string }[];
}

function parse(res: ScenarioResponse): Json {
  return JSON.parse(new TextDecoder().decode(res.body));
}

const thumbable = /\.(png|jpe?g|gif)$/i;

// Reads everything through the API: settings, collections, every page of
// every collection with one level of expand, and every stored file, as it is
// and as a thumbnail.
async function sweep(
  client: Client,
  scenario: RoundTripScenario,
  leg: number,
): Promise<SweepEntry[]> {
  const out: SweepEntry[] = [];
  const read = async (key: string, path: string, token?: string): Promise<ScenarioResponse> => {
    const response = await client.send("GET", path, token === undefined ? {} : { token });
    out.push({ key, request: requestFor(path), response });
    return response;
  };

  await read("settings", "/api/settings");
  const collections = parse(await read("collections", "/api/collections?perPage=500&sort=name"));
  const fileToken = parse(await client.send("POST", "/api/files/token")).token as string;

  for (const collection of collections.items as Listed[]) {
    const sort = collection.type === "view" ? "id" : "@rowid";
    const relations = collection.fields.filter((f) => f.type === "relation").map((f) => f.name);
    const files = collection.fields.filter((f) => f.type === "file").map((f) => f.name);
    const expand = relations.length === 0 ? "" : `&expand=${relations.join(",")}`;
    for (let page = 1; ; page++) {
      const path = `/api/collections/${collection.name}/records?perPage=${perPage}&page=${page}&sort=${sort}${expand}`;
      const res = await read(path, path);
      if (res.status !== 200) {
        break;
      }
      const list = parse(res) as { items: Record<string, unknown>[] };
      for (const item of list.items) {
        for (const field of files) {
          const value = item[field];
          const names = Array.isArray(value) ? (value as string[]) : value ? [value as string] : [];
          for (const name of names) {
            const file = `/api/files/${collection.id}/${item["id"]}/${name}`;
            await read(file, `${file}?token=${fileToken}`);
            if (thumbable.test(name)) {
              await read(`${file} thumb`, `${file}?thumb=100x100&token=${fileToken}`);
            }
          }
        }
      }
      if (list.items.length < perPage) {
        break;
      }
    }
  }

  for (const { path, token } of scenario.reads?.(leg) ?? []) {
    const value = token === "" ? "" : client.state.tokens.get(token);
    if (value !== undefined) {
      await read(`${token} ${path}`, path, value);
    }
  }
  return out;
}

// the same pb_data: nothing is generated, all of it must be equal
const nothingGenerated: StartingData = { contains: () => true };

function compareSweeps(before: SweepEntry[], after: SweepEntry[], label: string): string[] {
  const out: string[] = [];
  const keys = (entries: SweepEntry[]) => entries.map((e) => e.key).join("\n");
  if (keys(before) !== keys(after)) {
    const a = new Set(before.map((e) => e.key));
    const b = new Set(after.map((e) => e.key));
    out.push(
      `${label}: reads differ: before only ${[...a].filter((k) => !b.has(k)).join(", ")}; after only ${[...b].filter((k) => !a.has(k)).join(", ")}`,
    );
    return out;
  }
  before.forEach((entry, i) => {
    const other = after[i] as SweepEntry;
    const pairing = new Pairing();
    const differences = compareResponses(
      entry.response,
      other.response,
      { start: nothingGenerated, request: entry.request },
      pairing,
    );
    out.push(...differences.map((d) => `${label}: ${entry.key}: ${d}`));
  });
  return out;
}

function dbRows(path: string, sql: string): Set<string> {
  const db = new Database(path);
  try {
    return new Set((db.query(sql).values() as unknown[][]).map((row) => row.join("\t")));
  } finally {
    db.close();
  }
}

const logRows =
  "SELECT quote(id), quote(level), quote(message), quote(data), quote(created) FROM _logs";

// the rows of `_logs` from a copy of pb_data, after a server stopped
function readLogs(dataDir: string): Set<string> {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-roundtrip-logs-"));
  try {
    const copy = join(root, "pb_data");
    mkdirCopy(dataDir, copy);
    return dbRows(join(copy, "auxiliary.db"), logRows);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function mkdirCopy(dataDir: string, copy: string): void {
  cpSync(dataDir, copy, {
    recursive: true,
    filter: (src) => !src.slice(dataDir.length + 1).startsWith("storage"),
  });
}

interface LegServer {
  url: string;
  stop(): Promise<void>;
}

async function startLeg(kind: Kind, dataDir: string, encrypted: boolean): Promise<LegServer> {
  const args = encrypted ? ["--encryptionEnv", encryptionEnv] : [];
  const env: Record<string, string> = encrypted ? { [encryptionEnv]: encryptionKey } : {};
  if (kind === "upstream") {
    // --automigrate writes pb_migrations files and `_migrations` rows on
    // every collection change, which iglo.base does not do yet (M3.7)
    const server = await startUpstream({
      dataDir,
      args: [...args, "--automigrate=false"],
      env,
    });
    return { url: server.url, stop: () => server.stop() };
  }
  const server = await startServer(args, dataDir, undefined, undefined, env);
  return {
    url: server.url,
    async stop() {
      const result = await server.stop();
      if (result.exitCode !== 0) {
        throw new Error(`iglo.base exited with ${result.exitCode}:\n${result.stderr}`);
      }
    },
  };
}

// the leg's background file deletes must end before its server stops
async function waitForDeletes(dataDir: string, state: RunState): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (const path of state.gone.splice(0)) {
    while (existsSync(join(dataDir, path))) {
      if (Date.now() > deadline) {
        state.failures.push(`${path} is still in pb_data`);
        break;
      }
      await Bun.sleep(5);
    }
  }
}

export interface RunOptions {
  legs: Kind[];
  // copied to the run's own pb_data; only read
  startDir: string;
  scenario: RoundTripScenario;
  superuserToken: string;
  // --encryptionEnv per leg
  encrypted?: boolean[];
}

export interface RunResult {
  root: string;
  dataDir: string;
  // when the run started, as a stored timestamp
  startedAt: string;
  state: RunState;
  // what each leg sent and got
  recorded: Recorded[][];
  // thumbnails iglo.base generated, as stored paths
  igloThumbs: Set<string>;
  // the last leg's --encryptionEnv key
  encryptionKey?: string;
  remove(): void;
}

function storedTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ");
}

export async function runLegs(options: RunOptions): Promise<RunResult> {
  const { legs, scenario } = options;
  const root = mkdtempSync(join(tmpdir(), "iglo-base-roundtrip-"));
  const dataDir = join(root, "pb_data");
  cpSync(options.startDir, dataDir, { recursive: true });

  const state = new RunState(options.superuserToken);
  const recorded: Recorded[][] = [];
  const igloThumbs = new Set<string>();
  const startedAt = storedTimestamp(new Date());
  let lastSweep: SweepEntry[] | undefined;
  let lastLogs: Set<string> | undefined;

  for (const [leg, kind] of legs.entries()) {
    const thumbsBefore = thumbPaths(dataDir);
    const server = await startLeg(kind, dataDir, options.encrypted?.[leg] ?? false);
    const client = new Client(server.url, dataDir, state, leg);
    try {
      if (lastSweep !== undefined) {
        const taken = await sweep(client, scenario, leg - 1);
        state.failures.push(
          ...compareSweeps(lastSweep, taken, `${legs[leg - 1]} -> ${kind} (leg ${leg + 1})`),
        );
      }
      client.recorded.length = 0;
      await scenario.leg(client, leg);
      recorded.push([...client.recorded]);
      lastSweep = await sweep(client, scenario, leg);
      await waitForDeletes(dataDir, state);
    } finally {
      await server.stop();
    }
    if (kind === "iglo.base") {
      for (const path of thumbPaths(dataDir)) {
        if (!thumbsBefore.has(path)) {
          igloThumbs.add(path);
        }
      }
    }

    // `_logs`: only that auxiliary.db written by upstream stays intact (M5.5)
    const logs = readLogs(dataDir);
    if (lastLogs !== undefined) {
      const lost = [...lastLogs].filter((row) => !logs.has(row));
      if (lost.length > 0) {
        state.failures.push(`leg ${leg + 1}: ${lost.length} rows of _logs changed: ${lost[0]}`);
      }
    }
    lastLogs = logs;
  }

  return {
    root,
    dataDir,
    startedAt,
    state,
    recorded,
    igloThumbs,
    ...(options.encrypted?.at(-1) ? { encryptionKey } : {}),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

const anyTimestamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z/g;

// A write's time differs between two runs, and within one response equal
// times on one side need not be equal on the other (upstream reads the clock
// per field). Times from before the run stay. The ids the scenario left to the
// server are replaced by their place in the run.
function comparable(res: ScenarioResponse, run: RunResult): ScenarioResponse {
  let body = new TextDecoder().decode(res.body);
  body = body.replace(anyTimestamp, (ts) =>
    ts >= run.startedAt && ts < "2100" ? "2000-01-01 00:00:00.000Z" : ts,
  );
  [...run.state.generatedIds].forEach((id, i) => {
    body = body.replaceAll(id, `generated${String(i).padStart(6, "0")}`);
  });
  return { ...res, body: new TextEncoder().encode(body) };
}

// Compares what a subject leg's server answered with the control's, request by
// request, with the harness's rules for generated values. A thumbnail is left
// to the snapshot: its encoded bytes may differ. The stored data decides
// whether generated values stayed consistent, so each response pairs alone.
export function compareRecorded(
  control: RunResult,
  subject: RunResult,
  start: StartingData,
): string[] {
  const out: string[] = [];
  for (const [leg, requests] of control.recorded.entries()) {
    const other = subject.recorded[leg] ?? [];
    if (requests.length !== other.length) {
      out.push(`leg ${leg + 1}: ${requests.length} requests != ${other.length}`);
      continue;
    }
    requests.forEach((entry, i) => {
      const peer = other[i] as Recorded;
      if (entry.request.url.startsWith("/api/files/") && entry.request.url.includes("thumb=")) {
        if (entry.response.status !== peer.response.status) {
          out.push(
            `leg ${leg + 1}: ${entry.label}: ${entry.response.status} != ${peer.response.status}`,
          );
        }
        return;
      }
      out.push(
        ...compareResponses(
          comparable(entry.response, control),
          comparable(peer.response, subject),
          { start, request: entry.request },
          new Pairing(),
        ).map((d) => `leg ${leg + 1}: ${entry.label}: ${d}`),
      );
    });
  }
  return out;
}

// the pb_data the legs copy, and the superuser token that opens it ("" for a
// fresh install: the scenario signs in, see signedIn)
export interface Start {
  dataDir: string;
  token: string;
}

export function snapshotOf(run: RunResult, start: StartingData): Snapshot {
  return takeSnapshot(run.dataDir, {
    start,
    startedAt: run.startedAt,
    generatedIds: run.state.generatedIds,
    igloThumbs: run.igloThumbs,
    ...(run.encryptionKey === undefined ? {} : { encryptionKey: run.encryptionKey }),
  });
}

export interface Outcome {
  control: RunResult;
  subject: RunResult;
  controlSnapshot: Snapshot;
  subjectSnapshot: Snapshot;
  start: StartingData;
  differences: string[];
}

// The control, then the subject, on copies of one start. A control that fails
// is a wrong scenario: no comparison would mean anything.
export async function roundTrip(
  start: Start,
  scenario: RoundTripScenario,
  options: Pick<RunOptions, "encrypted"> = {},
): Promise<Outcome> {
  const common = {
    startDir: start.dataDir,
    scenario,
    superuserToken: start.token,
    ...options,
  };
  const startingData = readStartingData(start.dataDir);
  const control = await runLegs({ ...common, legs: controlLegs });
  if (control.state.failures.length > 0) {
    control.remove();
    throw new Error(`the control run failed:\n${control.state.failures.join("\n")}`);
  }
  const subject = await runLegs({ ...common, legs: subjectLegs });
  const controlSnapshot = snapshotOf(control, startingData);
  const subjectSnapshot = snapshotOf(subject, startingData);
  return {
    control,
    subject,
    controlSnapshot,
    subjectSnapshot,
    start: startingData,
    differences: [
      ...subject.state.failures,
      ...compareRecorded(control, subject, startingData),
      ...diffSnapshots(controlSnapshot, subjectSnapshot),
    ],
  };
}

export const freshSuperuser = { email: "fresh@example.com", password: "1234567890" };

// a fresh install by upstream, with one superuser, under root
export async function freshStart(root: string): Promise<Start> {
  const dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", freshSuperuser.email, freshSuperuser.password, "--dir", dataDir],
    root,
  );
  if (upsert.exitCode !== 0) {
    throw new Error(upsert.output);
  }
  return { dataDir, token: "" };
}

// the first request of a run on a fresh install signs in
export function signedIn(scenario: RoundTripScenario): RoundTripScenario {
  return {
    ...scenario,
    async leg(client, leg) {
      if (client.state.superuserToken === "") {
        const res = await client.post(
          "/api/collections/_superusers/auth-with-password",
          { identity: freshSuperuser.email, password: freshSuperuser.password },
          { token: "", userAgent: "roundtrip" },
        );
        client.state.superuserToken = res.token as string;
      }
      await scenario.leg(client, leg);
    },
  };
}

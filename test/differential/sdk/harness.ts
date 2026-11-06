// The JavaScript SDK suite's harness (docs/briefs/M5.8.md). A test is one
// async function that drives the official `pocketbase` SDK against a
// server; it runs once on upstream PocketBase v0.41.0 and once on
// iglo.base, each on its own copy of the shared fixture. Every `step` of the
// function records
//
// - the value the SDK method returned, or the ClientResponseError it threw
//   (status, response, abort flag), as JSON;
// - every HTTP exchange the call made (status, compared headers, body bytes).
//
// The two recordings are compared step by step with the differential
// harness's normalization (test/differential/harness/compare.ts): generated
// ids, tokens, timestamps and file-name suffixes are replaced by their format
// on both sides; everything else must be equal. Files and mails the call
// produced are recorded as steps too (`record`).

import { rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";
import PocketBase, { ClientResponseError } from "pocketbase";

import { compareResponses, Pairing, readStartingData } from "@test/differential/harness/compare";
import { installEventSource } from "@test/support/event-source";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import type { ScenarioResponse } from "@test/scenarios/request";
import { changeSettings } from "@test/scenarios/settings-prepare";
import { startServer, tempDir } from "@test/support/executable";
import { startSmtpSink, type SinkMessage, type SmtpSink } from "@test/support/smtp-sink";
import { startUpstream } from "@test/support/upstream";
import { startVersitygw, testS3Credentials, type Versitygw } from "@test/support/versitygw";

installEventSource();

export { PocketBase, ClientResponseError };

export const password = "1234567890";
// fixed tokens of the fixture (test/scenarios/record-crud.ts)
import { superuserToken as superuserTokenValue } from "@test/scenarios/record-crud";

export { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";

interface Exchange {
  method: string;
  url: string;
  requestBody: string;
  requestHeaders: Record<string, string>;
  response: ScenarioResponse;
}

interface Step {
  label: string;
  // JSON text of the value (or of the error)
  value: string;
  exchanges: Exchange[];
}

export type SdkClient = PocketBase;

export interface PrepareEnv {
  dataDir: string;
  // this server's own SMTP sink
  sink: SmtpSink;
}

export interface SdkOptions {
  // before the server starts, on its own fixture copy
  prepare?: (env: PrepareEnv) => void | Promise<void>;
  // SMTP enabled and pointed at the server's sink
  smtp?: boolean;
  // each server gets its own S3 test server (env.s3)
  s3?: boolean;
  // `serve` arguments of both servers
  args?: string[];
  timeout?: number;
}

export interface SdkEnv {
  name: "upstream" | "iglo.base";
  url: string;
  dataDir: string;
  sink: SmtpSink;
  // the S3 test server's settings (with the `s3` option); the gateway's
  // address is masked in recordings
  s3: { endpoint: string; bucket: string; region: string; accessKey: string; secret: string };
  // a new SDK client whose requests are recorded
  client(): PocketBase;
  // a new client authenticated with a fixed fixture token (no request)
  as(token: string, record?: { id: string; collectionName: string }): PocketBase;
  superuser(): PocketBase;
  // runs fn, records its value (or the thrown error) and the exchanges it
  // made, and returns the value; an error is recorded and rethrown unless
  // `rejects` is true, then returned
  step<T>(label: string, fn: () => Promise<T>): Promise<T>;
  // like step, for a call that must fail: returns the ClientResponseError
  fails(label: string, fn: () => Promise<unknown>): Promise<ClientResponseError>;
  // runs fn without recording its requests, and records the value it
  // returns: for calls whose responses differ in ways the suite cannot
  // normalize (a backup's size and modification time)
  derived<T>(label: string, fn: () => Promise<T>, value: (result: T) => unknown): Promise<T>;
  // like fails, for an error whose text carries run-specific data (an S3
  // gateway's signature error): records the status and `data` only
  failsStatus(
    label: string,
    fn: () => Promise<unknown>,
    pick?: (error: ClientResponseError) => unknown,
  ): Promise<ClientResponseError>;
  // records a value that is not an SDK call's result
  record(label: string, value: unknown): void;
  // raw requests recorded as an exchange (a file download, a mock call)
  fetch(label: string, path: string, init?: RequestInit): Promise<Response>;
  // waits for mail to the address and records its (normalized) text
  mail(label: string, to: string, since?: number): Promise<SinkMessage>;
  // waits until check is true, polling
  until(check: () => boolean | Promise<boolean>, what: string, ms?: number): Promise<void>;
}

const sdkUserAgent = "iglo-base-sdk-suite";

function replacer(_key: string, v: unknown): unknown {
  if (v instanceof ClientResponseError) {
    return {
      clientResponseError: true,
      status: v.status,
      response: v.response,
      isAbort: v.isAbort,
    };
  }
  if (v instanceof Blob) {
    return { blob: true, size: v.size, type: v.type };
  }
  if (v instanceof PocketBase) {
    return {
      client: true,
      baseURL: v.baseURL,
      token: v.authStore.token,
      record: v.authStore.record,
    };
  }
  if (v === undefined) {
    return { undefined: true };
  }
  return v;
}

function toText(value: unknown, env: { url: string; dataDir: string; s3: SdkEnv["s3"] }): string {
  return (JSON.stringify(value, replacer) ?? "null")
    .replaceAll(env.url, "<base>")
    .replaceAll(env.s3.endpoint, "<s3>")
    .replaceAll(env.dataDir, "<pb_data>");
}

function pseudoResponse(text: string): ScenarioResponse {
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(text),
  };
}

// a mail as comparable data: the headers that carry no random part and the
// text part, tokens and one-time passwords replaced
function describeMail(m: SinkMessage): unknown {
  const decoded = decodeMessage(m);
  const header = (name: string): string =>
    new RegExp(`^${name}: (.*)$`, "im").exec(decoded)?.[1]?.trim() ?? "";
  const plain = /Content-Type: text\/plain[^\n]*\n\n([\s\S]*?)\n--/.exec(decoded)?.[1] ?? "";
  return {
    to: m.to,
    from: header("From"),
    subject: header("Subject"),
    text: plain
      .replaceAll(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<token>")
      .replaceAll(/\b\d{8}\b/g, "<otp>"),
  };
}

function decodeMessage(m: SinkMessage): string {
  // quoted-printable decoded text of the whole message
  return m.data
    .replaceAll("\r\n", "\n")
    .replaceAll(/=\n/g, "")
    .replaceAll(/=([0-9A-F]{2})/g, (_s, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function messageBody(m: SinkMessage): string {
  return decodeMessage(m);
}

// the first match of a pattern in the decoded message, or fails
export function mailMatch(m: SinkMessage, pattern: RegExp): string {
  const text = messageBody(m);
  const found = pattern.exec(text);
  if (found?.[1] === undefined) {
    throw new Error(`no ${pattern} in the mail:\n${text}`);
  }
  return found[1];
}

class Recording implements SdkEnv {
  readonly steps: Step[] = [];
  #current: Exchange[] = [];
  readonly clients: PocketBase[] = [];
  readonly cleanup: (() => Promise<unknown>)[] = [];

  constructor(
    readonly name: SdkEnv["name"],
    readonly url: string,
    readonly dataDir: string,
    readonly sink: SmtpSink,
    readonly s3: SdkEnv["s3"],
  ) {}

  #recordingFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const res = await fetch(input, init);
    // the body is read here; the SDK gets an equal copy
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "";
    const masked = /json|text/.test(type)
      ? new TextEncoder().encode(
          new TextDecoder()
            .decode(bytes)
            .replaceAll(this.s3.endpoint, "<s3>")
            .replaceAll(this.url, "<base>")
            .replaceAll(this.dataDir, "<pb_data>"),
        )
      : bytes;
    const exchange: Exchange = {
      method,
      url: url.replace(this.url, ""),
      requestBody: bodyText(init?.body),
      requestHeaders: headersOf(init?.headers),
      response: { status: res.status, headers: res.headers, body: masked },
    };
    this.#current.push(exchange);
    return new Response(bytes, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  client(): PocketBase {
    const pb = new PocketBase(this.url);
    pb.beforeSend = (url, options) => ({
      url,
      options: { ...options, fetch: this.#recordingFetch },
    });
    this.clients.push(pb);
    return pb;
  }

  as(token: string, record = { id: "x", collectionName: "_superusers" }): PocketBase {
    const pb = this.client();
    pb.authStore.save(token, record as never);
    return pb;
  }

  superuser(): PocketBase {
    return this.as(superuserTokenValue, { id: "sywbhecnh46rhm0", collectionName: "_superusers" });
  }

  async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#current.length;
    let value: unknown;
    let error: unknown;
    try {
      value = await fn();
    } catch (e) {
      error = e;
    }
    this.steps.push({
      label,
      value: toText(error ?? value, this),
      exchanges: this.#current.splice(before),
    });
    if (error !== undefined) {
      throw new Error(`step "${label}" failed: ${toText(error, this)}`);
    }
    return value as T;
  }

  async fails(label: string, fn: () => Promise<unknown>): Promise<ClientResponseError> {
    const before = this.#current.length;
    let error: unknown;
    try {
      await fn();
    } catch (e) {
      error = e;
    }
    this.steps.push({
      label,
      value: toText(error ?? { noError: true }, this),
      exchanges: this.#current.splice(before),
    });
    if (!(error instanceof ClientResponseError)) {
      throw new Error(`${label}: expected a ClientResponseError, got ${String(error)}`);
    }
    return error;
  }

  async derived<T>(label: string, fn: () => Promise<T>, value: (result: T) => unknown): Promise<T> {
    const before = this.#current.length;
    const result = await fn();
    this.#current.splice(before);
    this.record(label, value(result));
    return result;
  }

  async failsStatus(
    label: string,
    fn: () => Promise<unknown>,
    pick?: (error: ClientResponseError) => unknown,
  ): Promise<ClientResponseError> {
    const before = this.#current.length;
    let error: unknown;
    try {
      await fn();
    } catch (e) {
      error = e;
    }
    this.#current.splice(before);
    if (!(error instanceof ClientResponseError)) {
      throw new Error(`${label}: expected a ClientResponseError, got ${String(error)}`);
    }
    this.record(label, pick?.(error) ?? { status: error.status, data: error.response["data"] });
    return error;
  }

  record(label: string, value: unknown): void {
    this.steps.push({ label, value: toText(value, this), exchanges: [] });
  }

  async fetch(label: string, path: string, init: RequestInit = {}): Promise<Response> {
    const before = this.#current.length;
    const res = await this.#recordingFetch(`${this.url}${path}`, {
      ...init,
      headers: { "User-Agent": sdkUserAgent, ...(init.headers as object) },
    });
    this.steps.push({
      label,
      value: toText({ status: res.status }, this),
      exchanges: this.#current.splice(before),
    });
    return res;
  }

  async mail(label: string, to: string, since = 0): Promise<SinkMessage> {
    let found: SinkMessage | undefined;
    await this.until(() => {
      found = this.sink.messages.findLast((m) => m.to.includes(to) && m.received >= since);
      return found !== undefined;
    }, `mail to ${to}`);
    this.record(label, describeMail(found as SinkMessage));
    return found as SinkMessage;
  }

  async until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) {
        throw new Error(`${this.name}: timed out waiting for ${what}`);
      }
      await Bun.sleep(25);
    }
  }
}

function bodyText(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof FormData) {
    // the SDK's JSON part (a batch's requests, the non-file values): the
    // comparison reads it as the request body
    const json = body.get("@jsonPayload");
    if (typeof json === "string") {
      return json;
    }
    return [...body.entries()]
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : `<file ${(v as File).name}>`}`)
      .join("&");
  }
  return "";
}

function headersOf(
  headers: ConstructorParameters<typeof Headers>[0] | undefined,
): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

// the differences of two recordings, one line each
export function compareRecordings(
  upstream: Recording,
  igloBase: Recording,
  start: ReturnType<typeof readStartingData>,
): string[] {
  const out: string[] = [];
  const pairing = new Pairing({ history: true });
  const count = Math.max(upstream.steps.length, igloBase.steps.length);
  for (let i = 0; i < count; i++) {
    const up = upstream.steps[i];
    const ig = igloBase.steps[i];
    if (up === undefined || ig === undefined) {
      out.push(`step ${i + 1}: only ${up ? "upstream" : "iglo.base"} has "${(up ?? ig)?.label}"`);
      continue;
    }
    const where = `step ${i + 1} "${up.label}"`;
    if (up.label !== ig.label) {
      out.push(`${where}: iglo.base's step is "${ig.label}"`);
      continue;
    }
    const exchanges = Math.min(up.exchanges.length, ig.exchanges.length);
    if (up.exchanges.length !== ig.exchanges.length) {
      out.push(`${where}: ${up.exchanges.length} requests vs ${ig.exchanges.length}`);
    }
    const context = (e: Exchange) => ({
      start,
      request: { url: e.url, body: e.requestBody, headers: e.requestHeaders },
    });
    for (let j = 0; j < exchanges; j++) {
      const a = up.exchanges[j] as Exchange;
      const b = ig.exchanges[j] as Exchange;
      if (a.method !== b.method) {
        out.push(`${where} request ${j + 1}: method ${a.method} vs ${b.method}`);
      }
      for (const d of compareResponses(a.response, b.response, context(a), pairing)) {
        out.push(`${where} ${a.method} ${a.url.split("?")[0]}: ${d}`);
      }
    }
    // the value, with the requests of the step as what the scenario sent
    const sent = {
      start,
      request: {
        url: up.exchanges.map((e) => e.url).join("\n"),
        body: up.exchanges.map((e) => e.requestBody).join("\n"),
        headers: {},
      },
    };
    for (const d of compareResponses(
      pseudoResponse(up.value),
      pseudoResponse(ig.value),
      sent,
      pairing,
    )) {
      out.push(`${where} value: ${d}`);
    }
  }
  return out;
}

type Run = (env: SdkEnv) => Promise<void>;

// One test that runs fn against both servers.
export function sdkTest(name: string, options: SdkOptions, fn: Run): void {
  test(
    name,
    async () => {
      const root = tempDir();
      const dirs = { upstream: join(root, "up", "pb_data"), iglo: join(root, "ig", "pb_data") };
      const sinks = { upstream: startSmtpSink(), iglo: startSmtpSink() };
      for (const kind of ["upstream", "iglo"] as const) {
        copyDataDir(fixtureDir, dirs[kind]);
        if (options.smtp) {
          changeSettings(dirs[kind], (s) => {
            s.smtp = {
              ...s.smtp,
              enabled: true,
              host: "127.0.0.1",
              port: sinks[kind].port,
              username: "",
              password: "",
              tls: false,
            };
          });
        }
        await options.prepare?.({ dataDir: dirs[kind], sink: sinks[kind] });
      }
      const start = readStartingData(dirs.upstream);
      const gateways: Versitygw[] = [];
      const noS3 = {
        endpoint: "http://s3.invalid",
        bucket: "",
        region: "",
        accessKey: "",
        secret: "",
      };
      const s3Of = async (): Promise<SdkEnv["s3"]> => {
        if (!options.s3) {
          return noS3;
        }
        const gw = await startVersitygw();
        gateways.push(gw);
        return {
          endpoint: gw.endpoint,
          bucket: gw.bucket,
          region: testS3Credentials.region,
          accessKey: testS3Credentials.accessKeyId,
          secret: testS3Credentials.secretAccessKey,
        };
      };
      const s3s = { upstream: await s3Of(), iglo: await s3Of() };
      const started = await Promise.allSettled([
        startUpstream({ dataDir: dirs.upstream, args: options.args ?? [] }),
        startServer(options.args ?? [], dirs.iglo),
      ]);
      try {
        for (const s of started) {
          if (s.status === "rejected") {
            throw s.reason;
          }
        }
        const [up, ig] = started.map((s) => (s as PromiseFulfilledResult<{ url: string }>).value);
        const upstream = new Recording(
          "upstream",
          (up as { url: string }).url,
          dirs.upstream,
          sinks.upstream,
          s3s.upstream,
        );
        const igloBase = new Recording(
          "iglo.base",
          (ig as { url: string }).url,
          dirs.iglo,
          sinks.iglo,
          s3s.iglo,
        );
        const results = await Promise.allSettled([fn(upstream), fn(igloBase)]);
        for (const rec of [upstream, igloBase]) {
          for (const pb of rec.clients) {
            pb.cancelAllRequests();
            await pb.realtime.unsubscribe().catch(() => undefined);
          }
        }
        const differences = compareRecordings(upstream, igloBase, start);
        const failures = results.flatMap((r, i) =>
          r.status === "rejected"
            ? [
                `${i === 0 ? "upstream" : "iglo.base"} threw: ${String((r.reason as Error)?.stack ?? r.reason)}`,
              ]
            : [],
        );
        expect([...differences, ...failures]).toEqual([]);
      } finally {
        await Promise.allSettled(
          started.map((s) => (s.status === "fulfilled" ? s.value.stop() : undefined)),
        );
        await Promise.allSettled(gateways.map((g) => g.stop()));
        rmSync(root, { recursive: true, force: true });
      }
    },
    options.timeout ?? 60_000,
  );
}

// The value with its object members sorted by name: upstream writes the
// members of a `fields`-picked message in random order.
export function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortedKeys(v)]),
    );
  }
  return value;
}

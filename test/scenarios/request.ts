// Upstream: tests/api.go (how ApiScenario.test builds the request)
//
// Sends a scenario's request over a plain TCP socket and reads the raw
// response. Like httptest.NewRequest, the request carries only the scenario's
// headers, `Host: example.com` and the default `content-type:
// application/json`, plus Content-Length when there is a body; fetch()
// would add its own headers and normalize the target.

import { connect } from "node:net";

import type { Scenario } from "@test/scenarios/scenario";

export interface ScenarioResponse {
  status: number;
  headers: Headers;
  // the body bytes, after chunked decoding
  body: Uint8Array;
}

// without a scenario timeout, a response must be complete after this long
const responseLimitMs = 10_000;

export function sendScenarioRequest(
  baseUrl: string,
  scenario: Scenario,
): Promise<ScenarioResponse> {
  const { hostname, port } = new URL(baseUrl);
  const body =
    typeof scenario.body === "string"
      ? Buffer.from(scenario.body)
      : Buffer.from(scenario.body ?? new Uint8Array());

  const headers = new Map<string, [string, string]>();
  const set = (name: string, value: string) => headers.set(name.toLowerCase(), [name, value]);
  set("Host", "example.com");
  set("content-type", "application/json");
  for (const [name, value] of Object.entries(scenario.headers ?? {})) {
    // trim whitespaces for consistency with the net/http request parsing
    set(name, value.trim());
  }
  if (scenario.body !== undefined) {
    set("Content-Length", String(body.length));
  }
  const head = [`${scenario.method} ${scenario.url} HTTP/1.1`];
  for (const [name, value] of headers.values()) {
    head.push(`${name}: ${value}`);
  }

  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) });
    let received = Buffer.alloc(0);
    let done = false;
    // the response ends at its framing, at the end of the connection, or
    // at the scenario's timeout
    const finish = (end: "framing" | "close" | "timeout") => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const parsed = parseResponse(received, scenario.method);
      if (
        parsed &&
        (parsed.complete ||
          (end === "timeout" && scenario.timeoutMs !== undefined) ||
          (end === "close" && parsed.byClose))
      ) {
        resolve(parsed.response);
      } else {
        reject(new Error(`${scenario.method} ${scenario.url}: incomplete response:\n${received}`));
      }
    };
    const timer = setTimeout(() => finish("timeout"), scenario.timeoutMs ?? responseLimitMs);

    socket.on("connect", () => {
      socket.write(`${head.join("\r\n")}\r\n\r\n`);
      socket.write(body);
    });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (parseResponse(received, scenario.method)?.complete) {
        finish("framing");
      }
    });
    socket.on("error", (error) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.on("close", () => finish("close"));
  });
}

// undefined until the status line and headers are in
function parseResponse(
  raw: Buffer,
  method: string,
): { response: ScenarioResponse; complete: boolean; byClose?: boolean } | undefined {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) {
    return undefined;
  }
  const [statusLine = "", ...headerLines] = raw.subarray(0, split).toString("latin1").split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const rest = raw.subarray(split + 4);

  if (method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200)) {
    return { response: { status, headers, body: new Uint8Array() }, complete: true };
  }
  if (headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
    const { body, complete } = decodeChunked(rest);
    return { response: { status, headers, body }, complete };
  }
  const length = headers.get("content-length");
  if (length !== null) {
    const body = new Uint8Array(rest.subarray(0, Number(length)));
    return { response: { status, headers, body }, complete: rest.length >= Number(length) };
  }
  // delimited by the end of the connection
  return {
    response: { status, headers, body: new Uint8Array(rest) },
    complete: false,
    byClose: true,
  };
}

function decodeChunked(raw: Buffer): { body: Uint8Array; complete: boolean } {
  const parts: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", pos);
    if (lineEnd < 0) {
      break;
    }
    const size = Number.parseInt(raw.subarray(pos, lineEnd).toString("latin1"), 16);
    if (size === 0) {
      return { body: new Uint8Array(Buffer.concat(parts)), complete: true };
    }
    const start = lineEnd + 2;
    parts.push(raw.subarray(start, Math.min(start + size, raw.length)));
    if (start + size + 2 > raw.length) {
      break;
    }
    pos = start + size + 2;
  }
  return { body: new Uint8Array(Buffer.concat(parts)), complete: false };
}

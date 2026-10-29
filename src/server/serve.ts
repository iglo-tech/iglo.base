// Upstream: apis/serve.go (the start banner and the http/https listener
// address handling only).
//
// Builds the router (@/apis/base) for the app and serves it with Bun.serve.
// The app is bootstrapped before (src/app/bootstrap.ts, called by
// src/cli/serve.ts). Not ported yet: CORS, gzip and trusted
// proxies (M5.7), the dashboard (M6.1), the installer (M6.2), automatic
// HTTPS (M6.3).

import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

import { newRouter } from "@/apis/base";
import type { App } from "@/app/app";
import { unescapeBytes } from "@/server/mux";
import { HttpRequest } from "@/server/request";
import { RereadableReadCloser, streamReader } from "@/server/rereadable-read-closer";
import { ResponseWriter, type Mux } from "@/server/router";

export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
  now(): Date;
  // whether the start banner may use ANSI colors
  color: boolean;
}

export interface ServeConfig {
  // TCP address for the HTTP server, e.g. "127.0.0.1:8090"
  httpAddr: string;
  // TCP address for the HTTPS server; empty means no TLS
  httpsAddr: string;
  // domains for the TLS certificate
  certificateDomains: string[];
  // CORS allowed origins
  allowedOrigins: string[];
  showStartBanner: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// log.LstdFlags prefix: "2006/01/02 15:04:05", local time.
export function logTime(now: Date): string {
  return `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// Go's net.LookupPort for "tcp": its built-in table, extended by
// /etc/services, matched case-insensitively.
function lookupTCPService(name: string): number | undefined {
  const services = new Map<string, number>([
    ["ftp", 21],
    ["ftps", 990],
    ["gopher", 70],
    ["http", 80],
    ["https", 443],
    ["imap2", 143],
    ["imap3", 220],
    ["imaps", 993],
    ["pop3", 110],
    ["pop3s", 995],
    ["smtp", 25],
    ["submissions", 465],
    ["ssh", 22],
    ["telnet", 23],
  ]);
  let file = "";
  try {
    file = readFileSync("/etc/services", "utf8");
  } catch {
    // no services file: the built-in table only
  }
  for (const rawLine of file.split("\n")) {
    const line = rawLine.split("#", 1)[0] ?? "";
    const [serviceName, portProto, ...aliases] = line.trim().split(/\s+/);
    const match = /^([0-9]+)\/tcp$/.exec(portProto ?? "");
    if (!serviceName || !match) {
      continue;
    }
    const servicePort = Number(match[1]);
    for (const alias of [serviceName, ...aliases]) {
      services.set(alias, servicePort);
    }
  }
  return services.get(name.toLowerCase());
}

// Go's net.Listen("tcp", ...) resolves a host name and listens on its first
// IPv4 address, or on its first address when it has no IPv4 one.
async function listenHost(host: string): Promise<string> {
  if (isIP(host) !== 0) {
    return host;
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`listen tcp: lookup ${host}: no such host`, { cause: err });
  }
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0];
  if (!chosen) {
    throw new Error(`listen tcp: lookup ${host}: no such host`);
  }
  return chosen.address;
}

// Go's net.SplitHostPort plus the port lookup net.Listen does.
function parseListenAddr(addr: string): { hostname: string; port: number } {
  const fail = (reason: string): Error => new Error(`listen tcp: address ${addr}: ${reason}`);
  let host: string;
  let port: string;
  if (addr.startsWith("[")) {
    const end = addr.indexOf("]");
    if (end === -1) {
      throw fail("missing ']' in address");
    }
    if (end + 1 === addr.length) {
      throw fail("missing port in address");
    }
    if (addr[end + 1] !== ":") {
      throw fail("unexpected ']' in address");
    }
    host = addr.slice(1, end);
    port = addr.slice(end + 2);
  } else {
    const colon = addr.lastIndexOf(":");
    if (colon === -1) {
      throw fail("missing port in address");
    }
    host = addr.slice(0, colon);
    port = addr.slice(colon + 1);
    if (host.includes(":")) {
      throw fail("too many colons in address");
    }
  }

  let portNumber: number;
  if (port === "") {
    portNumber = 0;
  } else if (/^[+-]?[0-9]*$/.test(port)) {
    // Go's parsePort: an optional sign, then digits ("+" alone is 0)
    const digits = port.replace(/^[+-]/, "");
    portNumber = digits === "" ? 0 : Number(digits);
    if (port.startsWith("-") && portNumber !== 0) {
      portNumber = -portNumber;
    }
    if (portNumber < 0 || portNumber > 65535) {
      throw new Error(`listen tcp: address ${port}: invalid port`);
    }
  } else {
    const service = lookupTCPService(port);
    if (service === undefined) {
      throw new Error(`listen tcp: lookup tcp/${port}: unknown port`);
    }
    portNumber = service;
  }

  // an empty or 0.0.0.0 host listens on all interfaces, IPv4 and IPv6,
  // as Go's net.Listen("tcp", ...) does for a wildcard address
  return { hostname: host === "" || host === "0.0.0.0" ? "::" : host, port: portNumber };
}

// serverAddrToHost loosely converts the server address into a host to print.
function serverAddrToHost(addr: string): string {
  if (addr === "" || addr.endsWith(":http") || addr.endsWith(":https")) {
    return "127.0.0.1";
  }
  return addr;
}

// Go's server answers a request target it cannot parse (an invalid
// percent escape in the path) before any handler runs.
function badRequest(): Response {
  return new Response("400 Bad Request", {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8", Connection: "close" },
  });
}

// net.Conn.RemoteAddr().String() for the client: IPv4 clients of a
// dual-stack listener are reported as IPv4, as Go does.
function remoteAddr(address: { address: string; port: number } | null): string {
  if (!address) {
    return "";
  }
  const ip = address.address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
  return ip.includes(":") ? `[${ip}]:${address.port}` : `${ip}:${address.port}`;
}

// Converts a Bun request into the router's request, runs it through the
// mux and resolves with the response: at the first flush for streamed
// responses, or when the handler returns.
export async function handleRequest(
  app: App,
  mux: Mux,
  request: Request,
  client: { address: string; port: number } | null,
): Promise<Response> {
  // the origin-form request target; Bun.serve has already resolved "." and
  // ".." segments in it (see the PR notes on path cleaning)
  const url = request.url;
  const target = url.slice(url.indexOf("/", url.indexOf("//") + 2));
  const q = target.indexOf("?");
  const escapedPath = q === -1 ? target : target.slice(0, q);
  const rawQuery = q === -1 ? "" : target.slice(q + 1);
  if (unescapeBytes(escapedPath) === undefined) {
    return badRequest();
  }

  const contentLengthHeader = request.headers.get("Content-Length");
  let contentLength = 0;
  if (contentLengthHeader !== null) {
    contentLength = Number(contentLengthHeader);
  } else if (request.headers.has("Transfer-Encoding")) {
    contentLength = -1;
  }

  // Go keeps the Host header in r.Host and drops Transfer-Encoding from r.Header
  const headers = new Headers(request.headers);
  headers.delete("Host");
  headers.delete("Transfer-Encoding");

  const req = new HttpRequest({
    method: request.method,
    host: request.headers.get("Host") ?? "",
    escapedPath,
    rawQuery,
    headers,
    body: new RereadableReadCloser(streamReader(request.body)),
    contentLength,
    remoteAddr: remoteAddr(client),
    tls: false,
  });

  return new Promise<Response>((resolve, reject) => {
    const rw = new ResponseWriter(resolve);
    mux.serveHTTP(rw, req).then(
      () => {
        try {
          const response = rw.finish();
          if (response) {
            resolve(response);
          }
        } catch (err) {
          // a status Bun cannot send (outside 200-599)
          reject(err);
        }
      },
      (err: unknown) => {
        // a panic that no middleware recovered
        app.logger.error(`http: panic serving ${req.remoteAddr}`, err);
        rw.finish();
        reject(err);
      },
    );
  });
}

function startBanner(out: Output, baseURL: string): void {
  const bold = (text: string): string => (out.color ? `\x1b[1;32m${text}\x1b[0m` : text);
  const cyan = (text: string): string => (out.color ? `\x1b[36m${text}\x1b[0m` : text);
  out.stdout(bold(`${logTime(out.now())} Server started at ${cyan(baseURL)}\n`));
  out.stdout(`> REST API:  ${cyan(`${baseURL}/api/`)}\n`);
}

// Starts the web server and resolves after it stops once shutdown is aborted.
export async function serve(
  app: App,
  config: ServeConfig,
  out: Output,
  shutdown: AbortSignal,
): Promise<void> {
  if (config.httpsAddr !== "") {
    throw new Error(
      "HTTPS is not implemented yet: --https and domain arguments are not supported in this build",
    );
  }

  const mux = newRouter(app).buildMux();

  const mainAddr = config.httpAddr;
  const parsed = parseListenAddr(mainAddr === "" ? ":http" : mainAddr);
  const hostname = await listenHost(parsed.hostname);
  const { port } = parsed;

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname,
      port,
      development: false,
      fetch: (request, bunServer) => handleRequest(app, mux, request, bunServer.requestIP(request)),
    });
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      throw new Error(`listen tcp ${mainAddr}: bind: address already in use`, { cause: err });
    }
    throw err;
  }

  if (config.showStartBanner) {
    startBanner(out, `http://${serverAddrToHost(mainAddr)}`);
  }

  if (!shutdown.aborted) {
    await new Promise<void>((resolve) =>
      shutdown.addEventListener("abort", () => resolve(), { once: true }),
    );
  }

  // graceful shutdown with upstream's 1 second limit
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1000).unref());
  await Promise.race([server.stop(), timeout]);
  await server.stop(true);
}

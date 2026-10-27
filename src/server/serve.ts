// Upstream: apis/serve.go (the start banner and the http/https listener
// address handling only).
//
// Minimal bootstrap until the router, middlewares and app context land in
// M0.3: the dispatch below is temporary. Not ported yet: migrations and
// pb_data (M0.4), CORS (M5.7), the dashboard (M6.1), the installer (M6.2),
// automatic HTTPS (M6.3).

import { healthCheck } from "@/apis/health";

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
  } else if (/^[0-9]+$/.test(port)) {
    portNumber = Number(port);
    if (portNumber > 65535) {
      throw new Error(`listen tcp: address ${port}: invalid port`);
    }
  } else if (port === "http") {
    portNumber = 80;
  } else if (port === "https") {
    portNumber = 443;
  } else {
    throw new Error(`listen tcp: lookup tcp/${port}: unknown port`);
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

function notFound(): Response {
  // router.NewNotFoundError("", nil), same key order as upstream's ApiError
  const body = JSON.stringify({
    data: {},
    message: "The requested resource wasn't found.",
    status: 404,
  });
  return new Response(body, { status: 404, headers: { "Content-Type": "application/json" } });
}

// Temporary dispatch, replaced by the router in M0.3.
function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/api/health") {
    return healthCheck();
  }
  return notFound();
}

function startBanner(out: Output, baseURL: string): void {
  const bold = (text: string): string => (out.color ? `\x1b[1;32m${text}\x1b[0m` : text);
  const cyan = (text: string): string => (out.color ? `\x1b[36m${text}\x1b[0m` : text);
  out.stdout(bold(`${logTime(out.now())} Server started at ${cyan(baseURL)}\n`));
  out.stdout(`> REST API:  ${cyan(`${baseURL}/api/`)}\n`);
}

// Starts the web server and resolves after it stops once shutdown is aborted.
export async function serve(
  config: ServeConfig,
  out: Output,
  shutdown: AbortSignal,
): Promise<void> {
  if (config.httpsAddr !== "") {
    throw new Error(
      "HTTPS is not implemented yet: --https and domain arguments are not supported in this build",
    );
  }

  const mainAddr = config.httpAddr;
  const { hostname, port } = parseListenAddr(mainAddr === "" ? ":http" : mainAddr);

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname, port, development: false, fetch: handle });
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

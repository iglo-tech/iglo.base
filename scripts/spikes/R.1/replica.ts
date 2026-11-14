// R.1 spike (throwaway, never merged): a read-only replica of iglo.base.
//
// Listens on the public port with SO_REUSEPORT. GET/HEAD requests for records
// (list, view, expand) and files are answered by the real router (newServeRouter,
// the same middlewares and handlers as the primary) over read-only SQLite
// connections, with the collections and settings loaded once at start. Every
// other request, including /api/realtime (streamed), is proxied to the primary
// over its Unix socket. Writes never touch pb_data from here.
//
//   bun scripts/spikes/R.1/replica.ts --socket <primary.sock> --http 127.0.0.1:<port> --dir <pb_data>

import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { loadCollectionsCache } from "@/collections/collection-save";
import { type App, type AppLogger, newApp } from "@/app/app";
import { Databases } from "@/db/base";
import { openReadOnly } from "@/db/connect";
import { newFromDB } from "@/db/dbx/db";
import { reloadSettings } from "@/settings/settings-query";
import { Store } from "@/tools/store/store";
import { handleRequest, newServeRouter } from "@/server/serve";

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    http: { type: "string" },
    dir: { type: "string" },
  },
  strict: true,
});
if (!values.socket || !values.http || !values.dir) {
  throw new Error("usage: replica.ts --socket <sock> --http <host:port> --dir <pb_data>");
}
const socket = values.socket;
const dataDir = resolve(values.dir);
const [hostname, portText] = [
  values.http.slice(0, values.http.lastIndexOf(":")),
  values.http.slice(values.http.lastIndexOf(":") + 1),
];

// the replica logs nothing: the primary keeps the logs (and the _logs table)
const noopLogger: AppLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  close() {},
  async suspend() {},
  resume() {},
};

// read-only connections, no read pool: the replica's parallelism is its processes
const databases = Databases.open({
  dataDir,
  queryTimeout: 30_000,
  readWorkers: 0,
  dbConnect: (path) => newFromDB(openReadOnly(path), "sqlite"),
});

const app: App = newApp({
  dataDir,
  isDev: false,
  encryptionEnv: "",
  queryTimeout: 30,
  clock: { now: () => new Date() },
  logger: noopLogger,
  databases,
  store: new Store<string, unknown>(),
});
loadCollectionsCache(app);
await reloadSettings(app);

const router = newServeRouter(app, {
  httpAddr: values.http,
  httpsAddr: "",
  certificateDomains: [],
  allowedOrigins: ["*"],
  publicDir: "",
  indexFallback: false,
  ui: undefined,
});
const mux = router.buildMux();

// the paths answered here: records (list, view, expand) and files
const localPath = /^\/api\/collections\/[^/]+\/records(\/[^/]+)?$|^\/api\/files\//;

async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const readsBody = request.method !== "GET" && request.method !== "HEAD";
  const headers = new Headers(request.headers);
  headers.delete("host");
  try {
    const upstream = await fetch(`http://primary${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: readsBody ? request.body : undefined,
      redirect: "manual",
      unix: socket,
      signal: request.signal,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch {
    return new Response("primary unavailable", { status: 502 });
  }
}

const server = Bun.serve({
  hostname,
  port: Number(portText),
  reusePort: true,
  development: false,
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  fetch(request, bunServer) {
    const { pathname } = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && localPath.test(pathname)) {
      return handleRequest(app, mux, request, bunServer.requestIP(request), () =>
        bunServer.timeout(request, 0),
      );
    }
    return proxy(request);
  },
});

console.log(`replica ready pid=${process.pid} port=${server.port}`);

const stop = async (): Promise<void> => {
  await server.stop(true);
  await databases.shutdown();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

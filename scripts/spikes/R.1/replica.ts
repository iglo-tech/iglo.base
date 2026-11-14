// R.1/R.2 gate prototype (throwaway): a read-only replica of iglo.base.
//
// The public port is a raw front (Bun.listen, SO_REUSEPORT). A connection is pinned
// by its first request: GET/HEAD of a local route goes to this replica's own server
// (Bun.serve on a private Unix socket: records and files, read-only SQLite, the
// primary's router and middlewares); anything else goes to the primary's Unix socket
// as raw bytes, both ways. Requests that reach the local server but are not local
// (a write on a read-pinned connection) go to the primary through the hop module
// (src/replicas/primary-hop.ts). The front parses nothing after the first request line.
//
//   bun scripts/spikes/R.1/replica.ts --socket <primary.sock> --local <replica.sock>
//     --http 127.0.0.1:<port> --dir <pb_data>

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

import { loadCollectionsCache } from "@/collections/collection-save";
import { type App, type AppLogger, newApp } from "@/app/app";
import { Databases } from "@/db/base";
import { openReadOnly } from "@/db/connect";
import { newFromDB } from "@/db/dbx/db";
import { reloadSettings } from "@/settings/settings-query";
import { Store } from "@/tools/store/store";
import { handleRequest, newServeRouter } from "@/server/serve";
import { newPrimaryHop } from "@/replicas/primary-hop";

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    local: { type: "string" },
    http: { type: "string" },
    dir: { type: "string" },
  },
  strict: true,
});
if (!values.socket || !values.local || !values.http || !values.dir) {
  throw new Error("usage: replica.ts --socket <sock> --local <sock> --http <host:port> --dir <pb_data>");
}
const socket = values.socket;
const localSocket = values.local;
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

const hop = newPrimaryHop(socket);

async function proxy(request: Request): Promise<Response> {
  try {
    return await hop.send(request);
  } catch {
    return new Response("primary unavailable", { status: 502 });
  }
}

// the replica's own server, behind the front: local routes here, the rest through the hop
const local = Bun.serve({
  unix: localSocket,
  development: false,
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  fetch(request, bunServer) {
    const { pathname } = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && localPath.test(pathname)) {
      return handleRequest(app, mux, request, null, () => bunServer.timeout(request, 0));
    }
    return proxy(request);
  },
});

type Pin = {
  decided: boolean;
  up: { write(d: Uint8Array): number; end(): void } | undefined;
  pending: Uint8Array[];
  head: Uint8Array | undefined;
};

const localRoute = (line: string): boolean => {
  const sp1 = line.indexOf(" ");
  const sp2 = line.indexOf(" ", sp1 + 1);
  if (sp1 < 0 || sp2 < 0) {
    return false;
  }
  const method = line.slice(0, sp1);
  const target = line.slice(sp1 + 1, sp2);
  const q = target.indexOf("?");
  const path = q === -1 ? target : target.slice(0, q);
  return (method === "GET" || method === "HEAD") && localPath.test(path);
};

const front = Bun.listen<Pin>({
  hostname,
  port: Number(portText),
  reusePort: true,
  socket: {
    open(s) {
      s.data = { decided: false, up: undefined, pending: [], head: undefined };
    },
    data(s, d) {
      const pin = s.data;
      if (!pin.decided) {
        const all = pin.head === undefined ? new Uint8Array(d) : concat(pin.head, d);
        const eol = indexOfCRLF(all);
        if (eol < 0) {
          pin.head = all;
          return;
        }
        pin.head = undefined;
        pin.decided = true;
        const line = new TextDecoder().decode(all.subarray(0, eol));
        const path = localRoute(line) ? localSocket : socket;
        Bun.connect<Pin>({
          unix: path,
          data: s.data,
          socket: {
            open(u) {
              const p = u.data;
              p.up = u;
              for (const chunk of p.pending) {
                u.write(chunk);
              }
              p.pending = [];
            },
            data(_u, chunk) {
              s.write(chunk);
            },
            close() {
              s.end();
            },
            error() {
              s.end();
            },
            drain() {},
          },
        }).catch(() => s.end());
        pin.pending.push(all);
        return;
      }
      const copy = new Uint8Array(d);
      if (pin.up) {
        pin.up.write(copy);
      } else {
        pin.pending.push(copy);
      }
    },
    close(s) {
      s.data.up?.end();
    },
    error(s) {
      s.data.up?.end();
    },
    drain() {},
  },
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfCRLF(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) {
      return i;
    }
  }
  return -1;
}

console.log(`replica ready pid=${process.pid} port=${front.port}`);

const stop = async (): Promise<void> => {
  front.stop(true);
  local.stop(true);
  hop.close();
  await databases.shutdown();
  rmSync(localSocket, { force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

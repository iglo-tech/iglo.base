// M5.1: 1,000 realtime connections on iglo.base and on upstream PocketBase
// v0.41.0. Not shipped; needs `bun run upstream:prepare` and `bun run build`
// (it runs dist/iglo-base). Report: docs/perf/M5.1-realtime.md.
//
//   nice -n 10 bun test/perf/realtime/measure.ts [--target iglo-base,upstream] [--connections 1000]
//
// Per target, one server at a time on a fresh pb_data (a superuser and a
// user, created through upstream's CLI and the API; the collections
// `notes` with list rule "" and `private` with list rule
// "@request.auth.id != ''", which needs one SQL query per subscriber and
// message on both servers). The clients are raw sockets in this process.
// Phases:
//
//   1. open the connections, 50 at a time, each waiting for PB_CONNECT, and
//      subscribe each as a guest to `notes/*`: server RSS and open fds;
//   2. 20 broadcasts with 64 B of data and 5 with 16 KiB (a record create
//      in `notes`), 200 ms apart: the time from the create request to each
//      client's receipt (per client p50/p99, and the last client);
//   3. every client subscribes to `private/*` as the user, then 20 64 B
//      broadcasts in `private`: the same, with a rule query per client.
//
// The script stops a target when MemAvailable falls under 1.5 GiB, and
// removes everything it wrote.

import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  apiClient,
  guardMemory,
  hostFacts,
  memAvailableMiB,
  percentile,
  procStats,
  repoRoot,
  sampler,
  spikeRoot,
  startUpstreamServer,
  upsertSuperuser,
  type Server,
} from "@/../scripts/spikes/M0.8/common";

import { freePort } from "@test/support/executable";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "iglo-base,upstream" },
    connections: { type: "string", default: "1000" },
  },
});
const targets = values.target.split(",");
const total = Number(values.connections);

interface Round {
  t0: number;
  latencies: number[];
}

let round: Round | undefined;

class Conn {
  readonly socket: Socket;
  clientId = "";
  received = 0;
  closed = false;
  #buf = "";
  #headersDone = false;
  #connected: Promise<void>;

  constructor(port: number) {
    this.socket = connect({ host: "127.0.0.1", port });
    this.socket.setEncoding("latin1");
    let resolveConnected!: () => void;
    let rejectConnected!: (e: Error) => void;
    this.#connected = new Promise((res, rej) => {
      resolveConnected = res;
      rejectConnected = rej;
    });
    this.socket.on("connect", () => {
      this.socket.write(
        `GET /api/realtime HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`,
      );
    });
    this.socket.on("data", (d: string) => {
      this.#buf += d;
      if (!this.#headersDone) {
        const at = this.#buf.indexOf("\r\n\r\n");
        if (at < 0) {
          return;
        }
        this.#headersDone = true;
        this.#buf = this.#buf.slice(at + 4);
      }
      for (;;) {
        const end = this.#buf.indexOf("\n\n");
        if (end < 0) {
          break;
        }
        const event = this.#buf.slice(0, end);
        this.#buf = this.#buf.slice(end + 2);
        if (/(?:^|\n)event:PB_CONNECT/.test(event)) {
          this.clientId = /"clientId":"([^"]+)"/.exec(event)?.[1] ?? "";
          resolveConnected();
          continue;
        }
        this.received++;
        round?.latencies.push(performance.now() - round.t0);
      }
    });
    this.socket.on("error", (e) => rejectConnected(e));
    this.socket.on("close", () => {
      this.closed = true;
      rejectConnected(new Error("closed before PB_CONNECT"));
    });
  }

  connected(): Promise<void> {
    return this.#connected;
  }
}

async function startIglo(dataDir: string, root: string): Promise<Server> {
  const port = await freePort();
  const proc = Bun.spawn(
    [join(repoRoot, "dist/iglo-base"), "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir],
    { cwd: root, stdout: "ignore", stderr: "inherit", env: { ...process.env, NO_COLOR: "1" } },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        break;
      }
    } catch {
      if (i > 400) {
        proc.kill("SIGKILL");
        throw new Error("iglo-base did not start");
      }
      await Bun.sleep(25);
    }
  }
  return {
    url,
    port,
    pid: proc.pid,
    output: () => "",
    async stop() {
      proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
      await proc.exited;
      clearTimeout(timer);
    },
  };
}

function fmt(s: { rssMiB: number; fds: number }): string {
  return `RSS ${s.rssMiB.toFixed(1)} MiB, ${s.fds} fds`;
}

async function subscribeAll(
  call: ReturnType<typeof apiClient>["call"],
  conns: Conn[],
  topic: string,
  token: string,
  url: string,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      while (next < conns.length) {
        const c = conns[next++] as Conn;
        const res = token
          ? await fetch(`${url}/api/realtime`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: token },
              body: JSON.stringify({ clientId: c.clientId, subscriptions: [topic] }),
            })
          : await call("POST", "/api/realtime", { clientId: c.clientId, subscriptions: [topic] });
        if (res.status !== 204) {
          throw new Error(`subscribe: ${res.status}`);
        }
      }
    }),
  );
}

async function broadcasts(
  conns: Conn[],
  count: number,
  create: () => Promise<void>,
): Promise<{ all: number[]; lasts: number[]; missed: number; creates: number[] }> {
  const all: number[] = [];
  const lasts: number[] = [];
  const creates: number[] = [];
  let missed = 0;
  for (let i = 0; i < count; i++) {
    const before = conns.map((c) => c.received);
    const r: Round = { t0: performance.now(), latencies: [] };
    round = r;
    await create();
    creates.push(performance.now() - r.t0);
    const deadline = performance.now() + 15_000;
    while (r.latencies.length < conns.length && performance.now() < deadline) {
      await Bun.sleep(1);
    }
    round = undefined;
    missed += conns.filter((c, j) => c.received === before[j]).length;
    all.push(...r.latencies);
    lasts.push(Math.max(...r.latencies));
    await Bun.sleep(200);
  }
  all.sort((a, b) => a - b);
  lasts.sort((a, b) => a - b);
  creates.sort((a, b) => a - b);
  return { all, lasts, missed, creates };
}

function report(
  label: string,
  r: { all: number[]; lasts: number[]; missed: number; creates: number[] },
): void {
  console.log(
    `${label}: per client p50 ${percentile(r.all, 0.5).toFixed(1)} ms, p99 ${percentile(r.all, 0.99).toFixed(1)} ms; last client p50 ${percentile(r.lasts, 0.5).toFixed(1)} ms, max ${(r.lasts.at(-1) ?? 0).toFixed(1)} ms; create response p50 ${percentile(r.creates, 0.5).toFixed(1)} ms; missed ${r.missed}`,
  );
}

async function measure(name: string): Promise<void> {
  const spike = spikeRoot(`m51-realtime-${name}`);
  const conns: Conn[] = [];
  let server: Server | undefined;
  let watch: ReturnType<typeof sampler> | undefined;
  try {
    guardMemory(2500);
    const dataDir = join(spike.root, "pb_data");
    await upsertSuperuser(dataDir, spike.root, "perf@example.com", "1234567890");
    server =
      name === "upstream"
        ? await startUpstreamServer(dataDir, spike.root)
        : await startIglo(dataDir, spike.root);
    const pid = server.pid;
    const stopping = server;
    watch = sampler(pid, () => {
      console.log("MemAvailable under 1.5 GiB: stopping");
      void stopping.stop();
    });

    const api = apiClient(server.url);
    await api.loginSuperuser("perf@example.com", "1234567890");
    for (const [collection, listRule] of [
      ["notes", ""],
      ["private", "@request.auth.id != ''"],
    ]) {
      await api.must("POST", "/api/collections", {
        name: collection,
        type: "base",
        listRule,
        viewRule: listRule,
        createRule: "",
        fields: [{ name: "title", type: "text", max: 100_000 }],
      });
    }
    await api.must("POST", "/api/collections/users/records", {
      email: "user@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
    });
    const auth = (await api.must("POST", "/api/collections/users/auth-with-password", {
      identity: "user@example.com",
      password: "1234567890",
    })) as { token: string };
    const guest = apiClient(server.url);
    let n = 0;
    const create = (collection: string, size: number) => async (): Promise<void> => {
      await guest.must("POST", `/api/collections/${collection}/records`, {
        title: `${++n}:${"x".repeat(Math.max(0, size - 120))}`,
      });
    };

    // warm-up: one connection and one broadcast
    const warm = new Conn(server.port);
    await warm.connected();
    await subscribeAll(guest.call, [warm], "notes/*", "", server.url);
    await broadcasts([warm], 1, create("notes", 64));
    warm.socket.destroy();
    await Bun.sleep(500);
    const base = procStats(pid);
    console.log(
      `\n## ${name}\nbefore: ${fmt(base)}, MemAvailable ${memAvailableMiB().toFixed(0)} MiB`,
    );

    const started = performance.now();
    for (let i = 0; i < total; i += 50) {
      const batch = Array.from(
        { length: Math.min(50, total - i) },
        () => new Conn((server as Server).port),
      );
      conns.push(...batch);
      await Promise.all(batch.map((c) => c.connected()));
    }
    const connectMs = performance.now() - started;
    await subscribeAll(guest.call, conns, "notes/*", "", server.url);
    await Bun.sleep(1000);
    const held = procStats(pid);
    console.log(
      `${total} connected in ${connectMs.toFixed(0)} ms and subscribed: ${fmt(held)}; per connection ${(((held.rssMiB - base.rssMiB) * 1024) / total).toFixed(1)} KiB RSS, ${((held.fds - base.fds) / total).toFixed(2)} fds; MemAvailable ${memAvailableMiB().toFixed(0)} MiB`,
    );

    guardMemory(2000);
    report(`64 B x20 to ${total}, list rule ""`, await broadcasts(conns, 20, create("notes", 64)));
    guardMemory(2000);
    report(
      `16 KiB x5 to ${total}, list rule ""`,
      await broadcasts(conns, 5, create("notes", 16 * 1024)),
    );
    console.log(`after the broadcasts: ${fmt(procStats(pid))}`);

    await subscribeAll(guest.call, conns, "private/*", auth.token, server.url);
    guardMemory(2000);
    report(
      `64 B x20 to ${total}, list rule "@request.auth.id != ''"`,
      await broadcasts(conns, 20, create("private", 64)),
    );
    const end = procStats(pid);
    console.log(`after the rule broadcasts: ${fmt(end)}; peak RSS ${end.hwmMiB.toFixed(1)} MiB`);
  } finally {
    watch?.stop();
    for (const c of conns) {
      c.socket.destroy();
    }
    await server?.stop();
    spike.cleanup();
  }
}

console.log(hostFacts());
for (const name of targets) {
  await measure(name);
}

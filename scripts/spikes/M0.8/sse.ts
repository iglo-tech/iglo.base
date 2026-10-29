// M0.8 spike 2: 1,000 idle SSE connections on a throwaway Bun.serve server
// (scripts/spikes/M0.8/sse-server.ts) and on upstream PocketBase v0.41.0's
// /api/realtime. Not shipped; needs `bun run upstream:prepare`. Report:
// docs/perf/M0.8-sse.md.
//
//   nice -n 10 bun scripts/spikes/M0.8/sse.ts [--target bun-default,bun-idle0,bun-timeout0,upstream] [--connections 1000]
//
// bun-default: Bun's default idleTimeout (10 s); bun-idle0: idleTimeout 0;
// bun-timeout0: the default, and server.timeout(req, 0) per realtime request.
//
// Per target, a fresh server process; the clients are raw sockets in this
// process. Phases: open the connections (batches of 50, each waits for
// PB_CONNECT; upstream clients then subscribe to "notes/*"), stay idle for
// 15 s (past Bun's default 10 s idleTimeout), 20 small and 5 16 KiB
// broadcasts (latency from the trigger to each client's receipt), close
// 40% of the clients with a TCP reset and 40% with a FIN, broadcast to the
// rest, then keep 10 clients, stop reading on one of them and broadcast
// 400 messages of 64 KiB (backpressure). The Bun server broadcasts on
// POST /broadcast; upstream broadcasts a record create in `notes` (list
// rule ""). Server RSS and open file descriptors come from /proc.

import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { freePort } from "@test/support/executable";
import {
  apiClient,
  guardMemory,
  hostFacts,
  memAvailableMiB,
  percentile,
  procStats,
  repoRoot,
  spikeRoot,
  startUpstreamServer,
  upsertSuperuser,
  type Server,
} from "@/../scripts/spikes/M0.8/common";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "bun-default,bun-idle0,bun-timeout0,upstream" },
    connections: { type: "string", default: "1000" },
  },
});
const targets = values.target.split(",");
const total = Number(values.connections);

interface Round {
  n: number;
  t0: number;
  latencies: number[];
}

let round: Round | undefined;

class Conn {
  readonly socket: Socket;
  clientId = "";
  closedAt = 0;
  received = 0;
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
        const name = /(?:^|\n)event:([^\n]*)/.exec(event)?.[1] ?? "";
        if (name === "PB_CONNECT") {
          this.clientId = /"clientId":"([^"]+)"/.exec(event)?.[1] ?? "";
          resolveConnected();
          continue;
        }
        this.received++;
        if (round) {
          round.latencies.push(performance.now() - round.t0);
        }
      }
    });
    this.socket.on("error", (e) => rejectConnected(e));
    this.socket.on("close", () => {
      this.closedAt ||= performance.now();
      rejectConnected(new Error("closed before PB_CONNECT"));
    });
  }

  connected(): Promise<void> {
    return this.#connected;
  }

  open(): boolean {
    return this.closedAt === 0;
  }
}

interface Target {
  server: Server;
  // triggers one broadcast of about `size` bytes
  broadcast(n: number, size: number): Promise<void>;
  stats(): Promise<unknown>;
  // after PB_CONNECT
  subscribe?(conns: Conn[]): Promise<void>;
}

async function startBunTarget(root: string, idle: string): Promise<Target> {
  const port = await freePort();
  const proc = Bun.spawn(
    [process.execPath, join(repoRoot, "scripts/spikes/M0.8/sse-server.ts"), String(port), idle],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        break;
      }
    } catch {
      if (i > 200) {
        throw new Error("spike server did not start");
      }
      await Bun.sleep(25);
    }
  }
  return {
    server: {
      url,
      port,
      pid: proc.pid,
      output: () => "",
      async stop() {
        proc.kill("SIGKILL");
        await proc.exited;
      },
    },
    async broadcast(_n, size) {
      const res = await fetch(`${url}/broadcast?size=${size}`, { method: "POST" });
      await res.arrayBuffer();
    },
    async stats() {
      return (await fetch(`${url}/stats`)).json();
    },
  };
}

async function startUpstreamTarget(root: string): Promise<Target> {
  const dataDir = join(root, "pb_data");
  await upsertSuperuser(dataDir, root, "spike@example.com", "1234567890");
  const server = await startUpstreamServer(dataDir, root);
  const api = apiClient(server.url);
  await api.loginSuperuser("spike@example.com", "1234567890");
  await api.must("POST", "/api/collections", {
    name: "notes",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    fields: [{ name: "title", type: "text", max: 100_000 }],
  });
  const guest = apiClient(server.url);
  return {
    server,
    async broadcast(n, size) {
      await guest.must("POST", "/api/collections/notes/records", {
        title: `${n}:${"x".repeat(Math.max(0, size - 120))}`,
      });
    },
    async stats() {
      return {};
    },
    async subscribe(conns) {
      let next = 0;
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          while (next < conns.length) {
            const c = conns[next++] as Conn;
            await guest.must("POST", "/api/realtime", {
              clientId: c.clientId,
              subscriptions: ["notes/*"],
            });
          }
        }),
      );
    },
  };
}

function fmt(s: { rssMiB: number; fds: number; threads: number }): string {
  return `RSS ${s.rssMiB.toFixed(1)} MiB, ${s.fds} fds, ${s.threads} threads`;
}

async function broadcastRound(
  t: Target,
  conns: Conn[],
  n: number,
  size: number,
): Promise<{ latencies: number[]; missing: number }> {
  const open = conns.filter((c) => c.open());
  const before = open.map((c) => c.received);
  round = { n, t0: performance.now(), latencies: [] };
  const r = round;
  await t.broadcast(n, size);
  const deadline = performance.now() + 10_000;
  while (r.latencies.length < open.length && performance.now() < deadline) {
    await Bun.sleep(1);
  }
  round = undefined;
  const missing = open.filter((c, i) => c.received === before[i]).length;
  return { latencies: r.latencies, missing };
}

async function scenario(name: string): Promise<void> {
  const spike = spikeRoot(`m08-sse-${name}`);
  const conns: Conn[] = [];
  let t: Target | undefined;
  try {
    guardMemory(2500);
    t =
      name === "upstream"
        ? await startUpstreamTarget(spike.root)
        : await startBunTarget(
            spike.root,
            name === "bun-idle0" ? "0" : name === "bun-timeout0" ? "per-request" : "default",
          );
    const pid = t.server.pid;
    // warm-up: one connection and one broadcast
    const warm = new Conn(t.server.port);
    await warm.connected();
    await t.subscribe?.([warm]);
    await broadcastRound(t, [warm], 0, 64);
    warm.socket.destroy();
    await Bun.sleep(500);
    const base = procStats(pid);
    console.log(
      `\n## ${name}\nbefore: ${fmt(base)}, MemAvailable ${memAvailableMiB().toFixed(0)} MiB`,
    );

    const started = performance.now();
    for (let i = 0; i < total; i += 50) {
      const batch = Array.from({ length: Math.min(50, total - i) }, () => new Conn(t!.server.port));
      conns.push(...batch);
      await Promise.all(batch.map((c) => c.connected()));
    }
    const connectMs = performance.now() - started;
    await t.subscribe?.(conns);
    await Bun.sleep(1000);
    const held = procStats(pid);
    console.log(
      `${total} connected in ${connectMs.toFixed(0)} ms: ${fmt(held)}; per connection ${(((held.rssMiB - base.rssMiB) * 1024) / total).toFixed(1)} KiB RSS, ${((held.fds - base.fds) / total).toFixed(2)} fds; MemAvailable ${memAvailableMiB().toFixed(0)} MiB`,
    );
    console.log(`server stats: ${JSON.stringify(await t.stats())}`);

    const idleStart = performance.now();
    await Bun.sleep(15_000);
    const closedIdle = conns.filter((c) => !c.open());
    const firstClose = Math.min(...closedIdle.map((c) => c.closedAt - idleStart));
    console.log(
      `after 15 s idle: ${closedIdle.length} of ${total} closed by the server${closedIdle.length ? ` (first after ${(firstClose / 1000).toFixed(1)} s idle)` : ""}; ${fmt(procStats(pid))}`,
    );
    if (closedIdle.length === total) {
      console.log(`server stats: ${JSON.stringify(await t.stats())}`);
      return;
    }

    for (const [label, size, count] of [
      ["small (64 B data)", 64, 20],
      ["16 KiB", 16 * 1024, 5],
    ] as const) {
      const all: number[] = [];
      const lasts: number[] = [];
      let missing = 0;
      for (let i = 0; i < count; i++) {
        const r = await broadcastRound(t, conns, i + 1, size);
        all.push(...r.latencies);
        lasts.push(Math.max(...r.latencies));
        missing += r.missing;
        await Bun.sleep(200);
      }
      all.sort((a, b) => a - b);
      lasts.sort((a, b) => a - b);
      console.log(
        `broadcast ${label} x${count} to ${conns.filter((c) => c.open()).length}: per client p50 ${percentile(all, 0.5).toFixed(2)} ms, p99 ${percentile(all, 0.99).toFixed(2)} ms; last client p50 ${percentile(lasts, 0.5).toFixed(2)} ms, max ${(lasts.at(-1) ?? 0).toFixed(2)} ms; missed ${missing}`,
      );
    }
    console.log(`after broadcasts: ${fmt(procStats(pid))}`);

    // abrupt disconnects: 40% reset (RST), 40% FIN
    const reset = conns.slice(0, Math.floor(total * 0.4));
    const fin = conns.slice(reset.length, reset.length * 2);
    for (const c of reset) {
      c.socket.resetAndDestroy();
    }
    for (const c of fin) {
      c.socket.destroy();
    }
    await Bun.sleep(2000);
    const rest = conns.slice(reset.length * 2);
    const after = await broadcastRound(t, rest, 100, 64);
    await Bun.sleep(1000);
    console.log(
      `after ${reset.length} RST + ${fin.length} FIN and one broadcast: ${fmt(procStats(pid))}; ${rest.length - after.missing} of ${rest.length} remaining received it; server stats: ${JSON.stringify(await t.stats())}`,
    );

    // backpressure: keep 10 clients, one stops reading
    for (const c of rest.slice(10)) {
      c.socket.destroy();
    }
    await Bun.sleep(1000);
    const ten = rest.slice(0, 10);
    const slow = ten[0] as Conn;
    slow.socket.pause();
    const bpBase = procStats(pid);
    for (let i = 0; i < 400; i++) {
      await t.broadcast(1000 + i, 64 * 1024);
      if (i % 50 === 49) {
        guardMemory(2000);
      }
    }
    await Bun.sleep(1000);
    const bp = procStats(pid);
    console.log(
      `slow client (paused) after 400 x 64 KiB (25 MiB) broadcasts to 10 clients: RSS ${bpBase.rssMiB.toFixed(1)} -> ${bp.rssMiB.toFixed(1)} MiB; slow client received ${slow.received}, others ${ten[1]?.received}; server stats: ${JSON.stringify(await t.stats())}`,
    );
    slow.socket.resume();
    const deadline = performance.now() + 30_000;
    while (slow.received < (ten[1]?.received ?? 0) && performance.now() < deadline) {
      await Bun.sleep(50);
    }
    await Bun.sleep(1000);
    console.log(
      `slow client resumed: received ${slow.received}; ${fmt(procStats(pid))}; server stats: ${JSON.stringify(await t.stats())}`,
    );
  } finally {
    for (const c of conns) {
      c.socket.destroy();
    }
    await t?.server.stop();
    spike.cleanup();
  }
}

console.log(hostFacts());
for (const name of targets) {
  await scenario(name);
}

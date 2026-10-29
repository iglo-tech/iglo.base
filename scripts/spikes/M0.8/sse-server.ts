// M0.8 spike 2: a throwaway Bun.serve SSE server with upstream's realtime
// framing (apis/realtime.go, tools/subscriptions/message.go). Not the M5.1
// broker; started by scripts/spikes/M0.8/sse.ts.
//
//   bun scripts/spikes/M0.8/sse-server.ts <port> <idleTimeout seconds | default | per-request>
//
// per-request: the default idleTimeout, and server.timeout(req, 0) on each
// realtime request
//
//   GET  /api/realtime      text/event-stream; PB_CONNECT, then broadcasts
//   POST /broadcast?size=n  one message of about n data bytes to every client
//   GET  /stats             clients, cancelled streams, queued bytes
//   GET  /api/health        200

const [portArg, idleArg] = process.argv.slice(2);
const encoder = new TextEncoder();
// bytes queued in a stream before desiredSize goes below zero
const highWaterMark = 64 * 1024;

interface Client {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const clients = new Map<string, Client>();
let cancelled = 0;
let enqueueErrors = 0;
let seq = 0;

// upstream's client ids are 40 random [a-zA-Z0-9] characters
function clientId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(40));
  let id = "";
  for (const b of bytes) {
    id += alphabet[b % alphabet.length];
  }
  return id;
}

// Message.WriteSSE: "id:<clientId>\nevent:<name>\ndata:<data>\n\n"
function sse(id: string, name: string, data: string): Uint8Array {
  return encoder.encode(`id:${id}\nevent:${name}\ndata:${data}\n\n`);
}

function send(client: Client, chunk: Uint8Array): void {
  try {
    client.controller.enqueue(chunk);
  } catch {
    enqueueErrors++;
    clients.delete(client.id);
  }
}

const server: Bun.Server<undefined> = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(portArg),
  ...(idleArg === undefined || idleArg === "default" || idleArg === "per-request"
    ? {}
    : { idleTimeout: Number(idleArg) }),
  fetch(req, srv): Response {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      return Response.json({ message: "API is healthy.", code: 200, data: {} });
    }
    if (url.pathname === "/api/realtime" && req.method === "GET") {
      if (idleArg === "per-request") {
        srv.timeout(req, 0);
      }
      const id = clientId();
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            const client = { id, controller };
            clients.set(id, client);
            send(client, sse(id, "PB_CONNECT", `{"clientId":"${id}"}`));
          },
          cancel() {
            cancelled++;
            clients.delete(id);
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark }),
      );
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    if (url.pathname === "/broadcast" && req.method === "POST") {
      const size = Number(url.searchParams.get("size") ?? "64");
      const n = ++seq;
      const pad = "x".repeat(Math.max(0, size - 40));
      const started = performance.now();
      // one framed message per client, as upstream writes the client id
      for (const client of clients.values()) {
        send(client, sse(client.id, "spike", `{"n":${n},"pad":"${pad}"}`));
      }
      return Response.json({ n, clients: clients.size, enqueueMs: performance.now() - started });
    }
    if (url.pathname === "/stats") {
      let queued = 0;
      let minDesired = Number.POSITIVE_INFINITY;
      for (const client of clients.values()) {
        const desired = client.controller.desiredSize ?? 0;
        minDesired = Math.min(minDesired, desired);
        queued += highWaterMark - desired;
      }
      return Response.json({
        clients: clients.size,
        cancelled,
        enqueueErrors,
        pending: server.pendingRequests,
        queuedBytes: queued,
        minDesiredSize: Number.isFinite(minDesired) ? minDesired : null,
      });
    }
    return new Response("not found", { status: 404 });
  },
});

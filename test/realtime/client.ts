// A realtime test client over plain TCP sockets, for both servers: the SSE
// stream of GET /api/realtime (HTTP/1.1, chunked or not) parsed into events,
// and plain requests (POST /api/realtime, the records API). A socket can
// use another loopback source address (127.0.0.2), which is how the
// "different IP" scenario reaches the server without trusted proxy headers.

import { connect, type Socket } from "node:net";

export interface SseEvent {
  id: string;
  event: string;
  data: string;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  body: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // the source address of the connection, 127.0.0.1 unless set
  localAddress?: string;
}

// Sends one request and reads the whole response (Connection: close).
export function request(
  baseUrl: string,
  target: string,
  options: RequestOptions = {},
): Promise<HttpResult> {
  const { hostname, port } = new URL(baseUrl);
  const body = options.body ?? "";
  const lines = [
    `${options.method ?? "GET"} ${target} HTTP/1.1`,
    `Host: ${hostname}:${port}`,
    "Connection: close",
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    lines.push(`${k}: ${v}`);
  }
  const head = `${lines.join("\r\n")}\r\n\r\n`;

  return new Promise((resolve, reject) => {
    const socket = connect({
      host: hostname,
      port: Number(port),
      localAddress: options.localAddress ?? "127.0.0.1",
    });
    const chunks: Buffer[] = [];
    socket.setTimeout(10_000, () => socket.destroy(new Error("request timed out")));
    socket.on("connect", () => socket.write(head + body));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        const parsed = new ResponseParser();
        parsed.push(Buffer.concat(chunks));
        if (parsed.status === 0) {
          throw new Error("no response");
        }
        resolve({
          status: parsed.status,
          headers: parsed.headers,
          body: parsed.body.toString("utf8"),
        });
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

// JSON request helper: sets Content-Type and serializes the body.
export function jsonRequest(
  baseUrl: string,
  method: string,
  target: string,
  body: unknown,
  headers: Record<string, string> = {},
  localAddress?: string,
): Promise<HttpResult> {
  return request(baseUrl, target, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
    localAddress,
  });
}

// An open GET /api/realtime stream.
export class RealtimeStream {
  readonly events: SseEvent[] = [];
  closed = false;
  #parser = new ResponseParser();
  #decoder = new TextDecoder();
  #text = "";
  #waiters: (() => void)[] = [];
  #socket: Socket;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#parser.push(chunk);
      this.#text += this.#decoder.decode(this.#parser.takeBody(), { stream: true });
      this.#parseEvents();
      this.#notify();
    });
    const onEnd = (): void => {
      this.closed = true;
      this.#notify();
    };
    socket.on("close", onEnd);
    socket.on("error", onEnd);
  }

  get status(): number {
    return this.#parser.status;
  }

  get headers(): Headers {
    return this.#parser.headers;
  }

  // the PB_CONNECT client id
  get clientId(): string {
    const connected = this.events.find((e) => e.event === "PB_CONNECT");
    if (!connected) {
      throw new Error("no PB_CONNECT event");
    }
    return (JSON.parse(connected.data) as { clientId: string }).clientId;
  }

  // Opens the stream and waits for PB_CONNECT.
  static async open(
    baseUrl: string,
    options: { localAddress?: string; headers?: Record<string, string> } = {},
  ): Promise<RealtimeStream> {
    const { hostname, port } = new URL(baseUrl);
    const socket = connect({
      host: hostname,
      port: Number(port),
      localAddress: options.localAddress ?? "127.0.0.1",
    });
    const stream = new RealtimeStream(socket);
    const lines = [
      "GET /api/realtime HTTP/1.1",
      `Host: ${hostname}:${port}`,
      "Accept: text/event-stream",
    ];
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      lines.push(`${k}: ${v}`);
    }
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    await stream.waitFor((events) => events.some((e) => e.event === "PB_CONNECT"), 5000);
    return stream;
  }

  // Waits until check(events) is true; throws after timeoutMs.
  async waitFor(check: (events: SseEvent[]) => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check(this.events)) {
      if (this.closed) {
        throw new Error(`stream closed while waiting (events: ${JSON.stringify(this.events)})`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timed out waiting for events (got: ${JSON.stringify(this.events)})`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // The events after PB_CONNECT once no new one arrived for quietMs.
  async settle(quietMs = 300): Promise<SseEvent[]> {
    let count = -1;
    while (count !== this.events.length) {
      count = this.events.length;
      await Bun.sleep(quietMs);
    }
    return this.events.filter((e) => e.event !== "PB_CONNECT");
  }

  // Waits for the server to end the stream.
  async waitClosed(timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    return this.closed;
  }

  // the raw body text received so far
  get text(): string {
    return this.#text;
  }

  pause(): void {
    this.#socket.pause();
  }

  resume(): void {
    this.#socket.resume();
  }

  close(): void {
    this.#socket.destroy();
    this.closed = true;
  }

  #parseEvents(): void {
    for (;;) {
      const end = this.#text.indexOf("\n\n");
      if (end === -1) {
        return;
      }
      const block = this.#text.slice(0, end);
      this.#text = this.#text.slice(end + 2);
      const event: SseEvent = { id: "", event: "", data: "" };
      for (const line of block.split("\n")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1);
        if (field === "id" || field === "event" || field === "data") {
          event[field] = value;
        }
      }
      this.events.push(event);
    }
  }

  #notify(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter();
    }
  }
}

// Incremental HTTP/1.1 response parser: the status line and headers, then
// the body, de-chunked when Transfer-Encoding is chunked.
class ResponseParser {
  status = 0;
  headers = new Headers();
  body: Buffer = Buffer.alloc(0);
  #buf: Buffer = Buffer.alloc(0);
  #inBody = false;
  #chunked = false;

  push(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    if (!this.#inBody) {
      const end = this.#buf.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      const head = this.#buf.subarray(0, end).toString("latin1").split("\r\n");
      this.status = Number((head[0] ?? "").split(" ")[1]);
      for (const line of head.slice(1)) {
        const colon = line.indexOf(":");
        this.headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      this.#chunked = (this.headers.get("transfer-encoding") ?? "").toLowerCase() === "chunked";
      this.#inBody = true;
      this.#buf = this.#buf.subarray(end + 4);
    }
    if (!this.#chunked) {
      this.body = Buffer.concat([this.body, this.#buf]);
      this.#buf = Buffer.alloc(0);
      return;
    }
    for (;;) {
      const lineEnd = this.#buf.indexOf("\r\n");
      if (lineEnd === -1) {
        return;
      }
      const size = parseInt(this.#buf.subarray(0, lineEnd).toString("latin1"), 16);
      if (Number.isNaN(size) || this.#buf.length < lineEnd + 2 + size + 2) {
        return;
      }
      this.body = Buffer.concat([this.body, this.#buf.subarray(lineEnd + 2, lineEnd + 2 + size)]);
      this.#buf = this.#buf.subarray(lineEnd + 2 + size + 2);
      if (size === 0) {
        return;
      }
    }
  }

  // the body bytes received since the last call
  takeBody(): Buffer {
    const out = this.body;
    this.body = Buffer.alloc(0);
    return out;
  }
}

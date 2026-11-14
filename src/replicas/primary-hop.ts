// Read-only replicas (D42): one request handed to the primary over its Unix socket.
//
// A replica answers the read routes itself and hands every other request to the
// primary. This module is that hand-off. It writes the request's line, headers and body
// to a pooled HTTP/1.1 connection on the primary's socket and turns the response head
// and body into a Response. It parses the response only as far as its framing (length,
// chunked, or read to close), so the body is passed on without a second request being
// built: the earlier R.1 spike built a new fetch() per request, and that was the cost of
// a write through a replica (docs/perf/replicas-spike.md).
//
// Connections are pooled and reused for keep-alive. A connection that carries an
// exchange is not shared, so exchanges never interleave. Small response bodies are
// read whole and returned as a buffer; larger or unframed bodies stream, with the
// socket paused while the client has not read.

import type { Socket } from "bun";

// responses with a length up to this are read whole before the Response is built
const SMALL_BODY = 256 * 1024;
// the response head (status line and headers) must fit in this
const HEAD_LIMIT = 64 * 1024;
// an idle connection is closed before the primary's own keep-alive timeout (10 s by default)
const IDLE_MS = 4_000;
const IDLE_MAX = 64;

// headers that describe one connection, not the message, and are never forwarded
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
]);

export interface PrimaryHop {
  // sends the request to the primary and resolves with its response; rejects when the
  // primary cannot be reached or the exchange breaks before the response head
  send(request: Request): Promise<Response>;
  // closes every idle connection; a connection in use is closed when its exchange ends
  close(): void;
}

type Framing = "none" | "length" | "chunked" | "close";
type Phase = "head" | "buffer" | "stream" | "done";
type ChunkState = "size" | "data" | "crlf" | "trailer";

interface Exchange {
  phase: Phase;
  method: string;
  framing: Framing;
  reusable: boolean;
  // head bytes received so far (until the blank line)
  head: Buffer | undefined;
  // length framing: bytes still expected
  remaining: number;
  // chunked framing
  chunkState: ChunkState;
  chunkRemaining: number;
  // undecoded bytes that do not yet form a complete chunk line
  pending: Buffer | undefined;
  // a whole small body, collected before the Response is built
  collected: Buffer[];
  collectedLength: number;
  status: number;
  statusText: string;
  headers: Headers;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface Conn {
  sock: Socket<Conn> | undefined;
  closed: boolean;
  ex: Exchange | undefined;
  // resolves a write that waited for the socket to drain
  drain: (() => void) | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

export function newPrimaryHop(socketPath: string): PrimaryHop {
  const idle: Conn[] = [];

  const removeIdle = (conn: Conn): void => {
    const i = idle.indexOf(conn);
    if (i >= 0) {
      idle.splice(i, 1);
    }
    if (conn.idleTimer !== undefined) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = undefined;
    }
  };

  const destroy = (conn: Conn): void => {
    if (conn.closed) {
      return;
    }
    conn.closed = true;
    removeIdle(conn);
    conn.sock?.terminate();
    // a write that waits for the socket must not wait for a drain that never comes
    const d = conn.drain;
    conn.drain = undefined;
    d?.();
  };

  const release = (conn: Conn): void => {
    conn.ex = undefined;
    if (conn.closed) {
      return;
    }
    conn.sock?.resume();
    if (idle.length >= IDLE_MAX) {
      destroy(conn);
      return;
    }
    idle.push(conn);
    conn.idleTimer = setTimeout(() => destroy(conn), IDLE_MS);
    conn.idleTimer.unref?.();
  };

  // ends the exchange: the body is complete (or it failed), and the connection is reused
  // only when both sides agree it can be
  const finish = (conn: Conn, ex: Exchange, reusable: boolean): void => {
    ex.phase = "done";
    if (ex.signal !== undefined && ex.onAbort !== undefined) {
      ex.signal.removeEventListener("abort", ex.onAbort);
    }
    try {
      ex.controller?.close();
    } catch {
      // the client cancelled the body; nothing to close
    }
    if (reusable && ex.reusable) {
      release(conn);
    } else {
      destroy(conn);
    }
  };

  const fail = (conn: Conn, ex: Exchange, err: Error): void => {
    if (ex.phase === "head" || ex.phase === "buffer") {
      ex.phase = "done";
      ex.reject(err);
    } else if (ex.phase === "stream") {
      ex.phase = "done";
      try {
        ex.controller?.error(err);
      } catch {
        // already closed by the client
      }
    }
    conn.ex = undefined;
    destroy(conn);
  };

  const sockHandlers = {
    open() {},
    data(sock: Socket<Conn>, chunk: Buffer) {
      onData(sock.data, chunk);
    },
    drain(sock: Socket<Conn>) {
      const d = sock.data.drain;
      sock.data.drain = undefined;
      d?.();
    },
    close(sock: Socket<Conn>) {
      onClosed(sock.data, new Error("primary closed the connection"));
    },
    error(sock: Socket<Conn>, err: Error) {
      onClosed(sock.data, err);
    },
  };

  const onClosed = (conn: Conn, err: Error): void => {
    if (conn.closed) {
      return;
    }
    conn.closed = true;
    removeIdle(conn);
    const d = conn.drain;
    conn.drain = undefined;
    d?.();
    const ex = conn.ex;
    conn.ex = undefined;
    if (ex === undefined || ex.phase === "done") {
      return;
    }
    if (ex.framing === "close" && ex.phase === "stream") {
      // a body that ends with the connection is complete
      ex.phase = "done";
      try {
        ex.controller?.close();
      } catch {
        // the client cancelled the body
      }
      return;
    }
    fail(conn, ex, err);
  };

  const onHead = (conn: Conn, ex: Exchange, bytes: Buffer): Buffer | undefined => {
    const all = ex.head === undefined ? bytes : Buffer.concat([ex.head, bytes]);
    const end = all.indexOf("\r\n\r\n");
    if (end < 0) {
      if (all.length > HEAD_LIMIT) {
        throw new Error("primary response head too large");
      }
      ex.head = all;
      return undefined;
    }
    ex.head = undefined;
    parseHead(ex, all.subarray(0, end).toString("utf8"));
    return all.subarray(end + 4);
  };

  const parseHead = (ex: Exchange, text: string): void => {
    const lines = text.split("\r\n");
    const status = /^HTTP\/1\.([01]) (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
    if (status === null) {
      throw new Error("primary sent a malformed status line");
    }
    ex.status = Number(status[2]);
    ex.statusText = status[3] ?? "";
    const headers = new Headers();
    let connection = "";
    let chunked = false;
    let length: number | undefined;
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) {
        throw new Error("primary sent a malformed header");
      }
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "transfer-encoding") {
        chunked = /(^|,)\s*chunked\s*$/i.test(value);
      } else if (name === "content-length") {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0) {
          throw new Error("primary sent a malformed content-length");
        }
        length = n;
      } else if (name === "connection") {
        connection = value.toLowerCase();
      }
      if (!HOP_BY_HOP.has(name)) {
        headers.append(name, value);
      }
    }
    ex.headers = headers;
    const noBody = ex.method === "HEAD" || ex.status < 200 || ex.status === 204 || ex.status === 304;
    if (noBody) {
      ex.framing = "none";
    } else if (chunked) {
      ex.framing = "chunked";
    } else if (length !== undefined) {
      ex.framing = "length";
      ex.remaining = length;
    } else {
      ex.framing = "close";
    }
    const version1_0 = status[1] === "0";
    ex.reusable =
      ex.framing !== "close" &&
      (version1_0 ? connection.includes("keep-alive") : !connection.includes("close"));
  };

  const build = (ex: Exchange, body: ReadableStream<Uint8Array> | Uint8Array | null): Response =>
    new Response(body, { status: ex.status, statusText: ex.statusText, headers: ex.headers });

  // the response is handed to the caller: at once for a stream, after its last byte for a
  // small body
  const startStream = (conn: Conn, ex: Exchange): void => {
    ex.phase = "stream";
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          ex.controller = controller;
        },
        pull() {
          if (!conn.closed && conn.ex === ex) {
            conn.sock?.resume();
          }
        },
        cancel() {
          if (ex.phase !== "done") {
            ex.phase = "done";
            conn.ex = undefined;
            destroy(conn);
          }
        },
      },
      { highWaterMark: 0 },
    );
    ex.resolve(build(ex, stream));
  };

  const emit = (conn: Conn, ex: Exchange, bytes: Buffer): void => {
    if (bytes.length === 0) {
      return;
    }
    if (ex.phase === "buffer") {
      ex.collected.push(Buffer.from(bytes));
      ex.collectedLength += bytes.length;
      return;
    }
    const controller = ex.controller;
    if (controller === undefined) {
      return;
    }
    controller.enqueue(new Uint8Array(bytes));
    if (controller.desiredSize !== null && controller.desiredSize <= 0) {
      conn.sock?.pause();
    }
  };

  // the body's bytes, by framing; returns when the exchange ends
  const feedBody = (conn: Conn, ex: Exchange, bytes: Buffer): void => {
    if (ex.framing === "none") {
      finish(conn, ex, true);
      return;
    }
    if (ex.framing === "close") {
      emit(conn, ex, bytes);
      return;
    }
    if (ex.framing === "length") {
      const n = Math.min(ex.remaining, bytes.length);
      emit(conn, ex, bytes.subarray(0, n));
      ex.remaining -= n;
      if (ex.remaining === 0) {
        completeBody(conn, ex);
      }
      return;
    }
    feedChunked(conn, ex, bytes);
  };

  const completeBody = (conn: Conn, ex: Exchange): void => {
    if (ex.phase === "buffer") {
      const body = Buffer.concat(ex.collected, ex.collectedLength);
      ex.collected = [];
      ex.phase = "done";
      ex.resolve(build(ex, body));
      conn.ex = undefined;
      if (ex.reusable) {
        release(conn);
      } else {
        destroy(conn);
      }
      return;
    }
    finish(conn, ex, true);
  };

  const feedChunked = (conn: Conn, ex: Exchange, bytes: Buffer): void => {
    const buf = ex.pending === undefined ? bytes : Buffer.concat([ex.pending, bytes]);
    ex.pending = undefined;
    let pos = 0;
    for (;;) {
      if (ex.chunkState === "size") {
        const eol = buf.indexOf("\r\n", pos);
        if (eol < 0) {
          break;
        }
        const size = Number.parseInt(buf.subarray(pos, eol).toString("latin1").split(";")[0]!, 16);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error("primary sent a malformed chunk size");
        }
        pos = eol + 2;
        if (size === 0) {
          ex.chunkState = "trailer";
        } else {
          ex.chunkRemaining = size;
          ex.chunkState = "data";
        }
      } else if (ex.chunkState === "data") {
        const n = Math.min(ex.chunkRemaining, buf.length - pos);
        emit(conn, ex, buf.subarray(pos, pos + n));
        pos += n;
        ex.chunkRemaining -= n;
        if (ex.chunkRemaining > 0) {
          break;
        }
        ex.chunkState = "crlf";
      } else if (ex.chunkState === "crlf") {
        if (buf.length - pos < 2) {
          break;
        }
        pos += 2;
        ex.chunkState = "size";
      } else {
        // the trailer ends at an empty line: CRLF at once, or a CRLF CRLF after fields
        if (buf.length - pos < 2) {
          break;
        }
        if (buf[pos] === 13 && buf[pos + 1] === 10) {
          pos += 2;
          completeBody(conn, ex);
          return;
        }
        const end = buf.indexOf("\r\n\r\n", pos);
        if (end < 0) {
          break;
        }
        pos = end + 4;
        completeBody(conn, ex);
        return;
      }
    }
    if (pos < buf.length && ex.phase !== "done") {
      ex.pending = Buffer.from(buf.subarray(pos));
    }
  };

  const onData = (conn: Conn, chunk: Buffer): void => {
    const ex = conn.ex;
    if (ex === undefined || ex.phase === "done") {
      // bytes on an idle connection: the primary closed it or broke framing
      destroy(conn);
      return;
    }
    const bytes = Buffer.from(chunk);
    try {
      if (ex.phase === "head") {
        const rest = onHead(conn, ex, bytes);
        if (rest === undefined) {
          return;
        }
        if (ex.framing === "none") {
          ex.resolve(build(ex, null));
          finish(conn, ex, true);
          return;
        }
        if (ex.framing === "length" && ex.remaining <= SMALL_BODY) {
          ex.phase = "buffer";
          ex.collected = [];
          ex.collectedLength = 0;
        } else {
          startStream(conn, ex);
        }
        if (rest.length > 0) {
          feedBody(conn, ex, Buffer.from(rest));
        } else if (ex.framing === "length" && ex.remaining === 0) {
          completeBody(conn, ex);
        }
        return;
      }
      feedBody(conn, ex, bytes);
    } catch (err) {
      fail(conn, ex, err instanceof Error ? err : new Error(String(err)));
    }
  };

  const open = async (): Promise<Conn> => {
    const conn: Conn = { sock: undefined, closed: false, ex: undefined, drain: undefined, idleTimer: undefined };
    conn.sock = await Bun.connect({ unix: socketPath, socket: sockHandlers, data: conn });
    return conn;
  };

  const acquire = async (): Promise<Conn> => {
    for (;;) {
      const conn = idle.pop();
      if (conn === undefined) {
        return open();
      }
      removeIdle(conn);
      if (!conn.closed) {
        return conn;
      }
    }
  };

  // writes bytes, waiting for the socket when the kernel does not take them all
  const write = async (conn: Conn, bytes: Uint8Array): Promise<void> => {
    if (conn.closed || conn.sock === undefined) {
      throw new Error("primary connection closed");
    }
    const n = conn.sock.write(bytes);
    if (n < bytes.byteLength) {
      await new Promise<void>((resolve) => {
        conn.drain = resolve;
      });
    }
  };

  // the request head: the request line and the forwarded headers, ending with the blank line
  const requestHead = (request: Request, url: URL, chunked: boolean, length: string | null): Buffer => {
    const lines = [`${request.method} ${url.pathname}${url.search} HTTP/1.1`, "Host: primary"];
    for (const [name, value] of request.headers) {
      if (!HOP_BY_HOP.has(name) && name !== "content-length") {
        lines.push(`${name}: ${value}`);
      }
    }
    if (chunked) {
      lines.push("Transfer-Encoding: chunked");
    } else if (length !== null) {
      lines.push(`Content-Length: ${length}`);
    } else if (request.method !== "GET" && request.method !== "HEAD") {
      lines.push("Content-Length: 0");
    }
    return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8");
  };

  const sendBody = async (conn: Conn, request: Request, head: Buffer, chunked: boolean, length: string | null): Promise<void> => {
    const body = request.body;
    if (body === null) {
      await write(conn, head);
      return;
    }
    if (!chunked && length !== null && Number(length) <= SMALL_BODY) {
      const whole = new Uint8Array(await request.arrayBuffer());
      await write(conn, Buffer.concat([head, whole]));
      return;
    }
    await write(conn, head);
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.byteLength === 0) {
        continue;
      }
      if (chunked) {
        await write(conn, Buffer.from(`${value.byteLength.toString(16)}\r\n`));
        await write(conn, value);
        await write(conn, Buffer.from("\r\n"));
      } else {
        await write(conn, value);
      }
    }
    if (chunked) {
      await write(conn, Buffer.from("0\r\n\r\n"));
    }
  };

  return {
    async send(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const hasBody = request.body !== null;
      const length = request.headers.get("content-length");
      const chunked = hasBody && length === null;
      const conn = await acquire();
      const head = requestHead(request, url, chunked, length);
      return new Promise<Response>((resolve, reject) => {
        const ex: Exchange = {
          phase: "head",
          method: request.method,
          framing: "none",
          reusable: false,
          head: undefined,
          remaining: 0,
          chunkState: "size",
          chunkRemaining: 0,
          pending: undefined,
          collected: [],
          collectedLength: 0,
          status: 0,
          statusText: "",
          headers: new Headers(),
          resolve,
          reject,
          controller: undefined,
          signal: request.signal,
          onAbort: undefined,
        };
        conn.ex = ex;
        const onAbort = (): void => {
          if (ex.phase === "done") {
            return;
          }
          fail(conn, ex, new Error("client went away"));
        };
        ex.onAbort = onAbort;
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        request.signal.addEventListener("abort", onAbort, { once: true });
        sendBody(conn, request, head, chunked, length).catch((err: unknown) => {
          fail(conn, ex, err instanceof Error ? err : new Error(String(err)));
        });
      });
    },
    close(): void {
      for (const conn of [...idle]) {
        destroy(conn);
      }
    },
  };
}

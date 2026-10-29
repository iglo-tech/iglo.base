// Sends a records-write case with a chunked body (Transfer-Encoding:
// chunked, no Content-Length) over a plain TCP socket. The body is a list
// of [text, count] pieces, each text repeated count times, written in
// 64 KiB chunks as the socket drains, so a body above the 32 MiB limit is
// never held in memory. Writing stops once the server answers or closes
// the connection (a server may answer before reading the whole body), and
// the response ends at its framing. The connection is not marked
// `Connection: close`: Bun.serve then closes it right after answering,
// with body bytes unread, and the reset can drop the response before the
// client reads it (Go's server lingers before closing).

import { connect } from "node:net";

import type { ScenarioResponse } from "@test/scenarios/request";

export type ChunkedBody = [text: string, count: number][];

const chunkSize = 64 * 1024;

// the body's bytes in chunks of chunkSize
function* chunks(body: ChunkedBody): Generator<Buffer> {
  let pending: Buffer[] = [];
  let pendingLength = 0;
  for (const [text, count] of body) {
    const piece = Buffer.from(text);
    // repeat small texts in blocks instead of one by one
    const perBlock = Math.max(1, Math.floor(chunkSize / Math.max(1, piece.length)));
    for (let left = count; left > 0;) {
      const n = Math.min(left, perBlock);
      left -= n;
      pending.push(n === 1 ? piece : Buffer.from(text.repeat(n)));
      pendingLength += piece.length * n;
      if (pendingLength >= chunkSize) {
        const all = Buffer.concat(pending);
        let offset = 0;
        for (; all.length - offset >= chunkSize; offset += chunkSize) {
          yield all.subarray(offset, offset + chunkSize);
        }
        pending = [all.subarray(offset)];
        pendingLength = all.length - offset;
      }
    }
  }
  if (pendingLength > 0) {
    yield Buffer.concat(pending);
  }
}

export function sendChunked(
  baseUrl: string,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: ChunkedBody,
): Promise<ScenarioResponse> {
  const { hostname, port } = new URL(baseUrl);
  const head = [`${method} ${url} HTTP/1.1`, "Host: example.com", "Transfer-Encoding: chunked"];
  const all = new Map<string, [string, string]>();
  all.set("content-type", ["content-type", "application/json"]);
  for (const [name, value] of Object.entries(headers)) {
    all.set(name.toLowerCase(), [name, value]);
  }
  for (const [name, value] of all.values()) {
    head.push(`${name}: ${value}`);
  }

  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) });
    const received: Buffer[] = [];
    let answered = false;
    const timer = setTimeout(
      () => socket.destroy(new Error(`${method} ${url}: timed out`)),
      120_000,
    );

    // resolves once data is written or buffered below the high-water mark,
    // or once writing has to stop
    const writeChunk = (data: Buffer | string) =>
      new Promise<void>((done) => {
        if (answered || socket.destroyed || socket.write(data)) {
          done();
          return;
        }
        const finish = () => {
          socket.off("drain", finish);
          socket.off("close", finish);
          done();
        };
        socket.on("drain", finish);
        socket.on("close", finish);
      });

    const write = async () => {
      await writeChunk(`${head.join("\r\n")}\r\n\r\n`);
      for (const chunk of chunks(body)) {
        if (answered || socket.destroyed) {
          return;
        }
        await writeChunk(`${chunk.length.toString(16)}\r\n`);
        await writeChunk(chunk);
        await writeChunk("\r\n");
      }
      await writeChunk("0\r\n\r\n");
    };

    socket.on("connect", () => void write());
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      const raw = Buffer.concat(received);
      const parsed = parseResponse(raw);
      if (!parsed && !socket.destroyed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (parsed) {
        resolve(parsed);
      } else {
        reject(new Error(`${method} ${url}: incomplete response:\n${raw.toString("latin1")}`));
      }
    };
    socket.on("data", (chunk: Buffer) => {
      answered = true;
      received.push(chunk);
      // the response may be complete before the body was sent
      settle();
    });
    // a write after the server closed its side fails; the response read
    // so far decides
    socket.on("error", () => {});
    socket.on("close", settle);
  });
}

function parseResponse(raw: Buffer): ScenarioResponse | undefined {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) {
    return undefined;
  }
  const [statusLine = "", ...headerLines] = raw.subarray(0, split).toString("latin1").split("\r\n");
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  let rest = raw.subarray(split + 4);
  if (headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
    const parts: Buffer[] = [];
    let pos = 0;
    for (;;) {
      const lineEnd = rest.indexOf("\r\n", pos);
      if (lineEnd < 0) {
        return undefined;
      }
      const size = Number.parseInt(rest.subarray(pos, lineEnd).toString("latin1"), 16);
      if (size === 0) {
        break;
      }
      parts.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
      pos = lineEnd + 2 + size + 2;
    }
    rest = Buffer.concat(parts);
  } else {
    const length = headers.get("content-length");
    if (length !== null) {
      if (rest.length < Number(length)) {
        return undefined;
      }
      rest = rest.subarray(0, Number(length));
    }
  }
  return { status: Number(statusLine.split(" ")[1]), headers, body: new Uint8Array(rest) };
}

// Sends one HTTP/1.1 request over a plain TCP socket with the request target
// exactly as given. fetch() would normalize paths like "/a/../b" or "//b"
// before sending them.

import { connect } from "node:net";

export interface RawResponse {
  status: number;
  headers: Headers;
  body: string;
}

export function rawRequest(
  baseUrl: string,
  method: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  const { hostname, port } = new URL(baseUrl);
  const lines = [`${method} ${target} HTTP/1.1`, `Host: ${hostname}:${port}`, "Connection: close"];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`${k}: ${v}`);
  }
  const head = `${lines.join("\r\n")}\r\n\r\n`;

  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) });
    const chunks: Buffer[] = [];
    socket.setTimeout(10_000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("connect", () => socket.write(head));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(parseResponse(Buffer.concat(chunks).toString("latin1"), method));
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

function parseResponse(raw: string, method: string): RawResponse {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) {
    throw new Error(`incomplete response: ${JSON.stringify(raw)}`);
  }
  const [statusLine = "", ...headerLines] = raw.slice(0, split).split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  let body = raw.slice(split + 4);
  if (method === "HEAD") {
    body = "";
  } else if (headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
    body = decodeChunked(body);
  }
  return { status, headers, body: Buffer.from(body, "latin1").toString("utf8") };
}

function decodeChunked(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (!size) {
      return out;
    }
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

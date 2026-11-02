// Two servers for the serve-time differential tests (M5.7): upstream
// PocketBase v0.41.0 and the compiled iglo.base executable, each on its own
// copy of the (optionally prepared) vendored fixture, started with the same
// extra `serve` arguments. Requests go over raw sockets (the target is sent
// as written) and the responses are compared whole: status, every header
// but Date and Connection (Go repeats a request's "Connection: close"), and
// the body bytes.

import { rmSync } from "node:fs";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { startServer, tempDir, type RunningServer } from "@test/support/executable";
import { rawRequest, type RawResponse } from "@test/support/raw-http";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

export interface Pair {
  upstream: UpstreamServer;
  igloBase: RunningServer;
  root: string;
  stop(): Promise<void>;
}

export async function startPair(
  options: { args?: string[]; prepare?: (dataDir: string) => void } = {},
): Promise<Pair> {
  const root = tempDir();
  const prepared = join(root, "pb_data");
  copyDataDir(fixtureDir, prepared);
  options.prepare?.(prepared);
  const upstreamDir = join(root, "upstream", "pb_data");
  const igloBaseDir = join(root, "iglo-base", "pb_data");
  copyDataDir(prepared, upstreamDir);
  copyDataDir(prepared, igloBaseDir);

  const started = await Promise.allSettled([
    startUpstream({ dataDir: upstreamDir, args: options.args ?? [] }),
    startServer(options.args ?? [], igloBaseDir),
  ]);
  const [up, ig] = started;
  if (up.status === "rejected" || ig.status === "rejected") {
    await Promise.allSettled(started.map((s) => s.status === "fulfilled" && s.value.stop()));
    rmSync(root, { recursive: true, force: true });
    throw up.status === "rejected" ? up.reason : (ig as PromiseRejectedResult).reason;
  }
  return {
    upstream: up.value,
    igloBase: ig.value,
    root,
    async stop() {
      await Promise.allSettled([up.value.stop(), ig.value.stop()]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const ignoredHeaders = new Set(["date", "connection"]);

// a multipart/byteranges boundary is random
function normalize(text: string, boundary: string | undefined): string {
  return boundary ? text.replaceAll(boundary, "<boundary>") : text;
}

export interface Shown {
  status: number;
  headers: string[];
  body: string;
}

export function show(res: RawResponse, omit: string[] = []): Shown {
  const boundary = /boundary=([0-9a-f]+)/.exec(res.headers.get("content-type") ?? "")?.[1];
  const headers: string[] = [];
  res.headers.forEach((value, name) => {
    if (!ignoredHeaders.has(name) && !omit.includes(name)) {
      headers.push(`${name}: ${normalize(value, boundary)}`);
    }
  });
  headers.sort();
  return { status: res.status, headers, body: normalize(res.body, boundary) };
}

// the same request to both servers; resolves with both responses shown
export async function both(
  pair: Pair,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  omit: string[] = [],
): Promise<{ upstream: Shown; igloBase: Shown }> {
  const [up, ig] = await Promise.all([
    rawRequest(pair.upstream.url, method, target, headers),
    rawRequest(pair.igloBase.url, method, target, headers),
  ]);
  return { upstream: show(up, omit), igloBase: show(ig, omit) };
}

// Runs the two servers' `migrate` commands and servers on separate sites and
// normalizes what differs by nature. Not part of `bun test`: run
// `bun run test:reference`.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executable, startServer } from "@test/support/executable";
import { defaultLayout, requireTool } from "@test/support/reference-tools";
import { startUpstream } from "@test/support/upstream";

export type Kind = "upstream" | "iglo.base";
export const kinds: readonly Kind[] = ["upstream", "iglo.base"];

export interface Site {
  kind: Kind;
  root: string;
  dataDir: string;
  migrationsDir: string;
}

export function newSite(kind: Kind, parent?: string): Site {
  const root = mkdtempSync(join(parent ?? tmpdir(), "iglo-base-migrations-"));
  return {
    kind,
    root,
    dataDir: join(root, "pb_data"),
    migrationsDir: join(root, "pb_migrations"),
  };
}

export async function binaryOf(kind: Kind): Promise<string> {
  return kind === "upstream" ? requireTool("pocketbase", defaultLayout) : executable();
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Runs the binary in the site's root, with stdin given or closed.
export async function runIn(site: Site, args: string[], stdin?: string): Promise<RunResult> {
  const proc = Bun.spawn([await binaryOf(site.kind), ...args, "--dir", site.dataDir], {
    cwd: site.root,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function writeMigrations(site: Site, files: Record<string, string>): void {
  mkdirSync(site.migrationsDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(site.migrationsDir, name), text);
  }
}

export function readMigrations(site: Site): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(site.migrationsDir).toSorted()) {
    files[name] = readFileSync(join(site.migrationsDir, name), "utf8");
  }
  return files;
}

// What differs by nature: the log time, the site's path, a file's unix time,
// and in an error goja's script position.
export function normalizeOutput(text: string, site: Site): string {
  return text
    .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /gm, "")
    .replaceAll(site.root, "ROOT")
    .replace(/\d{10}_/g, "TIME_")
    .replace(/ at [^ ]*pb\.js:\d+:\d+(\(\d+\))?/g, "");
}

export const superuser = { identity: "admin@example.com", password: "1234567890" };

export interface Server {
  url: string;
  token: string;
  stop(): Promise<unknown>;
}

// Starts the site's server with automigrate on, with a superuser.
export async function serveSite(site: Site, args: string[] = []): Promise<Server> {
  const upsert = await runIn(site, ["superuser", "upsert", superuser.identity, superuser.password]);
  if (upsert.exitCode !== 0) {
    throw new Error(`superuser upsert failed: ${upsert.stderr}`);
  }

  const serverArgs = ["--automigrate=true", "--migrationsDir", site.migrationsDir, ...args];
  const server =
    site.kind === "upstream"
      ? await startUpstream({ dataDir: site.dataDir, args: serverArgs })
      : await startServer(serverArgs, site.dataDir);

  const res = await fetch(`${server.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(superuser),
  });
  const { token } = (await res.json()) as { token: string };
  return { url: server.url, token, stop: () => server.stop() };
}

export async function api(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: server.token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

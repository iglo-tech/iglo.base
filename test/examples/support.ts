// Helpers for test/examples: an example app's production build and server process, a cookie jar
// for a browser that follows the app's responses, and the requests the scenarios make. The
// apps talk to iglo.base or upstream PocketBase v0.41.0 only over HTTP (docs/design/13-ssr.md).

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { freePort } from "@test/support/executable";

export const repoRoot = resolve(import.meta.dir, "../..");

export interface ExampleApp {
  /** The directory under examples/. */
  name: string;
  dir: string;
}

export const EXAMPLE_APPS: readonly ExampleApp[] = [
  { name: "nextjs", dir: join(repoRoot, "examples/nextjs") },
  { name: "sveltekit", dir: join(repoRoot, "examples/sveltekit") },
];

/** Runs a command in dir and fails with its output when it exits non-zero. */
export async function run(cmd: string[], dir: string, timeoutMs = 900_000): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} in ${dir} failed (${code}):\n${out}\n${err}`);
  }
}

/** Installs the example's dependencies from its lockfile and builds it for production. */
export async function installAndBuild(app: ExampleApp): Promise<void> {
  if (!existsSync(join(app.dir, "package.json"))) {
    throw new Error(`${app.dir} has no package.json`);
  }
  await run(["bun", "install", "--frozen-lockfile"], app.dir);
  await run(["bun", "run", "build"], app.dir);
}

/** Every descendant of pid, deepest first, so that children die before their parent. */
function descendants(pid: number): number[] {
  const out = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const children = out.stdout
    .toString()
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return children.flatMap((child) => [...descendants(child), child]);
}

/** Stops a process and every process it started (`bun run start` starts the framework server). */
export async function killTree(proc: Bun.Subprocess): Promise<void> {
  const pids = [...descendants(proc.pid), proc.pid];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.race([proc.exited, Bun.sleep(5_000)]);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export interface RunningApp {
  /** The app's origin as the browser sees it (`http://127.0.0.1:<port>`). */
  url: string;
  /** Its standard output and error so far. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * Starts the app's production server (`bun run start`, which honors PORT and HOST) with the
 * given environment and waits until it answers.
 */
export async function startApp(app: ExampleApp, env: Record<string, string>): Promise<RunningApp> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "run", "start"], {
    cwd: app.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      HOST: "127.0.0.1",
      // the public origin (APP_ORIGIN for the apps; ORIGIN for adapter-node)
      APP_ORIGIN: url,
      ORIGIN: url,
      NO_COLOR: "1",
    },
  });
  // the app's output so far, kept for the failure messages of the scenarios
  let log = "";
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      log += decoder.decode(chunk, { stream: true });
    }
  };
  const pumped = Promise.all([pump(proc.stdout), pump(proc.stderr)]);

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      await pumped;
      throw new Error(`${app.name} exited while starting:\n${log}`);
    }
    try {
      await fetch(`${url}/`, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      break;
    } catch {
      if (Date.now() > deadline) {
        await killTree(proc);
        throw new Error(`${app.name} did not answer on ${url} within 60 s`);
      }
      await Bun.sleep(200);
    }
  }
  return {
    url,
    output: () => log,
    stop: () => killTree(proc),
  };
}

/** A browser's cookies for one origin: the Set-Cookie headers an app sent, sent back on each request. */
export class CookieJar {
  readonly cookies = new Map<string, string>();

  /** Applies the Set-Cookie headers of a response: a cookie with Max-Age=0 is removed. */
  store(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      if (/Max-Age=0(?:;|$)/i.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, pair.slice(eq + 1));
      }
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export interface Exchange {
  status: number;
  location: string | null;
  body: string;
  headers: Headers;
  /** The Set-Cookie headers of this response (the whole lines). */
  setCookies: string[];
}

/**
 * One request with the jar's cookies (when a jar is given). Redirects are not followed; the
 * jar keeps what the response set.
 */
export async function exchange(
  url: string,
  init: RequestInit & { jar?: CookieJar } = {},
): Promise<Exchange> {
  const { jar, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (jar && jar.cookies.size > 0) {
    headers.set("cookie", jar.header());
  }
  const response = await fetch(url, { ...rest, headers, redirect: "manual" });
  jar?.store(response);
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.text(),
    headers: response.headers,
    setCookies: response.headers.getSetCookie(),
  };
}

/** The cookie line for `name` among the Set-Cookie lines, if the response set one. */
export function setCookieLine(setCookies: string[], name: string): string | undefined {
  return setCookies.find((line) => line.startsWith(`${name}=`));
}

/** Formats a form body the way the browser sends a POST form. */
export function formBody(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

/** The app's origin header for same-site POSTs (the browser sends it on a form submit). */
export function sameOrigin(app: string): Record<string, string> {
  return { Origin: app };
}

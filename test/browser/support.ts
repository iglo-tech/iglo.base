// Browser tests drive the vendored dashboard with the agent-browser CLI
// (a host tool, not a dependency) against the compiled executable. See
// docs/design/08-admin-ui.md#verification.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startServer, tempDir, type RunningServer } from "@test/support/executable";

export const password = "1234567890";

// Fails with a readable message when the host has no agent-browser.
export function requireAgentBrowser(): string {
  const path = Bun.which("agent-browser");
  if (path === null) {
    throw new Error(
      "agent-browser is not installed or not on PATH. `bun run test:browser` drives the dashboard with it (npm i -g agent-browser && agent-browser install).",
    );
  }
  return path;
}

let sessionCounter = 0;

// One named agent-browser session: its own browser, closed by close().
export class Browser {
  readonly session = `iglo-browser-${process.pid}-${Date.now()}-${sessionCounter++}`;
  private readonly binary = requireAgentBrowser();

  async run(...args: string[]): Promise<string> {
    const proc = Bun.spawn([this.binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_BROWSER_SESSION: this.session },
      timeout: 60_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`agent-browser ${args.join(" ")} failed (${code}):\n${stdout}\n${stderr}`);
    }
    return stdout;
  }

  open(url: string): Promise<string> {
    return this.run("open", url);
  }

  // waits for text anywhere on the page
  waitForText(text: string): Promise<string> {
    return this.run("wait", "--text", text);
  }

  waitForUrl(glob: string): Promise<string> {
    return this.run("wait", "--url", glob);
  }

  // the text of the page body
  async bodyText(): Promise<string> {
    const out = await this.run("eval", "document.body.innerText");
    return JSON.parse(out) as string;
  }

  // the accessibility snapshot of interactive elements (and dialogs)
  snapshot(): Promise<string> {
    return this.run("snapshot", "-i");
  }

  // the ref of the first snapshot line `<role> "<name>"` whose name matches
  // exactly (the name may carry a trailing space the dashboard adds for icons)
  async ref(role: string, name: string): Promise<string> {
    const lines = (await this.snapshot()).split("\n");
    for (const line of lines) {
      const m = /^\s*- (\S+) "(.*?)"(?: \[[^\]]*?)?ref=(e\d+)/.exec(line);
      if (m && m[1] === role && m[2]?.trim() === name) {
        return `@${m[3]}`;
      }
    }
    throw new Error(`no ${role} "${name}" in the snapshot:\n${lines.join("\n")}`);
  }

  async click(role: string, name: string): Promise<void> {
    await this.run("click", await this.ref(role, name));
  }

  async fill(role: string, name: string, value: string): Promise<void> {
    await this.run("fill", await this.ref(role, name), value);
  }

  async close(): Promise<void> {
    await this.run("close").catch(() => undefined);
  }
}

export interface Fixture {
  server: RunningServer;
  dataDir: string;
  // an API call as the first superuser
  api(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

// A server on a fresh data directory and a free port, with a superuser
// created through the installer's own API when install is false.
export async function startFixture(): Promise<Fixture> {
  const root = tempDir();
  const dataDir = join(root, "pb_data");
  mkdirSync(dataDir, { recursive: true });
  const server = await startServer([], dataDir);
  let token = "";
  return {
    server,
    dataDir,
    async api(path, init = {}) {
      if (token === "") {
        const res = await fetch(`${server.url}/api/collections/_superusers/auth-with-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identity: "admin@example.com", password }),
        });
        token = ((await res.json()) as { token: string }).token;
      }
      return fetch(`${server.url}${path}`, {
        ...init,
        headers: { Authorization: token, ...init.headers },
      });
    },
    async stop() {
      await server.stop();
    },
  };
}

// The installer link printed at start.
export async function installerLink(server: RunningServer): Promise<string> {
  const output = await server.waitForOutput("superuser upsert EMAIL PASS)");
  const m = /(http:\/\/127\.0\.0\.1:\d+\/_\/#\/pbinstall\/\S+)/.exec(output);
  if (!m?.[1]) {
    throw new Error(`no installer link in:\n${output}`);
  }
  return m[1];
}

// Creates the first superuser the way the installer page does and signs the
// browser in through the login form.
export async function installAndLogin(fx: Fixture, browser: Browser): Promise<void> {
  const link = await installerLink(fx.server);
  const create = await fetch(`${fx.server.url}/api/collections/_superusers/records`, {
    method: "POST",
    headers: {
      Authorization: link.split("/pbinstall/")[1] ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "admin@example.com",
      password,
      passwordConfirm: password,
    }),
  });
  if (create.status !== 200) {
    throw new Error(`superuser create failed: ${create.status} ${await create.text()}`);
  }
  await browser.open(`${fx.server.url}/_/#/login`);
  await browser.waitForText("Superuser login");
  await browser.fill("textbox", "Email *", "admin@example.com");
  await browser.fill("textbox", "Password *", password);
  await browser.click("button", "Login");
  await browser.waitForUrl("**/collections*");
}

export function writeTempFile(name: string, content: string): string {
  const path = join(tempDir(), name);
  writeFileSync(path, content);
  return path;
}

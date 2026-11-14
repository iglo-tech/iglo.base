// OAuth2 providers in the schema file, with their secrets as environment
// references (D40, amended 2026-11-13; S.6), through the compiled executable.
// The sign-in runs against a fake provider that the test starts (no external
// services). The file, the pulled file, the plan and the logs never hold a
// secret value; a plain secret is refused; a missing variable fails with its
// name.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";

import { executable, run, startServer, tempDir, type RunResult } from "@test/support/executable";
import { sharedOAuth2Mock } from "@test/support/oauth2-mock";

const schemaJSON = JSON.parse(
  readFileSync(join(import.meta.dir, "../../schema/iglo.schema.json"), "utf8"),
) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schemaJSON);

const email = "providers@example.test";
const password = "1234567890";
const githubSecret = "gh-secret-from-the-dashboard";
const githubVariable = "USERS_GITHUB_CLIENT_SECRET";

interface Site {
  root: string;
  dataDir: string;
  schemaPath: string;
}

function newSite(): Site {
  const root = tempDir();
  return { root, dataDir: join(root, "pb_data"), schemaPath: join(root, "iglo.schema.json") };
}

// a fresh database whose users collection has a github provider, as the
// dashboard saves it (a fresh install has users)
async function createSiteWithProvider(): Promise<Site> {
  const site = newSite();
  const created = await run(["--dir", site.dataDir, "superuser", "upsert", email, password]);
  expect(created.exitCode).toBe(0);
  const server = await startServer([], site.dataDir);
  try {
    const token = await login(server.url);
    const patched = await api(server.url, token, "PATCH", "/api/collections/users", {
      oauth2: {
        enabled: true,
        providers: [{ name: "github", clientId: "gh-client", clientSecret: githubSecret }],
      },
    });
    expect(patched.status).toBe(200);
  } finally {
    await server.stop();
  }
  return site;
}

// the file the database pulls to: its providers are references
async function pulledFile(site: Site): Promise<string> {
  const pulled = await run(["--dir", site.dataDir, "schema", "pull"]);
  expect(pulled.exitCode).toBe(0);
  return pulled.stdout;
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function api(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

// the executable with extra environment variables, run to completion
async function runWithEnv(args: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn([await executable(), ...args], {
    cwd: tempDir(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", ...env },
    timeout: 20_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// the file's oauth2 providers, parsed
function providersOf(text: string): Record<string, unknown>[] {
  const file = JSON.parse(text) as {
    collections: Record<string, { oauth2?: { providers?: Record<string, unknown>[] } }>;
  };
  return file.collections.users?.oauth2?.providers ?? [];
}

const providerFile = (secretRef: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    collections: {
      users: {
        type: "auth",
        oauth2: {
          enabled: true,
          providers: [{ name: "github", clientId: "gh-client", clientSecret: secretRef, ...extra }],
        },
      },
    },
  });

describe("schema pull", () => {
  test("writes the provider with its secret as a reference, and never the value", async () => {
    const site = await createSiteWithProvider();
    const pulled = await run(["--dir", site.dataDir, "schema", "pull"]);
    expect(pulled.exitCode).toBe(0);
    expect(pulled.stdout).not.toContain(githubSecret);
    expect(pulled.stderr).not.toContain(githubSecret);
    expect(pulled.stderr).toContain(githubVariable);

    const file = JSON.parse(pulled.stdout) as unknown;
    expect(validate(file)).toBe(true);
    expect(providersOf(pulled.stdout)).toEqual([
      { name: "github", clientId: "gh-client", clientSecret: { env: githubVariable } },
    ]);
  });
});

describe("schema pull over a file", () => {
  test("keeps the references the file has, and generates the missing ones", async () => {
    const site = await createSiteWithProvider();
    writeFileSync(site.schemaPath, providerFile({ env: "MY_GITHUB_SECRET" }));
    const pulled = await run(["--dir", site.dataDir, "schema", "pull", "--out", site.schemaPath]);
    expect(pulled.exitCode).toBe(0);
    const written = readFileSync(site.schemaPath, "utf8");
    expect(written).not.toContain(githubSecret);
    expect(providersOf(written)).toEqual([
      { name: "github", clientId: "gh-client", clientSecret: { env: "MY_GITHUB_SECRET" } },
    ]);
    expect(pulled.stderr).toContain("MY_GITHUB_SECRET");
  });
});

describe("schema plan", () => {
  test("a variable that is not set fails the plan, and the message names it", async () => {
    const site = await createSiteWithProvider();
    const pulled = await run(["--dir", site.dataDir, "schema", "pull"]);
    writeFileSync(site.schemaPath, pulled.stdout);
    const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
    expect(plan.exitCode).toBe(1);
    expect(plan.stderr).toContain(githubVariable);
    expect(plan.stderr).toContain("not set");
    expect(plan.stdout + plan.stderr).not.toContain(githubSecret);
  });

  test("a secret that changed in the environment is reported by name, not by value", async () => {
    const site = await createSiteWithProvider();
    writeFileSync(site.schemaPath, await pulledFile(site));
    const plan = await runWithEnv(
      ["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath],
      { [githubVariable]: "rotated-secret" },
    );
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("provider github: clientSecret changed");
    expect(plan.stdout + plan.stderr).not.toContain("rotated-secret");
    expect(plan.stdout + plan.stderr).not.toContain(githubSecret);
  });

  test("the same secret is no change in the plan", async () => {
    const site = await createSiteWithProvider();
    writeFileSync(site.schemaPath, await pulledFile(site));
    const plan = await runWithEnv(
      ["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath],
      { [githubVariable]: githubSecret },
    );
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("collections: no changes");
  });

  test("a plain secret is refused", async () => {
    const site = await createSiteWithProvider();
    writeFileSync(site.schemaPath, providerFile("a-plain-secret"));
    const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
    expect(plan.exitCode).toBe(1);
    expect(plan.stderr).toContain("a plain secret is refused");
    expect(plan.stderr).toContain("providers[0].clientSecret");
    expect(plan.stderr).not.toContain("a-plain-secret");
  });

  test("a reference must name a variable: a plain value for a reference key is refused too", async () => {
    const site = await createSiteWithProvider();
    writeFileSync(site.schemaPath, providerFile({ env: "not a name" }));
    const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
    expect(plan.exitCode).toBe(1);
    expect(plan.stderr).toContain("environment variable name");
  });
});

describe("startup", () => {
  test("a missing variable fails the start with its name, and no value is printed", async () => {
    const site = await createSiteWithProvider();
    writeFileSync(site.schemaPath, providerFile({ env: githubVariable }));
    const started = await run([
      "--dir",
      site.dataDir,
      "serve",
      "--http",
      "127.0.0.1:1",
      "--schema",
      site.schemaPath,
    ]);
    expect(started.exitCode).toBe(1);
    expect(started.stderr).toContain(githubVariable);
    expect(started.stdout + started.stderr).not.toContain(githubSecret);
  });
});

describe("sign-in with a provider from references", () => {
  test("the provider signs in against a fake provider, with the secret from the environment", async () => {
    const mock = sharedOAuth2Mock().register({
      user: { id: 7, login: "octo", name: "Octo" },
      emails: [{ email: "octo@example.com", verified: true, primary: true }],
    });
    const site = newSite();
    const created = await run(["--dir", site.dataDir, "superuser", "upsert", email, password]);
    expect(created.exitCode).toBe(0);
    writeFileSync(
      site.schemaPath,
      JSON.stringify({
        collections: {
          users: {
            type: "auth",
            // the sign-in and its first sign-in (the record it creates) are open
            // to everyone: the file's default for an auth collection is
            // superusers only
            rules: { auth: "", create: "" },
            oauth2: {
              enabled: true,
              providers: [
                {
                  name: "github",
                  clientId: "mock-client",
                  clientSecret: { env: githubVariable },
                  authURL: mock.authURL,
                  tokenURL: mock.tokenURL,
                  userInfoURL: mock.userInfoURL,
                },
              ],
            },
          },
        },
      }),
    );

    const server = await startServer(
      ["--schema", site.schemaPath],
      site.dataDir,
      "127.0.0.1",
      undefined,
      {
        [githubVariable]: "mock-secret",
      },
    );
    try {
      const methods = await fetch(`${server.url}/api/collections/users/auth-methods`);
      const listed = ((await methods.json()) as { oauth2: { providers: { name: string }[] } })
        .oauth2.providers;
      expect(listed.map((p) => p.name)).toEqual(["github"]);

      const res = await fetch(`${server.url}/api/collections/users/auth-with-oauth2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          code: "123",
          codeVerifier: "456",
          redirectURL: "https://example.com",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; record: { email: string } };
      expect(body.token).not.toBe("");
      expect(body.record.email).toBe("octo@example.com");

      // the token exchange carried the secret from the environment
      const exchange = mock.requests.find((r) => r.path.includes("token") || r.method === "POST");
      expect(exchange).toBeDefined();
      const carried =
        (exchange?.body ?? "").includes("mock-secret") ||
        (exchange?.authorization ?? "").includes(
          Buffer.from("mock-client:mock-secret").toString("base64"),
        );
      expect(carried).toBe(true);
    } finally {
      const stopped = await server.stop();
      expect(stopped.stdout + stopped.stderr).not.toContain("mock-secret");
    }
  });
});

describe("development write-back", () => {
  test("a provider added in the dashboard is written with a generated reference, never its secret", async () => {
    const site = await createSiteWithProvider();
    const pulled = await run(["--dir", site.dataDir, "schema", "pull"]);
    writeFileSync(site.schemaPath, pulled.stdout);
    const server = await startServer(
      ["--schema", site.schemaPath],
      site.dataDir,
      "127.0.0.1",
      undefined,
      {
        [githubVariable]: githubSecret,
      },
    );
    try {
      const token = await login(server.url);
      const added = await api(server.url, token, "PATCH", "/api/collections/users", {
        oauth2: {
          enabled: true,
          providers: [
            { name: "github", clientId: "gh-client", clientSecret: githubSecret },
            { name: "google", clientId: "g-client", clientSecret: "google-dashboard-secret" },
          ],
        },
      });
      expect(added.status).toBe(200);

      const written = readFileSync(site.schemaPath, "utf8");
      expect(written).not.toContain("google-dashboard-secret");
      expect(providersOf(written)).toEqual([
        { name: "github", clientId: "gh-client", clientSecret: { env: githubVariable } },
        {
          name: "google",
          clientId: "g-client",
          clientSecret: { env: "USERS_GOOGLE_CLIENT_SECRET" },
        },
      ]);
      expect(validate(JSON.parse(written))).toBe(true);
    } finally {
      const stopped = await server.stop();
      expect(stopped.stderr).toContain("USERS_GOOGLE_CLIENT_SECRET");
      expect(stopped.stdout + stopped.stderr).not.toContain("google-dashboard-secret");
      expect(stopped.stderr).not.toContain("was not applied");
    }
  });
});

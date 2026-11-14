// TypeScript migrations when the server runs from source (`bun src/main.ts`),
// not only in the compiled executable. The other CLI tests run the executable;
// this one runs the source tree, through `schema plan` and `serve --schema`, on
// mktemp data. A migration that reads a file next to it through import.meta.dir
// must load and apply.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { freePort, releasePort } from "@test/support/executable";

const repoRoot = resolve(import.meta.dir, "../..");
const entry = join(repoRoot, "src/main.ts");
const email = "source@example.test";
const password = "1234567890";

let uiPacked: Promise<void> | undefined;

// src/main.ts embeds dist/ui.pack, so the source tree needs the dashboard pack
// (the same build the executable's test helper runs)
function ensureUiPack(): Promise<void> {
  uiPacked ??= (async () => {
    const proc = Bun.spawn([process.execPath, "scripts/ui/build.ts"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) !== 0) {
      throw new Error(`dashboard build failed:\n${await new Response(proc.stderr).text()}`);
    }
  })();
  return uiPacked;
}

// the source tree's `bun src/main.ts <args>`, run to completion
async function fromSource(args: string[]): Promise<{ exitCode: number; output: string }> {
  await ensureUiPack();
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "iglo-base-source-")),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 60_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

// a site: a data directory with a superuser (schema plan reads an existing
// database), a schema file with one collection, and a migrations directory whose
// migration reads a title from a file beside it
async function newSite(): Promise<{
  dataDir: string;
  schemaPath: string;
  migrationsDir: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-source-site-"));
  const dataDir = join(root, "pb_data");
  const created = await fromSource(["--dir", dataDir, "superuser", "upsert", email, password]);
  expect(created.exitCode).toBe(0);
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  const schemaPath = join(root, "iglo.schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      collections: {
        posts: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { title: { type: "text" } },
        },
      },
    }),
  );
  writeFileSync(join(migrationsDir, "title.txt"), "from source\n");
  writeFileSync(
    join(migrationsDir, "20261114120000_seed.ts"),
    [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "",
      "export default {",
      "  up(tx) {",
      '    const title = readFileSync(join(import.meta.dir, "title.txt"), "utf8").trim();',
      '    tx.create("posts", { title });',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  return { dataDir, schemaPath, migrationsDir };
}

describe("TypeScript migrations from source (S.6)", () => {
  test("schema plan from source loads the migration and lists it as one that would run", async () => {
    const site = await newSite();
    const plan = await fromSource([
      "--dir",
      site.dataDir,
      "schema",
      "plan",
      "--schema",
      site.schemaPath,
    ]);
    expect(plan.output).not.toContain("the default export must be an object");
    expect(plan.output).not.toContain("does not load");
    expect(plan.exitCode).toBe(0);
    expect(plan.output).toContain("migrations that would run:");
    expect(plan.output).toContain("20261114120000_seed.ts");
  });

  test("serve --schema from source applies the migration: a file read through import.meta.dir", async () => {
    const site = await newSite();
    const port = await freePort();
    await ensureUiPack();
    const proc = Bun.spawn(
      [
        process.execPath,
        entry,
        "serve",
        "--http",
        `127.0.0.1:${port}`,
        "--dir",
        site.dataDir,
        "--automigrate=false",
        "--schema",
        site.schemaPath,
      ],
      {
        cwd: mkdtempSync(join(tmpdir(), "iglo-base-source-")),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    try {
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 60_000;
      let healthy = false;
      while (!healthy && Date.now() < deadline && proc.exitCode === null) {
        healthy = await fetch(`${url}/api/health`)
          .then((response) => response.status === 200)
          .catch(() => false);
        if (!healthy) {
          await Bun.sleep(200);
        }
      }
      if (!healthy) {
        // the server exited (a failed start) or never answered: stop it, then read why
        proc.kill();
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`the source server did not become healthy: ${stderr}`);
      }
      const list = await fetch(`${url}/api/collections/posts/records`);
      expect(list.status).toBe(200);
      const body = (await list.json()) as { items: { title: string }[] };
      expect(body.items.map((item) => item.title)).toEqual(["from source"]);
    } finally {
      proc.kill();
      await proc.exited;
      releasePort(port);
    }
  });
});

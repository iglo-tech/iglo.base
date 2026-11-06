// A JavaScript migration that clears a record's file while S3 storage is on
// (M5.4b backlog): `migrate up` ends only after the file is deleted from the
// bucket, as upstream's transaction runs its after-commit functions before it
// returns. Compared with the reference PocketBase v0.41.0 binary. Not part of
// `bun test`: run `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { s3Settings, walk } from "@test/differential/crash/harness";
import {
  api,
  kinds,
  newSite,
  runIn,
  serveSite,
  writeMigrations,
} from "@test/differential/migrations/support";
import { startVersitygw, type Versitygw } from "@test/support/versitygw";

const timeout = 120_000;
const root = mkdtempSync(join(tmpdir(), "iglo-base-migration-s3-"));
let gw: Versitygw;

beforeAll(async () => {
  gw = await startVersitygw();
});

afterAll(async () => {
  await gw.stop();
  rmSync(root, { recursive: true, force: true });
});

// the objects of one record (the two servers share the bucket)
function storedFiles(recordId: string): string[] {
  return walk(join(gw.posixRoot, gw.bucket)).filter(
    (p) => p.split("/")[1] === recordId && p.split("/").length === 3,
  );
}

describe("migration file clear on S3", () => {
  for (const kind of kinds) {
    test(
      `${kind}: migrate up removes the cleared file from the bucket before it exits`,
      async () => {
        const site = newSite(kind, root);
        const server = await serveSite(site);
        let id: string;
        try {
          const settings = await api(server, "PATCH", "/api/settings", { s3: s3Settings(gw) });
          expect(settings.status).toBe(200);
          const made = await api(server, "POST", "/api/collections", {
            name: "docs",
            type: "base",
            fields: [{ name: "file", type: "file", maxSelect: 1, maxSize: 1000000 }],
          });
          expect(made.status).toBe(200);
          const form = new FormData();
          form.set("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
          const created = await fetch(`${server.url}/api/collections/docs/records`, {
            method: "POST",
            headers: { authorization: server.token },
            body: form,
          });
          expect(created.status).toBe(200);
          id = ((await created.json()) as { id: string }).id;
        } finally {
          await server.stop();
        }
        const before = storedFiles(id);
        expect(before).toHaveLength(1);

        writeMigrations(site, {
          "9999999999_clear_file.js": `migrate((app) => {
  const record = app.findRecordById("docs", ${JSON.stringify(id)});
  record.set("file", "");
  app.save(record);
}, () => {});
`,
        });
        const result = await runIn(site, ["migrate", "up"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Applied 9999999999_clear_file.js");

        // gone at exit: no waiting for it
        expect(storedFiles(id)).toEqual([]);
      },
      timeout,
    );
  }
});

// Upstream: apis/backup_test.go
//
// The scenarios that run against both servers. The scenarios that need a
// preset active backup are in test/apis/backup.test.ts.
//
// Skipped here because their BeforeTestFunc sets core.StoreKeyActiveBackup,
// which has no counterpart in iglo.base's test harness yet (they are in
// test/apis/backup.test.ts):
// - TestBackupsCreate: "authorized as superuser (pending backup)"
// - TestBackupsDelete: "authorized as superuser (existing file with matching active backup)"
// - TestBackupsDelete: "authorized as superuser (existing file and no matching active backup)"
// - TestBackupsRestore: "authorized as superuser (active backup process)"
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DefaultMaxBodySize } from "@/middlewares/middlewares";
import { create } from "@/tools/archive/create";
import { NewLocal } from "@/tools/filesystem/filesystem";
import { superuserToken } from "@test/scenarios/cron";
import type { AfterContext, PrepareContext, Suite } from "@test/scenarios/scenario";
import { setupWhitelist } from "@test/scenarios/settings-prepare";

const userToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";

const asUser = { Authorization: userToken };
const asSuperuser = { Authorization: superuserToken };

// the same four backups as createTestBackups: zips of the fixture, without the backups dir
export function createTestBackups(dataDir: string): void {
  for (const name of ["test1.zip", "test2.zip", "test3.zip", "@test4.zip"]) {
    const temp = join(dataDir, ".pb_temp_to_delete", name);
    create(dataDir, temp, "backups", ".pb_temp_to_delete");
    const fsys = NewLocal(join(dataDir, "backups"));
    fsys.upload(readFileSync(temp), name);
    fsys.close();
    rmSync(temp);
  }
}

// the keys of GET /api/backups
async function backupKeys(url: string): Promise<string[]> {
  const res = await fetch(`${url}/api/backups`, { headers: asSuperuser });
  const items = (await res.json()) as { key: string }[];
  return items.map((item) => item.key);
}

function keysAfter(check: (keys: string[]) => void): (ctx: AfterContext) => Promise<void> {
  return async ({ url }) => {
    check(await backupKeys(url));
  };
}

function expectBackupCount(n: number): (ctx: AfterContext) => Promise<void> {
  return keysAfter((keys) => {
    if (keys.length !== n) {
      throw new Error(`Expected ${n} backup files, got ${keys.length}`);
    }
  });
}

const ensureNoBackups = expectBackupCount(0);
const noTestBackupFilesChanges = expectBackupCount(4);

// exactly one backup, whose key matches
function expectSingleBackup(
  matches: (key: string) => boolean,
  expected: string,
): (ctx: AfterContext) => Promise<void> {
  return keysAfter((keys) => {
    if (keys.length !== 1) {
      throw new Error(`Expected 1 backup file, got ${keys.length}`);
    }
    if (!matches(keys[0]!)) {
      throw new Error(`Expected backup file ${expected}, got ${keys[0]}`);
    }
  });
}

// the backup count is `remaining` and the named backup is gone
function expectDeleted(name: string, remaining: number): (ctx: AfterContext) => Promise<void> {
  return keysAfter((keys) => {
    if (keys.length !== remaining) {
      throw new Error(`Expected ${remaining} backup files, got ${keys.length}`);
    }
    if (keys.includes(name)) {
      throw new Error(`Expected backup ${name} to be deleted`);
    }
  });
}

// the body of a multipart upload with one file part, as upstream's loop builds it
const uploadBoundary = "iglo-backup-upload-boundary";
const uploadContentType = `multipart/form-data; boundary=${uploadBoundary}`;

// an empty zip: the end-of-central-directory record only
const emptyZip = new Uint8Array(22);
emptyZip.set([0x50, 0x4b, 0x05, 0x06]);

function multipartUpload(): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${uploadBoundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="test"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${uploadBoundary}--\r\n`);
  const body = new Uint8Array(head.length + emptyZip.length + tail.length);
  body.set(head, 0);
  body.set(emptyZip, head.length);
  body.set(tail, head.length + emptyZip.length);
  return body;
}

const uploadBody = multipartUpload();

// the default body limit is skipped for uploads, so this body is larger than it
const oversizedBody = new Uint8Array(DefaultMaxBodySize + 100);

export const backupsList: Suite = {
  file: "apis/backup_test.go",
  func: "TestBackupsList",
  scenarios: [
    {
      name: "unauthorized",
      method: "GET",
      url: "/api/backups",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "GET",
      url: "/api/backups",
      headers: asUser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (empty list)",
      method: "GET",
      url: "/api/backups",
      headers: asSuperuser,
      expectedStatus: 200,
      expectedContent: [`[]`],
    },
    {
      name: "authorized as superuser",
      method: "GET",
      url: "/api/backups",
      headers: asSuperuser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 200,
      expectedContent: [`"test1.zip"`, `"test2.zip"`, `"test3.zip"`],
    },
  ],
};

export const backupsCreate: Suite = {
  file: "apis/backup_test.go",
  func: "TestBackupsCreate",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/backups",
      after: ensureNoBackups,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/backups",
      headers: asUser,
      after: ensureNoBackups,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (autogenerated name)",
      method: "POST",
      url: "/api/backups",
      headers: asSuperuser,
      after: expectSingleBackup((key) => key.startsWith("pb_backup_"), "with prefix pb_backup_"),
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser (invalid name)",
      method: "POST",
      url: "/api/backups",
      body: `{"name":"!test.zip"}`,
      headers: asSuperuser,
      after: ensureNoBackups,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"name":{"code":"validation_match_invalid"`],
    },
    {
      name: "authorized as superuser (valid name)",
      method: "POST",
      url: "/api/backups",
      body: `{"name":"test.zip"}`,
      headers: asSuperuser,
      after: expectSingleBackup((key) => key === "test.zip", "test.zip"),
      expectedStatus: 204,
    },
  ],
};

export const backupUpload: Suite = {
  file: "apis/backup_test.go",
  func: "TestBackupUpload",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/backups/upload",
      body: uploadBody,
      headers: { "Content-Type": uploadContentType },
      after: ensureNoBackups,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/backups/upload",
      body: uploadBody,
      headers: { "Content-Type": uploadContentType, Authorization: userToken },
      after: ensureNoBackups,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (missing file)",
      method: "POST",
      url: "/api/backups/upload",
      headers: asSuperuser,
      after: ensureNoBackups,
      expectedStatus: 400,
      expectedContent: [`"data":{`],
    },
    {
      name: "authorized as superuser (existing backup name)",
      method: "POST",
      url: "/api/backups/upload",
      body: uploadBody,
      headers: { "Content-Type": uploadContentType, ...asSuperuser },
      prepare: ({ dataDir }: PrepareContext) => {
        // create a dummy backup file to simulate existing backups
        const fsys = NewLocal(join(dataDir, "backups"));
        fsys.upload(new TextEncoder().encode("123"), "test");
        fsys.close();
      },
      after: expectBackupCount(1),
      expectedStatus: 400,
      expectedContent: [`"data":{"file":{`],
    },
    {
      name: "authorized as superuser (valid file)",
      method: "POST",
      url: "/api/backups/upload",
      body: uploadBody,
      headers: { "Content-Type": uploadContentType, ...asSuperuser },
      after: expectBackupCount(1),
      expectedStatus: 204,
    },
    {
      name: "ensure that the default body limit is skipped",
      method: "POST",
      url: "/api/backups/upload",
      body: oversizedBody,
      headers: asSuperuser,
      // it doesn't matter as long as it is not 413
      expectedStatus: 400,
      expectedContent: [`"data":{`],
      notExpectedContent: ["entity too large"],
    },
  ],
};

export const backupsDownload: Suite = {
  file: "apis/backup_test.go",
  func: "TestBackupsDownload",
  scenarios: [
    {
      name: "unauthorized",
      method: "GET",
      url: "/api/backups/test1.zip",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with record auth header",
      method: "GET",
      url: "/api/backups/test1.zip",
      headers: asUser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with superuser auth header",
      method: "GET",
      url: "/api/backups/test1.zip",
      headers: asSuperuser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with empty or invalid token",
      method: "GET",
      url: "/api/backups/test1.zip?token=",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with valid record auth token",
      method: "GET",
      url: "/api/backups/test1.zip?token=eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with valid record file token",
      method: "GET",
      url: "/api/backups/test1.zip?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8ifQ.nSTLuCPcGpWn2K2l-BFkC3Vlzc-ZTDPByYq8dN1oPSo",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with valid superuser auth token",
      method: "GET",
      url: "/api/backups/test1.zip?token=eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with expired superuser file token",
      method: "GET",
      url: "/api/backups/test1.zip?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MTY0MDk5MTY2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.nqqtqpPhxU0045F4XP_ruAkzAidYBc5oPy9ErN3XBq0",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with valid superuser file token but missing backup name",
      method: "GET",
      url: "/api/backups/missing?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with valid superuser file token",
      method: "GET",
      url: "/api/backups/test1.zip?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 200,
      expectedContent: ["storage/", "data.db", "auxiliary.db"],
    },
    {
      name: "with valid superuser file token and backup name with escaped char",
      method: "GET",
      url: "/api/backups/%40test4.zip?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 200,
      expectedContent: ["storage/", "data.db", "auxiliary.db"],
    },
    {
      name: "with valid superuser file token AND whitelisted IP",
      method: "GET",
      url: "/api/backups/test1.zip?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc",
      headers: { "x-test-ip": "127.0.0.1" },
      prepare: (ctx: PrepareContext) => {
        createTestBackups(ctx.dataDir);
        setupWhitelist("127.0.0.1")(ctx);
      },
      expectedStatus: 200,
      expectedContent: ["storage/", "data.db", "auxiliary.db"],
    },
    {
      name: "with valid superuser file token BUT non-whitelisted IP",
      method: "GET",
      url: "/api/backups/test1.zip?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc",
      headers: { "x-test-ip": "127.0.0.1" },
      prepare: (ctx: PrepareContext) => {
        createTestBackups(ctx.dataDir);
        setupWhitelist("0.0.0.0")(ctx);
      },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
  ],
};

export const backupsDelete: Suite = {
  file: "apis/backup_test.go",
  func: "TestBackupsDelete",
  scenarios: [
    {
      name: "unauthorized",
      method: "DELETE",
      url: "/api/backups/test1.zip",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      after: noTestBackupFilesChanges,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "DELETE",
      url: "/api/backups/test1.zip",
      headers: asUser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      after: noTestBackupFilesChanges,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (missing file)",
      method: "DELETE",
      url: "/api/backups/missing.zip",
      headers: asSuperuser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      after: noTestBackupFilesChanges,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (backup with escaped character)",
      method: "DELETE",
      url: "/api/backups/%40test4.zip",
      headers: asSuperuser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      after: expectDeleted("@test4.zip", 3),
      expectedStatus: 204,
    },
  ],
};

export const backupsRestore: Suite = {
  file: "apis/backup_test.go",
  func: "TestBackupsRestore",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/backups/test1.zip/restore",
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/backups/test1.zip/restore",
      headers: asUser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (missing file)",
      method: "POST",
      url: "/api/backups/missing.zip/restore",
      headers: asSuperuser,
      prepare: ({ dataDir }: PrepareContext) => createTestBackups(dataDir),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
  ],
};

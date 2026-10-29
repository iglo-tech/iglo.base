// Auth flows across both servers (src/apis/record-auth*.ts): tokens issued
// by either server are accepted by the other, `_authOrigins` and `_mfas`
// rows written by iglo.base are read by upstream PocketBase v0.41.0
// unchanged (and the other way around), and password hashes written by
// either server sign in on the other. Not part of `bun test`: run
// `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { md5 } from "@/tools/security/crypto";

import { setMFA } from "@test/scenarios/record-auth-prepare";
import { queryRows } from "@test/scenarios/record-checks";
import { superuserToken } from "@test/scenarios/record-crud";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const pw = "1234567890";
const userAgent = "iglo-base-auth-flows/1.0";

interface Server {
  url: string;
  dataDir: string;
  stop(): Promise<unknown>;
}

const roots: string[] = [];
const running = new Set<Server>();

// a fixture copy with MFA off for users
function preparedCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-auth-flows-"));
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  setMFA("users", false, "")({ dataDir });
  return dataDir;
}

function copyOf(dataDir: string): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-auth-flows-"));
  roots.push(root);
  const copy = join(root, "pb_data");
  copyDataDir(dataDir, copy);
  return copy;
}

async function start(kind: "upstream" | "igloBase", dataDir: string): Promise<Server> {
  const server =
    kind === "upstream"
      ? await startUpstream({ dataDir })
      : { ...(await startServer([], dataDir)), dataDir };
  const s: Server = { url: server.url, dataDir, stop: () => server.stop() };
  running.add(s);
  return s;
}

async function stop(server: Server): Promise<void> {
  running.delete(server);
  await server.stop();
}

async function post(
  server: Server,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: { [key: string]: unknown } }> {
  const res = await fetch(server.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text) };
}

function login(server: Server, collection: string, identity: string, extra: object = {}) {
  return post(server, `/api/collections/${collection}/auth-with-password`, {
    identity,
    password: pw,
    ...extra,
  });
}

function refresh(server: Server, collection: string, token: string) {
  return post(server, `/api/collections/${collection}/auth-refresh`, undefined, {
    Authorization: token,
  });
}

function origins(
  dataDir: string,
  recordId: string,
): { fingerprint: string; collectionRef: string }[] {
  return queryRows(
    dataDir,
    "SELECT collectionRef, recordRef, fingerprint FROM _authOrigins WHERE recordRef = ? ORDER BY created",
    recordId,
  ) as { fingerprint: string; collectionRef: string }[];
}

afterAll(async () => {
  await Promise.allSettled([...running].map((s) => s.stop()));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("tokens across servers", () => {
  let upstream: Server;
  let igloBase: Server;

  beforeAll(async () => {
    const dataDir = preparedCopy();
    [upstream, igloBase] = await Promise.all([
      start("upstream", copyOf(dataDir)),
      start("igloBase", copyOf(dataDir)),
    ]);
  });

  for (const [from, to] of [
    ["upstream", "igloBase"],
    ["igloBase", "upstream"],
  ] as const) {
    test(`a ${from} auth token refreshes on ${to}`, async () => {
      const servers = { upstream, igloBase };
      const auth = await login(servers[from], "clients", "test@example.com");
      expect(auth.status).toBe(200);
      const token = auth.json["token"] as string;

      const res = await refresh(servers[to], "clients", token);
      expect(res.status).toBe(200);
      expect((res.json["record"] as { id: string }).id).toBe("gk390qegs4y47wn");
      // a new refreshable token, accepted back by the issuer
      const back = await refresh(servers[from], "clients", res.json["token"] as string);
      expect(back.status).toBe(200);
    });

    test(`a ${from} impersonate token stays static on ${to}`, async () => {
      const servers = { upstream, igloBase };
      const res = await post(
        servers[from],
        "/api/collections/users/impersonate/4q1xlclmfloku33",
        { duration: 100 },
        { Authorization: superuserToken },
      );
      expect(res.status).toBe(200);
      const token = res.json["token"] as string;

      const refreshed = await refresh(servers[to], "users", token);
      expect(refreshed.status).toBe(200);
      expect(refreshed.json["token"]).toBe(token);
    });

    test(`a ${from} superuser token refreshes on ${to}`, async () => {
      const servers = { upstream, igloBase };
      const auth = await login(servers[from], "_superusers", "test@example.com");
      expect(auth.status).toBe(200);

      const res = await refresh(servers[to], "_superusers", auth.json["token"] as string);
      expect(res.status).toBe(200);
    });
  }
});

describe("auth origins and MFAs across servers", () => {
  // users test@example.com has no auth origins in the fixture
  const userId = "4q1xlclmfloku33";

  test("the first login stores one origin, as upstream stores it", async () => {
    const dataDir = preparedCopy();
    const [upstream, igloBase] = await Promise.all([
      start("upstream", copyOf(dataDir)),
      start("igloBase", copyOf(dataDir)),
    ]);
    for (const server of [upstream, igloBase]) {
      expect((await login(server, "users", "test@example.com")).status).toBe(200);
      // the same device again updates the origin
      expect((await login(server, "users", "test@example.com")).status).toBe(200);
    }
    await Promise.all([stop(upstream), stop(igloBase)]);

    const expected = [
      {
        collectionRef: "_pb_users_auth_",
        recordRef: userId,
        // security.MD5(ip + userAgent)
        fingerprint: md5("127.0.0.1" + userAgent),
      },
    ];
    expect(origins(upstream.dataDir, userId)).toEqual(expected);
    expect(origins(igloBase.dataDir, userId)).toEqual(expected);

    // upstream reads iglo.base's row: the same device is not new
    const upstreamOnIglo = await start("upstream", igloBase.dataDir);
    expect((await login(upstreamOnIglo, "users", "test@example.com")).status).toBe(200);
    const list = await fetch(
      `${upstreamOnIglo.url}/api/collections/_authOrigins/records?filter=recordRef='${userId}'`,
      {
        headers: { Authorization: superuserToken },
      },
    ).then((r) => r.json() as Promise<{ items: { fingerprint: string }[] }>);
    expect(list.items.map((i) => i.fingerprint)).toEqual(expected.map((o) => o.fingerprint));
    await stop(upstreamOnIglo);
    expect(origins(igloBase.dataDir, userId)).toEqual(expected);
  });

  test("a login from a new device without a mailer stores no origin on either server", async () => {
    const dataDir = preparedCopy();
    const [upstream, igloBase] = await Promise.all([
      start("upstream", copyOf(dataDir)),
      start("igloBase", copyOf(dataDir)),
    ]);
    for (const server of [upstream, igloBase]) {
      expect((await login(server, "users", "test@example.com")).status).toBe(200);
      const other = await fetch(`${server.url}/api/collections/users/auth-with-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "another device" },
        body: JSON.stringify({ identity: "test@example.com", password: pw }),
      });
      // the failed alert never fails the auth
      expect(other.status).toBe(200);
    }
    await Promise.all([stop(upstream), stop(igloBase)]);
    expect(origins(igloBase.dataDir, userId)).toEqual(origins(upstream.dataDir, userId));
    expect(origins(igloBase.dataDir, userId)).toHaveLength(1);
  });

  // with a working mailer upstream sends the alert and then stores the
  // second origin; the mailer is M4.4
  test.todo(
    "a login from a new device with a mailer sends the alert and stores one more origin (M4.4)",
  );

  for (const [writer, reader] of [
    ["igloBase", "upstream"],
    ["upstream", "igloBase"],
  ] as const) {
    test(`an MFA written by ${writer} is read by ${reader}`, async () => {
      const writerServer = await start(writer, copyOf(fixtureDir));
      const first = await login(writerServer, "users", "test@example.com");
      expect(first.status).toBe(401);
      const mfaId = first.json["mfaId"] as string;
      await stop(writerServer);

      const row = queryRows(
        writerServer.dataDir,
        "SELECT collectionRef, recordRef, method FROM _mfas WHERE id = ?",
        mfaId,
      );
      expect(row).toEqual([
        { collectionRef: "_pb_users_auth_", recordRef: userId, method: "password" },
      ]);

      // the reader finds the MFA, with its record and method
      const readerServer = await start(reader, writerServer.dataDir);
      const second = await login(readerServer, "users", "test@example.com", { mfaId });
      expect(second.status).toBe(400);
      expect(second.json["message"]).toBe("A different authentication method is required.");
      const other = await login(readerServer, "users", "test2@example.com", { mfaId });
      expect(other.json["message"]).toBe("Invalid MFA session.");
      await stop(readerServer);
    });
  }
});

describe("password hashes across servers", () => {
  for (const [writer, reader] of [
    ["igloBase", "upstream"],
    ["upstream", "igloBase"],
  ] as const) {
    test(`a password set on ${writer} signs in on ${reader}`, async () => {
      const writerServer = await start(writer, preparedCopy());
      const res = await fetch(
        `${writerServer.url}/api/collections/clients/records/gk390qegs4y47wn`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: superuserToken },
          body: JSON.stringify({
            password: "new-password-123",
            passwordConfirm: "new-password-123",
          }),
        },
      );
      expect(res.status).toBe(200);
      await stop(writerServer);

      const readerServer = await start(reader, writerServer.dataDir);
      const ok = await post(readerServer, "/api/collections/clients/auth-with-password", {
        identity: "test@example.com",
        password: "new-password-123",
      });
      expect(ok.status).toBe(200);
      const old = await login(readerServer, "clients", "test@example.com");
      expect(old.status).toBe(400);
      await stop(readerServer);
    });
  }
});

// R.1 spike (throwaway): the replicas answer the same as the primary alone.
//
// For N = 0, 1, 2 and 4, starts a cluster on a copy of the base pb_data
// (dist/r1/base/pb_data, built by bench.ts --keep) and sends the same requests
// through the public port. Responses are normalized (timestamps, tokens and
// random file-name suffixes) and compared with N = 0. Exits 1 on a difference.
//
//   bun scripts/spikes/R.1/check.ts

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "@/../scripts/spikes/M0.8/common";
import { startCluster, type Cluster } from "@/../scripts/spikes/R.1/cluster";

const exe = join(repoRoot, "dist/iglo-base");
const base = join(repoRoot, "dist/r1/base/pb_data");
const checkRoot = join(repoRoot, "dist/r1/check");
const password = "1234567890";
const fileBody = "R.1 file body\n".repeat(50);

interface Result {
  status: number;
  contentType: string;
  body: string;
}
type Results = Record<string, Result | { ok: boolean; detail: string }>;

const normalize = (text: string): string =>
  text
    .replace(/"(created|updated)":"[^"]*"/g, '"$1":"<ts>"')
    .replace(/"token":"[^"]*"/g, '"token":"<token>"')
    .replace(/_[A-Za-z0-9]{10}(\.[A-Za-z0-9]+)/g, "_<rnd>$1");

// randomIds: a record created by the request has an id the server generates
async function call(
  url: string,
  path: string,
  init: RequestInit & { unix?: string } = {},
  randomIds = false,
): Promise<Result> {
  const res = await fetch(url + path, init);
  const body = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: normalize(randomIds ? body.replace(/"id":"[a-z0-9]{15}"/g, '"id":"<generated>"') : body),
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(needle)) {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(`no ${needle} within ${timeoutMs} ms`);
    }
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(left).then(() => ({ done: true, value: undefined }) as const),
    ]);
    if (next.done || next.value === undefined) {
      break;
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

async function runChecks(c: Cluster, primaryUnix: string | undefined): Promise<Results> {
  const u = c.url;
  const out: Results = {};

  const loginRes = await fetch(u + "/api/collections/_superusers/auth-with-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: "bench@example.com", password }),
  });
  const loginText = await loginRes.text();
  out["superuser login (proxied POST)"] = {
    status: loginRes.status,
    contentType: loginRes.headers.get("content-type") ?? "",
    body: normalize(loginText),
  };
  const token = (JSON.parse(loginText) as { token: string }).token;
  const auth = { authorization: token };

  const reads: [string, string, RequestInit?][] = [
    ["health", "/api/health"],
    ["list posts perPage=30", "/api/collections/posts/records?perPage=30"],
    [
      "list posts filter+sort",
      "/api/collections/posts/records?perPage=30&sort=-views,title&filter=" +
        encodeURIComponent('views > 1000 && title ~ "Post 1"'),
    ],
    ["list posts expand author", "/api/collections/posts/records?perPage=30&expand=author"],
    [
      "list posts expand author.team",
      "/api/collections/posts/records?perPage=30&expand=author.team",
    ],
    ["view post 42", "/api/collections/posts/records/p00000000000042"],
    ["view missing record", "/api/collections/posts/records/nope000000000000"],
    [
      "list invalid filter",
      "/api/collections/posts/records?filter=" + encodeURIComponent("views >>"),
    ],
    [
      "list members fields+page",
      "/api/collections/members/records?perPage=5&page=2&fields=id,name,team",
    ],
    ["view member 5", "/api/collections/members/records/m00000000000005"],
    ["list posts as superuser", "/api/collections/posts/records?perPage=1", { headers: auth }],
    ["list files_r1", "/api/collections/files_r1/records"],
    ["view file record", "/api/collections/files_r1/records/f000000000000r1"],
    ["list posts skipTotal", "/api/collections/posts/records?perPage=2&skipTotal=true"],
  ];
  for (const [name, path, init] of reads) {
    out[name] = await call(u, path, init);
  }

  // a file upload through the replica (proxied multipart POST), then its download
  const form = new FormData();
  form.set("id", "f000000000000r2");
  form.set("title", "file 2");
  form.set("doc", new File([fileBody], "hello.txt", { type: "text/plain" }));
  out["create file record (proxied multipart POST)"] = await call(
    u,
    "/api/collections/files_r1/records",
    { method: "POST", body: form, headers: auth },
  );
  const raw = JSON.parse(
    await (await fetch(u + "/api/collections/files_r1/records/f000000000000r2")).text(),
  ) as { doc: string };
  const fileURL = `/api/files/files_r1/f000000000000r2/${raw.doc}`;
  // the replica serves the file from the store; the primary's copy must match
  const viaReplica = await fetch(u + fileURL);
  const replicaBytes = await viaReplica.text();
  const viaPrimary =
    primaryUnix === undefined
      ? await fetch(u + fileURL)
      : await fetch("http://primary" + fileURL, { unix: primaryUnix });
  const primaryBytes = await viaPrimary.text();
  out["file download (replica)"] = {
    status: viaReplica.status,
    contentType: viaReplica.headers.get("content-type") ?? "",
    body: replicaBytes === fileBody ? "<file body as uploaded>" : `MISMATCH ${replicaBytes.length}`,
  };
  out["file download (primary)"] = {
    status: viaPrimary.status,
    contentType: viaPrimary.headers.get("content-type") ?? "",
    body: primaryBytes === fileBody ? "<file body as uploaded>" : `MISMATCH ${primaryBytes.length}`,
  };

  // a create through the replica, then read back through the replica
  out["create post (proxied JSON POST)"] = await call(
    u,
    "/api/collections/posts/records",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "R1 new", views: 5, author: "m00000000000007" }),
    },
    true,
  );
  out["visible after create (replica read)"] = await call(
    u,
    "/api/collections/posts/records?perPage=5&filter=" + encodeURIComponent('title = "R1 new"'),
    undefined,
    true,
  );

  // realtime through the replica: connect, subscribe, create, receive the event
  const stream = await fetch(u + "/api/realtime", { headers: { accept: "text/event-stream" } });
  const reader = stream.body!.getReader();
  const connectText = await readUntil(reader, "PB_CONNECT", 5_000);
  const clientId = /"clientId":"([^"]+)"/.exec(connectText)?.[1] ?? "";
  const sub = await fetch(u + "/api/realtime", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, subscriptions: ["posts"] }),
  });
  await sub.text();
  await call(u, "/api/collections/posts/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "R1 realtime", views: 1, author: "m00000000000008" }),
  });
  let event = "";
  try {
    event = await readUntil(reader, '"action":"create"', 5_000);
  } catch (err) {
    event = String(err);
  }
  await reader.cancel();
  out["realtime create event"] = {
    ok: sub.status === 204 && event.includes('"action":"create"') && event.includes("R1 realtime"),
    detail: `subscribe ${sub.status}, event ${event.includes("R1 realtime") ? "received" : "missing"}`,
  };

  return out;
}

rmSync(checkRoot, { recursive: true, force: true });
mkdirSync(checkRoot, { recursive: true });

// setup on a primary alone, before any replica starts: the replicas load the
// collections once at start (R.1 prototype), so the collection must exist first
const setupDir = join(checkRoot, "setup", "pb_data");
cpSync(base, setupDir, { recursive: true });
const setup = await startCluster({ exe, dataDir: setupDir, cwd: repoRoot, replicas: 0 });
try {
  const u = setup.url;
  const loginText = await (
    await fetch(u + "/api/collections/_superusers/auth-with-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "bench@example.com", password }),
    })
  ).text();
  const auth = { authorization: (JSON.parse(loginText) as { token: string }).token };
  const created = await fetch(u + "/api/collections", {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({
      name: "files_r1",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "doc", type: "file", maxSelect: 1, maxSize: 5_000_000 },
      ],
    }),
  });
  if (created.status !== 200) {
    throw new Error(`create collection: ${created.status} ${await created.text()}`);
  }
  const form = new FormData();
  form.set("id", "f000000000000r1");
  form.set("title", "file 1");
  form.set("doc", new File([fileBody], "hello.txt", { type: "text/plain" }));
  const rec = await fetch(u + "/api/collections/files_r1/records", {
    method: "POST",
    body: form,
    headers: auth,
  });
  if (rec.status !== 200) {
    throw new Error(`create file record: ${rec.status} ${await rec.text()}`);
  }
} finally {
  await setup.stop();
}

const results: Record<number, Results> = {};
for (const n of [0, 1, 2, 4]) {
  const dataDir = join(checkRoot, `n${n}`, "pb_data");
  cpSync(setupDir, dataDir, { recursive: true });
  const cluster = await startCluster({ exe, dataDir, cwd: repoRoot, replicas: n });
  try {
    results[n] = await runChecks(cluster, cluster.socket);
  } finally {
    await cluster.stop();
  }
}

// comparison with N = 0
let mismatches = 0;
const report: Record<string, unknown> = {};
for (const n of [1, 2, 4]) {
  const diffs: string[] = [];
  for (const name of Object.keys(results[0]!)) {
    const a = JSON.stringify(results[0]![name]);
    const b = JSON.stringify(results[n]?.[name]);
    if (a !== b) {
      diffs.push(`${name}: N=0 ${a} vs N=${n} ${b}`);
    }
  }
  report[`n${n}`] = { checks: Object.keys(results[0]!).length, diffs };
  mismatches += diffs.length;
}
for (const name of Object.keys(results[0]!)) {
  const r = results[0]![name] as Result & { ok?: boolean; detail?: string };
  const head = "status" in r ? String(r.status) : `ok=${r.ok} ${r.detail ?? ""}`;
  console.log(`${head.padEnd(40)} ${name}`);
}
console.log(JSON.stringify(report, null, 1));
console.log(mismatches === 0 ? "CHECK OK: N=1, 2, 4 match N=0" : `CHECK DIFFERS: ${mismatches}`);
process.exit(mismatches === 0 ? 0 : 1);

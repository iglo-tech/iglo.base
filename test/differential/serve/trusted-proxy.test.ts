// Upstream: core/event_request.go (RealIP with settings.TrustedProxy) and
// its callers: apis/health.go (realIP, possibleProxyHeader), the superuser
// IP whitelist (apis/middlewares.go), the rate limiter's client key
// (apis/middlewares_rate_limit.go) and the activity logger's userIP
// (apis/middlewares.go). Upstream PocketBase v0.41.0 and the compiled
// iglo.base executable run on fixture copies with the same settings and get
// the same requests; every request comes from 127.0.0.1. Not part of `bun
// test`: run `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startPair, type Pair } from "@test/differential/serve/pair";
import { superuserToken } from "@test/scenarios/record-crud";
import { changeSettings } from "@test/scenarios/settings-prepare";

const timeout = 60_000;

interface Config {
  headers: string[];
  useLeftmostIP: boolean;
}

const configs: [name: string, config: Config][] = [
  ["no trusted headers", { headers: [], useLeftmostIP: false }],
  [
    "X-Forwarded-For, rightmost",
    { headers: ["X-Real-IP", "X-Forwarded-For"], useLeftmostIP: false },
  ],
  ["X-Forwarded-For, leftmost", { headers: ["x-real-ip", "x-forwarded-for"], useLeftmostIP: true }],
];

const pairs = new Map<string, Pair>();

beforeAll(async () => {
  const started = await Promise.all(
    configs.map(([, config]) =>
      startPair({
        prepare: (dataDir) =>
          changeSettings(dataDir, (settings) => {
            settings.trustedProxy = { ...config };
            settings.superuserIPs = ["10.0.0.1", "2001:db8::/32"];
            settings.rateLimits = {
              enabled: true,
              excludedIPs: ["10.9.9.9"],
              rules: [{ label: "/rate/", audience: "", duration: 3600, maxRequests: 1 }],
            };
            settings.logs = { maxDays: 5, minLevel: 0, logIP: true, logAuthId: false };
          }),
      }),
    ),
  );
  configs.forEach(([name], i) => pairs.set(name, started[i] as Pair));
}, timeout);

afterAll(async () => {
  await Promise.allSettled([...pairs.values()].map((p) => p.stop()));
});

async function get(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.text() };
}

// the same request to both servers
async function both(
  pair: Pair,
  path: string,
  headers: Record<string, string>,
): Promise<[{ status: number; body: string }, { status: number; body: string }]> {
  return Promise.all([
    get(pair.upstream.url, path, headers),
    get(pair.igloBase.url, path, headers),
  ]);
}

function healthData(body: string): unknown {
  return (JSON.parse(body) as { data: unknown }).data;
}

// header sets, sent as single lines (fetch cannot repeat a header line)
const sent: Record<string, string>[] = [
  {},
  { "X-Forwarded-For": "10.0.0.1" },
  { "X-Forwarded-For": "10.0.0.2, 10.0.0.1" },
  { "X-Forwarded-For": "10.0.0.1, 10.0.0.2" },
  { "X-Forwarded-For": "invalid, 10.0.0.1 ,10.0.0.3, invalid" },
  { "X-Forwarded-For": "2001:db8::1" },
  { "X-Forwarded-For": "::ffff:10.0.0.1" },
  { "X-Forwarded-For": "nope" },
  { "X-Real-IP": "10.0.0.1", "X-Forwarded-For": "10.0.0.2" },
  { "X-Real-IP": "", "X-Forwarded-For": "10.0.0.1" },
  { "CF-Connecting-IP": "10.0.0.1" },
  { "Fly-Client-IP": "10.0.0.1" },
];

describe.each(configs)("%s", (name) => {
  const pair = (): Pair => pairs.get(name) as Pair;

  for (const headers of sent) {
    test(`/api/health realIP and possibleProxyHeader: ${JSON.stringify(headers)}`, async () => {
      const [up, ig] = await both(pair(), "/api/health", {
        ...headers,
        Authorization: superuserToken,
      });
      expect(ig.status).toBe(up.status);
      if (up.status !== 200) {
        // the whitelist refused the superuser on both
        expect(ig.body).toBe(up.body);
        return;
      }
      // a Go map: compared by member
      expect(healthData(ig.body)).toEqual(healthData(up.body));
    });

    test(`the superuser IP whitelist: ${JSON.stringify(headers)}`, async () => {
      const [up, ig] = await both(pair(), "/api/collections/demo2", {
        ...headers,
        Authorization: superuserToken,
      });
      expect(ig).toEqual(up);
    });
  }

  test("the rate limiter's client key", async () => {
    const steps: Record<string, string>[] = [
      { "X-Forwarded-For": "1.1.1.1" },
      { "X-Forwarded-For": "1.1.1.1" },
      { "X-Forwarded-For": "1.1.1.2" },
      { "X-Forwarded-For": "1.1.1.9, 1.1.1.2" },
      { "X-Forwarded-For": "1.1.1.2, 1.1.1.9" },
      { "X-Real-IP": "1.1.1.3" },
      { "X-Forwarded-For": "10.9.9.9" },
      { "X-Forwarded-For": "10.9.9.9" },
      {},
      {},
    ];
    const statuses: [number, number][] = [];
    for (const headers of steps) {
      const [up, ig] = await both(pair(), "/rate/x", headers);
      statuses.push([up.status, ig.status]);
    }
    expect(statuses.map(([, ig]) => ig)).toEqual(statuses.map(([up]) => up));
  });

  test("the activity log's userIP", async () => {
    const marker = `m${Date.now()}`;
    await both(pair(), `/api/collections/demo2/records?${marker}=1`, {
      "X-Forwarded-For": "3.3.3.3, 4.4.4.4",
      "X-Real-IP": "",
    });

    // the logs are written in batches: poll until the request's row is there
    const userIP = async (base: string): Promise<unknown> => {
      for (let i = 0; i < 100; i++) {
        const res = await fetch(
          `${base}/api/logs?filter=${encodeURIComponent(`data.url~'${marker}'`)}`,
          { headers: { Authorization: superuserToken, "X-Forwarded-For": "10.0.0.1" } },
        );
        if (res.status === 403) {
          // the whitelist: the superuser's real IP is not allowed here
          return "refused";
        }
        const list = (await res.json()) as {
          items: { data: { userIP: string; remoteIP: string } }[];
        };
        const [row] = list.items;
        if (row) {
          return [row.data.userIP, row.data.remoteIP];
        }
        await Bun.sleep(100);
      }
      return "no log row";
    };
    const [up, ig] = await Promise.all([userIP(pair().upstream.url), userIP(pair().igloBase.url)]);
    expect(ig).toEqual(up);
  });
});

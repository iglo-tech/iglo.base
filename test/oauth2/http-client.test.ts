// Upstream: Go net/http client.go, the redirect rules of provider requests.
// The differential cases in test/differential/auth/oauth2-cases.ts compare
// the common ones with the upstream binary.

import { afterAll, describe, expect, test } from "bun:test";

import { fetchFollowingRedirects } from "@/oauth2/http-client";

interface Seen {
  method: string;
  authorization: string | null;
  body: string;
}

const seen: Seen[] = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    seen.push({
      method: req.method,
      authorization: req.headers.get("Authorization"),
      body: await req.text(),
    });
    const hops = pathname.match(/^\/hops\/(\d+)$/);
    if (hops !== null) {
      const left = Number(hops[1]);
      return left === 0
        ? new Response("end")
        : new Response(null, { status: 302, headers: { Location: `/hops/${left - 1}` } });
    }
    if (pathname === "/redirect") {
      return new Response(null, {
        status: Number(searchParams.get("status")),
        headers: { Location: searchParams.get("to") ?? "" },
      });
    }
    return new Response("end");
  },
});
const local = `http://127.0.0.1:${server.port}`;
const named = `http://localhost:${server.port}`;

afterAll(() => {
  server.stop(true);
});

const via = (status: number, to: string): string =>
  `${local}/redirect?status=${status}&to=${encodeURIComponent(to)}`;

const auth = { headers: { Authorization: "Bearer abc" } };

describe("fetchFollowingRedirects", () => {
  for (const status of [301, 302, 303]) {
    test(`a ${status} turns a POST into a GET without its body`, async () => {
      seen.length = 0;
      await fetchFollowingRedirects(via(status, `${local}/end`), { method: "POST", body: "a=1" });
      expect(seen.at(-1)).toEqual({ method: "GET", authorization: null, body: "" });
    });
  }

  for (const status of [307, 308]) {
    test(`a ${status} keeps the method and body`, async () => {
      seen.length = 0;
      await fetchFollowingRedirects(via(status, `${local}/end`), { method: "POST", body: "a=1" });
      expect(seen.at(-1)).toEqual({ method: "POST", authorization: null, body: "a=1" });
    });
  }

  test("Authorization stays for the same host name on another port", async () => {
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => new Response(req.headers.get("Authorization") ?? "none"),
    });
    const res = await fetchFollowingRedirects(via(302, `http://127.0.0.1:${other.port}/`), auth);
    expect(await res.text()).toBe("Bearer abc");
    await other.stop(true);
  });

  test("Authorization goes on another host name, and stays gone", async () => {
    seen.length = 0;
    const back = via(302, `${local}/end`).replace(local, named);
    await fetchFollowingRedirects(via(302, back), auth);
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer abc", null, null]);
  });

  test("a transport Authorization goes to every host of the chain", async () => {
    seen.length = 0;
    await fetchFollowingRedirects(via(302, `${named}/end`), {}, "Bearer abc");
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer abc", "Bearer abc"]);
  });

  test("a 3xx without a Location is the response", async () => {
    const res = await fetchFollowingRedirects(via(302, ""));
    expect(res.status).toBe(302);
  });

  test("follows 10 redirects", async () => {
    const res = await fetchFollowingRedirects(`${local}/hops/10`);
    expect(await res.text()).toBe("end");
  });

  test("stops at the 11th redirect", async () => {
    await expect(fetchFollowingRedirects(`${local}/hops/11`)).rejects.toThrow(
      "stopped after 10 redirects",
    );
  });
});

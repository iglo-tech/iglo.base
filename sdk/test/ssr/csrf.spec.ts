// docs/design/13-ssr.md ("CSRF"). The guard is checked through checkCsrf and checkOrigin on Web Requests.
import { describe, expect, test } from "bun:test";
import { checkCsrf, checkOrigin } from "@sdk/ssr/index";

const APP = "https://app.example.com";

function req(
  method: string,
  headers: Record<string, string | null> = {},
  url = `${APP}/api/things`,
): Request {
  const init: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== null) {
      init[name] = value;
    }
  }
  return new Request(url, { method, headers: init });
}

const SESSION = { cookie: "__Host-pb_auth=%7B%22token%22%3A%22t%22%7D" };
const PLAIN_SESSION = { cookie: "pb_auth=value" };

describe("checkCsrf", () => {
  test("a same-origin POST with the session cookie passes", () => {
    expect(checkCsrf(req("POST", { ...SESSION, origin: APP })).ok).toBe(true);
  });

  test("a foreign origin with the session cookie is rejected with a 403", async () => {
    const result = checkCsrf(req("POST", { ...SESSION, origin: "https://evil.example" }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.reason).toBe("foreign-origin");
    expect(result.response.status).toBe(403);
    expect(await result.response.text()).toContain("Cross-site request rejected.");
  });

  test("Referer is used when Origin is absent: same origin passes", () => {
    expect(checkCsrf(req("POST", { ...SESSION, referer: `${APP}/page` })).ok).toBe(true);
  });

  test("Referer is used when Origin is absent: a foreign Referer is rejected", () => {
    const result = checkCsrf(req("POST", { ...SESSION, referer: "https://evil.example/x" }));
    expect(result.ok).toBe(false);
  });

  test("Origin wins over Referer", () => {
    const result = checkCsrf(
      req("POST", { ...SESSION, origin: "https://evil.example", referer: `${APP}/page` }),
    );
    expect(result.ok).toBe(false);
  });

  test("no Origin and no Referer with the session cookie is rejected as missing-origin", () => {
    const result = checkCsrf(req("POST", { ...SESSION }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.reason).toBe("missing-origin");
  });

  test("a POST without the session cookie passes whatever the origin", () => {
    expect(checkCsrf(req("POST", { origin: "https://evil.example" })).ok).toBe(true);
    expect(checkCsrf(req("POST", {})).ok).toBe(true);
  });

  test("the plain cookie name counts as the session cookie", () => {
    expect(checkCsrf(req("POST", { ...PLAIN_SESSION, origin: "https://evil.example" })).ok).toBe(
      false,
    );
  });

  test("a custom cookie name is the one that counts", () => {
    const headers = { cookie: "app_session=x", origin: "https://evil.example" };
    expect(checkCsrf(req("POST", headers)).ok).toBe(true);
    expect(checkCsrf(req("POST", headers), { cookieName: "app_session" }).ok).toBe(false);
  });

  test("GET, HEAD and OPTIONS pass with a foreign origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(checkCsrf(req(method, { ...SESSION, origin: "https://evil.example" })).ok).toBe(true);
    }
  });

  test("PUT, PATCH and DELETE are guarded too", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(checkCsrf(req(method, { ...SESSION, origin: "https://evil.example" })).ok).toBe(false);
      expect(checkCsrf(req(method, { ...SESSION, origin: APP })).ok).toBe(true);
    }
  });

  test("allowedOrigins admits another origin", () => {
    const headers = { ...SESSION, origin: "https://www.example.com" };
    expect(checkCsrf(req("POST", headers)).ok).toBe(false);
    expect(
      checkCsrf(req("POST", headers), { allowedOrigins: ["https://www.example.com"] }).ok,
    ).toBe(true);
  });

  test("allowedOrigins entries are origins, and a trailing slash is the same origin", () => {
    const headers = { ...SESSION, origin: "https://www.example.com" };
    expect(
      checkCsrf(req("POST", headers), { allowedOrigins: ["https://www.example.com/"] }).ok,
    ).toBe(true);
  });

  test("an allowedOrigins entry that is not an origin is a configuration error", () => {
    expect(() =>
      checkCsrf(req("POST", SESSION), { allowedOrigins: ["https://www.example.com/app"] }),
    ).toThrow(TypeError);
    expect(() => checkCsrf(req("POST", SESSION), { allowedOrigins: ["not a url"] })).toThrow(
      TypeError,
    );
  });

  test("the origin 'null' is rejected", () => {
    expect(checkCsrf(req("POST", { ...SESSION, origin: "null" })).ok).toBe(false);
  });

  test("a different scheme or port is a different origin", () => {
    expect(checkCsrf(req("POST", { ...SESSION, origin: "http://app.example.com" })).ok).toBe(false);
    expect(checkCsrf(req("POST", { ...SESSION, origin: "https://app.example.com:8443" })).ok).toBe(
      false,
    );
  });

  test("the request's own origin comes from its URL", () => {
    const request = req(
      "POST",
      { ...SESSION, origin: "http://localhost:3000" },
      "http://localhost:3000/api/x",
    );
    expect(checkCsrf(request).ok).toBe(true);
  });
});

describe("checkOrigin", () => {
  test("own origin passes, missing origin fails, foreign origin fails", () => {
    expect(checkOrigin(req("POST", { origin: APP }))).toEqual({ ok: true });
    expect(checkOrigin(req("POST", {}))).toEqual({ ok: false, reason: "missing-origin" });
    expect(checkOrigin(req("POST", { origin: "https://evil.example" }))).toEqual({
      ok: false,
      reason: "foreign-origin",
    });
  });

  test("an invalid Origin is foreign", () => {
    expect(checkOrigin(req("POST", { origin: "::not a url::" }))).toEqual({
      ok: false,
      reason: "foreign-origin",
    });
  });
});

// Upstream: tools/filesystem/internal/s3blob/s3/s3_test.go
// Upstream: tools/filesystem/internal/s3blob/s3/s3_escape_test.go
//
// TestS3URL and the escape cases compare the URL string S3.url builds, which
// is the request target the client gives fetch. TestS3SignAndSend stubs fetch
// for its requests, so the signed headers can be compared with the values
// upstream computes for the host example.com. TestEscapeQuery is not ported:
// escapeQuery only feeds the signature, which TestS3SignAndSend covers.

import { describe, expect, test } from "bun:test";

import { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";

const s3Config = {
  region: "test_region",
  bucket: "test_bucket",
  accessKey: "123",
  secretKey: "abc",
};

// a key is a URL path: "%", "#" and "?" are escaped so that url() reads them as
// data, not as the start of a query or fragment
function keyPath(goPath: string): string {
  return goPath.replace(/[%#?]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

describe("S3.url", () => {
  const path = "/test_key/a/b c@d?a=@1&b=!2#@a b c";

  // note: query params and fragments are kept as they are, since they are
  // later escaped if necessary by the HTTP client
  const expectedPath = "/test_key/a/b%20c%40d?a=@1&b=!2#@a b c";

  test.each([
    ["no schema", "example.com/", false, "https://test_bucket.example.com" + expectedPath],
    [
      "with https schema",
      "https://example.com/",
      false,
      "https://test_bucket.example.com" + expectedPath,
    ],
    [
      "with http schema",
      "http://example.com/",
      false,
      "http://test_bucket.example.com" + expectedPath,
    ],
    [
      "path style addressing (non-explicit schema)",
      "example.com/",
      true,
      "https://example.com/test_bucket" + expectedPath,
    ],
    [
      "path style addressing (explicit schema)",
      "http://example.com/",
      true,
      "http://example.com/test_bucket" + expectedPath,
    ],
  ])("%s", (_name, endpoint, usePathStyle, expected) => {
    const s3 = new S3({ ...s3Config, endpoint, usePathStyle });
    expect(s3.url(path)).toBe(expected);
  });
});

describe("S3.url path escaping", () => {
  // Go's escapePath input; the "?" and "#" in it are escaped as keys
  const goInput =
    "/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~ !@#$%^&*()+={}[]?><\\|,`'\"/@sub1/@sub2/a/b/c/1/2/3";

  test("escapes the path per the AWS UriEncode rules", () => {
    const expected =
      "/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~%20%21%40%23%24%25%5E%26%2A%28%29%2B%3D%7B%7D%5B%5D%3F%3E%3C%5C%7C%2C%60%27%22/%40sub1/%40sub2/a/b/c/1/2/3";

    const s3 = new S3({ ...s3Config, endpoint: "https://example.com/", usePathStyle: true });
    expect(s3.url(keyPath(goInput))).toBe("https://example.com/test_bucket" + expected);
  });
});

// Records the (url, init) pairs signAndSend hands to fetch and answers each
// with a response of its own. Restores the real fetch when the run ends.
async function withStubbedFetch<T>(
  run: () => Promise<T>,
): Promise<{ result: T; calls: { url: string; init: RequestInit }[] }> {
  const realFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("test_response");
  }) as unknown as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("S3.signAndSend", () => {
  // the Go test's request and signature values, for the host example.com
  const scenarios: {
    name: string;
    path: string;
    headers: Record<string, string>;
    accessKey: string;
    secretKey: string;
    url: string;
    expectedHeaders: Record<string, string>;
  }[] = [
    {
      name: "minimal",
      path: "/test",
      headers: { "x-amz-date": "20250102T150405Z" },
      accessKey: "123",
      secretKey: "abc",
      url: "https://test_bucket.example.com/test",
      expectedHeaders: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=123/20250102/test_region/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=ea093662bc1deef08dfb4ac35453dfaad5ea89edf102e9dd3b7156c9a27e4c1f",
        host: "test_bucket.example.com",
        "accept-encoding": "identity",
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        "x-amz-date": "20250102T150405Z",
      },
    },
    {
      name: "minimal with different access and secret keys",
      path: "/test",
      headers: { "x-amz-date": "20250102T150405Z" },
      accessKey: "456",
      secretKey: "def",
      url: "https://test_bucket.example.com/test",
      expectedHeaders: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=456/20250102/test_region/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=17510fa1f724403dd0a563b61c9b31d1d718f877fcbd75455620d17a8afce5fb",
        host: "test_bucket.example.com",
        "accept-encoding": "identity",
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        "x-amz-date": "20250102T150405Z",
      },
    },
    {
      name: "minimal with special characters",
      path: "/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -_.~!@&*():=$()?a=1&@b=@2#@a b c",
      headers: { "x-amz-date": "20250102T150405Z" },
      accessKey: "456",
      secretKey: "def",
      url: "https://test_bucket.example.com/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%20-_.~%21%40%26%2A%28%29%3A%3D%24%28%29?a=1&@b=@2#@a%20b%20c",
      expectedHeaders: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=456/20250102/test_region/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=9458a033554f52913801b3de16f54409b36ed25c6da3aed14e64439500e2c5e1",
        host: "test_bucket.example.com",
        "accept-encoding": "identity",
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        "x-amz-date": "20250102T150405Z",
      },
    },
    {
      name: "with extra headers",
      path: "/test",
      headers: {
        "x-amz-date": "20250102T150405Z",
        "x-amz-content-sha256": "test_sha256",
        "x-amz-example": "123",
        "x-amz-meta-a": "456",
        "content-type": "image/png",
        "accept-encoding": "custom",
        "x-test": "789",
      },
      accessKey: "123",
      secretKey: "abc",
      url: "https://test_bucket.example.com/test",
      expectedHeaders: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=123/20250102/test_region/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-example;x-amz-meta-a, Signature=86dccbcd012c33073dc99e9d0a9e0b717a4d8c11c37848cfa9a4a02716bc0db3",
        host: "test_bucket.example.com",
        "accept-encoding": "custom",
        "x-amz-date": "20250102T150405Z",
        "x-amz-content-sha256": "test_sha256",
        "x-amz-example": "123",
        "x-amz-meta-a": "456",
        "x-test": "789",
      },
    },
  ];

  for (const s of scenarios) {
    test(s.name, async () => {
      const s3 = new S3({
        ...s3Config,
        accessKey: s.accessKey,
        secretKey: s.secretKey,
        endpoint: "https://example.com/",
        usePathStyle: false,
      });

      const { result: resp, calls } = await withStubbedFetch(() =>
        s3.signAndSend({
          method: "GET",
          url: s3.url(s.path),
          headers: new Headers(s.headers),
          body: "test_request",
        }),
      );

      expect(calls).toHaveLength(1);
      const call = calls[0] as { url: string; init: RequestInit };
      expect(call.init.method).toBe("GET");
      expect(new URL(call.url).href).toBe(s.url);

      const sent = call.init.headers as Headers;
      for (const [name, value] of Object.entries(s.expectedHeaders)) {
        expect([name, sent.get(name)]).toEqual([name, value]);
      }

      expect(await resp.text()).toBe("test_response");
    });
  }
});

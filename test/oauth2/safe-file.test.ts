// Upstream: apis/record_auth_with_oauth2.go (safeHTTPClient, safeFileFromURL)
//
// The avatar download is a security boundary: the refusal of private
// addresses, the redirect limit, the timeout and the size limit. Upstream
// tests it only with one API scenario (a loopback avatar is not stored,
// ported in test/scenarios/record-auth-oauth2.ts). The refusals run with the
// production check; the cases that need a download replace it through
// SafeFileOptions, which only in-process callers can set, standing in for a
// public host. The name resolution is replaced the same way.

import { afterAll, describe, expect, test } from "bun:test";

import { DefaultMaxBodySize } from "@/middlewares/middlewares";
import { isAllowedAddress, safeFileFromURL } from "@/oauth2/safe-file";

// a test certificate for public.test, its only use is this file
const testCert = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUcI7umq3APc3uH105NqrEk5hEJWYwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLcHVibGljLnRlc3QwIBcNMjYxMDMxMDQ1NTU3WhgPMjEy
NjEwMDcwNDU1NTdaMBYxFDASBgNVBAMMC3B1YmxpYy50ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3tmCSMtIT8cDHDBZhfnLID7RqiMceUTEACFQ
wZDdc9EETVhtfmiGcpyvR7xNZT+isyDb56di9juBjYFoGQd//Tmt4/pgEC2Akz2K
+nrS++PhgnAkcGRIrPu82zQUs1XwPDTgeg4TgSzaFoj/7KbaQLGsOMk6g1guyHrm
ntZZH7NCVecNdLMBRbQA3NRvOvxqQtRGm7OcwvFQ1nwOgj2VcZdP6uOXTxBgZ4s7
AaNk+Lsvu1EMuHVP1QPJO8RoVvcPkF15gm24q1Qizr2vxtznwZTWe8J70pvVKcz/
o4Cofajmle9llHeIOXZuaOA55nsGT33mZAe3yhNfeSdBWOQuIQIDAQABo2swaTAd
BgNVHQ4EFgQUGi7yyTeNCgcoejloXk7HRbkjoyAwHwYDVR0jBBgwFoAUGi7yyTeN
CgcoejloXk7HRbkjoyAwDwYDVR0TAQH/BAUwAwEB/zAWBgNVHREEDzANggtwdWJs
aWMudGVzdDANBgkqhkiG9w0BAQsFAAOCAQEAAjH470EjV+HZu+hf/xs/OdCoWUiK
fQO/kgnDN71lhdwuTSNjCcvj6cQ53ecXpZTSLwPu4H9HMMXKaDnLlKrM2ATR4zzw
QD9oXULG4DzZHZ/NHv2f8KNqEUB8QnEAFHOQ0cq+9PRbw2Sau1dEKWNjTC8teY0j
6EV10MFRFO0Y22Sfyr9joBhOZKRWgHtxfCD+9ez4DY346v58ph9GYzN7OhewW8BJ
9rcFZaKeMmJUZpC99Q72D6P/kSUwLyCfjdLIVRIDcMlm1HLWxoRrpznwbD4M4NyB
9GKGeZ85aZulnG+3TWNpR+1d12m+01gVXiYWaSyu7nnQK10ZTsey6WYwwQ==
-----END CERTIFICATE-----
`;
const testKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDe2YJIy0hPxwMc
MFmF+csgPtGqIxx5RMQAIVDBkN1z0QRNWG1+aIZynK9HvE1lP6KzINvnp2L2O4GN
gWgZB3/9Oa3j+mAQLYCTPYr6etL74+GCcCRwZEis+7zbNBSzVfA8NOB6DhOBLNoW
iP/sptpAsaw4yTqDWC7Ieuae1lkfs0JV5w10swFFtADc1G86/GpC1Eabs5zC8VDW
fA6CPZVxl0/q45dPEGBnizsBo2T4uy+7UQy4dU/VA8k7xGhW9w+QXXmCbbirVCLO
va/G3OfBlNZ7wnvSm9UpzP+jgKh9qOaV72WUd4g5dm5o4DnmewZPfeZkB7fKE195
J0FY5C4hAgMBAAECggEAA959mTzZ5bRKma6kOBC3csXS1y2fYa9sm/HE7wUDhBTo
F0Pja/tHTeedanUt2DkHEeDOhWkRIIqb2MSOdZRjmwmpYXv4HYFj8IqA80R2wJoh
aowx/pD0xKrlPN52Kovuk39s7OmTWjeLyZh5oXBfLM1FtHTkv9S9qswcqdU5lgGH
zsrgLcWOI9l297tE+eUn3x9iuX856loffoPylZR31WPtYyivGz6rpH3xKOOdJNFm
zM3beoBDnpWwEGAQ5zn0SsW3x252xAVzYyrkOJCWaLNRYuYynz25qQ4EBi2GCWky
Eiu76iNMyZSn2b4DIgacc8zKJQVcyYE/A+I50zY1zQKBgQDv6shzP1y+0Zv2Z8Fq
phavXYC6YtoKUjw0L+rPrqfj+yAFhJ/TwDi2xJ0f8w9InIUjQ5XOyY9mn9tlfNhz
IKDJXJEIMAlGL7+/GM3GV3iuMG7B/9/wxsaEGdQMNf0pAh9dIgZv+RoD0zQ3GjTX
K6EVo4lNuIX/Fowa99eE/XZAXQKBgQDtydS8GmBB71nsjryfJL7+uP3Fxv7k9Wr6
3yRRkqdAFE1hfHGIpnW6rSL8+wiCz8DqxlncWuGy+Z/7KIMTCStgZVxX3WbBAY4Q
wRzJsC97nT82wbObOab4IUpd4Zh2nyJLiHM3ZickyO19msScth3hJSsW0SrxU4fe
3HGmgKgYlQKBgQDsdwoOnTr6UHpaCLWYOg9N1OjVzCx/08HG5huXiturVo6fIbKt
8F11tp/vJ4++z5ZhxXFYGU2fppuFkeF8x4HyNaw017OsW8+vt/DJNtmZRd9Ekr/T
/vcWqKZZSrU0wATNtIWHw4uijX5/ePLvyO7B9yeTVPWtEDoTMohXacIteQKBgHP8
cd76wp8GwAcqLIk35E3dMDOreCN4LiGGfHGpphkUjhYSHFL6VwyibSGW1TTxX3ll
HOnmDpc9ObLJtP2xCE5xwpQ9M2TLfF9hwsgCP3b9YZs06oW5nl8D5gFbDAI4ZwMO
4JxSIJ/JvkX5GxQRpQtwFM+BYX/rLaggQPNlaBjtAoGBANDZZAQYnJcnVO9abBby
wcBn4D1zf7kV4w9Dkn2mKx4289E8IQ/jvf03me9aZDc5br7+mC9BBruCQJ6vJo+0
l2saGqFLbewCpOxpFacaPpVvBlKWCbIlLxdIG9WNhpDQEPHM2xW7k25+IH1upN9e
T+wbpIac6SWRsjObNTt/nnEY
-----END PRIVATE KEY-----
`;

const pngPixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let hits: string[] = [];
let hosts: string[] = [];

function serve(fetch: (req: Request) => Response | Promise<Response>) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
}

const server = serve((req) => {
  const { pathname, searchParams } = new URL(req.url);
  hits.push(pathname);
  hosts.push(req.headers.get("host") ?? "");

  const match = /^\/hops\/([0-9]+)$/.exec(pathname);
  if (match) {
    const left = Number(match[1]);
    return left === 0
      ? new Response(pngPixel)
      : new Response(null, { status: 302, headers: { Location: `/hops/${left - 1}` } });
  }

  switch (pathname) {
    case "/avatar.png":
      return new Response(pngPixel);
    case "/to":
      return new Response(null, {
        status: Number(searchParams.get("status") ?? 302),
        headers: { Location: searchParams.get("url") ?? "" },
      });
    case "/status":
      return new Response("body", { status: Number(searchParams.get("status")) });
    case "/empty":
      return new Response(null, { status: 200 });
    case "/large":
      return new Response(new Uint8Array(DefaultMaxBodySize + 1024).fill(97));
    case "/slow":
      return new Promise<Response>(() => {}); // never answers
    default:
      return new Response("not found", { status: 404 });
  }
});

const base = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

// everything is a public address, except what the case refuses
const anyAddress = { isAllowedAddress: (): boolean => true };

describe("isAllowedAddress", () => {
  const refused = [
    // loopback
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    // unspecified
    "0.0.0.0",
    "::",
    // private
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "fc00::1",
    "fd12:3456::1",
    // link-local, the cloud metadata address among them
    "169.254.169.254",
    "fe80::1",
    // multicast
    "224.0.0.1",
    "239.1.1.1",
    "ff02::1",
    "ff0e::1",
    // IPv4-mapped forms of the above
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    // no address at all
    "",
    "localhost",
    "1.2.3",
    "fe80::1%eth0",
  ];
  for (const address of refused) {
    test(`refuses ${JSON.stringify(address)}`, () => {
      expect(isAllowedAddress(address)).toBe(false);
    });
  }

  // net.IP's checks leave these out, as upstream
  const allowed = [
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "100.64.0.1",
    "192.169.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ];
  for (const address of allowed) {
    test(`allows ${address}`, () => {
      expect(isAllowedAddress(address)).toBe(true);
    });
  }
});

describe("safeFileFromURL", () => {
  test("refuses a loopback server with the production check", async () => {
    hits = [];
    await expect(safeFileFromURL(`${base}/avatar.png`)).rejects.toThrow("disallowed");
    expect(hits).toEqual([]);
  });

  test("refuses a name that resolves to a private address", async () => {
    hits = [];
    await expect(
      safeFileFromURL(`http://public.test:${server.port}/avatar.png`, {
        lookupAddresses: () => Promise.resolve(["127.0.0.1"]),
      }),
    ).rejects.toThrow("disallowed");
    expect(hits).toEqual([]);
  });

  test("refuses localhost, resolved for real", async () => {
    await expect(safeFileFromURL(`http://localhost:${server.port}/avatar.png`)).rejects.toThrow(
      "disallowed",
    );
  });

  test("refuses IP literals in their other spellings", async () => {
    hits = [];
    for (const host of ["2130706433", "0x7f.1", "127.1", "[::1]", "[::ffff:127.0.0.1]"]) {
      await expect(safeFileFromURL(`http://${host}:${server.port}/a.png`)).rejects.toThrow();
    }
    expect(hits).toEqual([]);
  });

  test("connects to the checked address, with the name in the Host header", async () => {
    hosts = [];
    const checked: string[] = [];
    const file = await safeFileFromURL(`http://public.test:${server.port}/avatar.png`, {
      lookupAddresses: () => Promise.resolve(["127.0.0.1"]),
      isAllowedAddress: (address) => {
        checked.push(address);
        return true;
      },
    });
    expect(checked).toEqual(["127.0.0.1"]);
    expect(hosts).toEqual([`public.test:${server.port}`]);
    expect(file.size).toBe(pngPixel.length);
  });

  test("skips the refused addresses of a name", async () => {
    const file = await safeFileFromURL(`http://public.test:${server.port}/avatar.png`, {
      lookupAddresses: () => Promise.resolve(["10.0.0.1", "127.0.0.1"]),
      isAllowedAddress: (address) => address === "127.0.0.1",
    });
    expect(file.size).toBe(pngPixel.length);
  });

  test("goes on to the next address when one does not connect", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response() });
    const port = closed.port;
    await closed.stop(true);
    const relay = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response(pngPixel),
    });
    try {
      const file = await safeFileFromURL(`http://public.test:${port}/avatar.png`, {
        lookupAddresses: () => Promise.resolve(["127.0.0.2", "127.0.0.1"]),
        ...anyAddress,
      });
      expect(file.size).toBe(pngPixel.length);
    } finally {
      await relay.stop(true);
    }
  });

  test("refuses a redirect to a private address", async () => {
    hits = [];
    const target = encodeURIComponent("http://127.0.0.2/internal");
    await expect(
      safeFileFromURL(`${base}/to?url=${target}`, {
        isAllowedAddress: (address) => address === "127.0.0.1",
      }),
    ).rejects.toThrow("disallowed");
    expect(hits).toEqual(["/to"]);
  });

  test("refuses a redirect to a name that resolves to a private address", async () => {
    const target = encodeURIComponent("http://internal.test/secret");
    await expect(
      safeFileFromURL(`${base}/to?url=${target}`, {
        isAllowedAddress: (address) => address === "127.0.0.1",
        lookupAddresses: () => Promise.resolve(["10.1.2.3"]),
      }),
    ).rejects.toThrow("disallowed");
  });

  test("refuses a redirect to another scheme", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/a"]) {
      await expect(
        safeFileFromURL(`${base}/to?url=${encodeURIComponent(url)}`, anyAddress),
      ).rejects.toThrow("unsupported protocol scheme");
    }
  });

  test("refuses another scheme", async () => {
    await expect(safeFileFromURL("file:///etc/passwd", anyAddress)).rejects.toThrow(
      "unsupported protocol scheme",
    );
  });

  test("follows up to 9 redirects: 10 requests", async () => {
    hits = [];
    const file = await safeFileFromURL(`${base}/hops/9`, anyAddress);
    expect(file.size).toBe(pngPixel.length);
    expect(hits.length).toBe(10);
  });

  test("stops at the 10th redirect", async () => {
    hits = [];
    await expect(safeFileFromURL(`${base}/hops/10`, anyAddress)).rejects.toThrow(
      "stopped after 10 redirects",
    );
    expect(hits.length).toBe(10);
  });

  for (const status of [301, 303, 307, 308]) {
    test(`follows a ${status} redirect`, async () => {
      const file = await safeFileFromURL(
        `${base}/to?status=${status}&url=${encodeURIComponent("/avatar.png")}`,
        anyAddress,
      );
      expect(file.size).toBe(pngPixel.length);
    });
  }

  test("a 3xx without a Location is the response", async () => {
    const file = await safeFileFromURL(`${base}/status?status=300`, anyAddress);
    expect(file.size).toBe(4);
  });

  for (const status of [400, 404, 500]) {
    test(`fails on status ${status}`, async () => {
      await expect(safeFileFromURL(`${base}/status?status=${status}`, anyAddress)).rejects.toThrow(
        `(${status})`,
      );
    });
  }

  test("fails on an empty body", async () => {
    await expect(safeFileFromURL(`${base}/empty`, anyAddress)).rejects.toThrow(
      "cannot create an empty file",
    );
  });

  test("gives up after the timeout", async () => {
    await expect(
      safeFileFromURL(`${base}/slow`, { ...anyAddress, timeoutMs: 50 }),
    ).rejects.toThrow();
  });

  test("keeps only DefaultMaxBodySize of the body", async () => {
    const file = await safeFileFromURL(`${base}/large`, anyAddress);
    expect(file.size).toBe(DefaultMaxBodySize);
  });

  test("names the file after the base of the url", async () => {
    const file = await safeFileFromURL(`${base}/avatar.png`, anyAddress);
    expect(file.originalName).toBe("avatar.png");
    expect(file.name).toMatch(/^avatar_[a-z0-9]{10}\.png$/);
  });
});

const lookupAddresses = (): Promise<string[]> => Promise.resolve(["127.0.0.1"]);

describe("safeFileFromURL over TLS", () => {
  const tlsServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: testCert, key: testKey },
    fetch: () => new Response(pngPixel),
  });

  afterAll(() => tlsServer.stop(true));

  test("verifies the certificate against the name, not the address", async () => {
    const file = await safeFileFromURL(`https://public.test:${tlsServer.port}/avatar.png`, {
      ...anyAddress,
      lookupAddresses,
      ca: testCert,
    });
    expect(file.size).toBe(pngPixel.length);
  });

  test("refuses a certificate of another name", async () => {
    await expect(
      safeFileFromURL(`https://other.test:${tlsServer.port}/avatar.png`, {
        ...anyAddress,
        lookupAddresses,
        ca: testCert,
      }),
    ).rejects.toThrow();
  });

  test("refuses an untrusted certificate", async () => {
    await expect(
      safeFileFromURL(`https://public.test:${tlsServer.port}/avatar.png`, {
        ...anyAddress,
        lookupAddresses,
      }),
    ).rejects.toThrow();
  });
});

// Upstream: apis/file_test.go (TestFileToken, TestFileDownload)
//
// The tokens are upstream's fixture tokens (test/fixtures/pocketbase,
// expiring in 2050): test data, not credentials.
//
// Not ported:
// - TestFileToken "hook token overwrite": it only tests the upstream hook
//   OnFileTokenRequest.
// - The ExpectedEvents of every scenario (hook counts), and the
//   BeforeTestFunc hooks of the thumb scenarios that only assert
//   e.ThumbError through OnFileDownloadRequest. Those ThumbError checks
//   are hook-only and dropped; the response checks of those scenarios stay.
// - TestConcurrentThumbsGeneration is not a request table. It is ported
//   elsewhere, not in this file.
//
// Go's ExpectedContent holds raw file bytes. Here the expectedContent is a
// UTF-8 substring ("PNG" or "test"), and `after` checks that the body is
// byte-for-byte the fixture file (bodyIsFile). Go's `BeforeTestFunc` steps
// that change the collection or settings become `prepare` steps.
//
// Each TestFileDownload scenario also runs as a HEAD request, as in the
// Go loop (withHead): the body must be empty.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fixtureDir } from "@test/scenarios/fixture";
import { setRateLimits, updateCollection } from "@test/scenarios/prepare";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { AfterContext, Scenario, Suite } from "@test/scenarios/scenario";
import { setupWhitelist } from "@test/scenarios/settings-prepare";

// Checks that the body is the fixture file at storage/<relPath>
// (the Go tests compare the body with os.ReadFile of the same file).
function bodyIsFile(relPath: string): (result: AfterContext) => void {
  return ({ body }) => {
    const expected = readFileSync(join(fixtureDir, "storage", relPath));
    if (!Buffer.from(body).equals(expected)) {
      throw new Error(
        `response body is not storage/${relPath} (got ${body.length} bytes, expected ${expected.length})`,
      );
    }
  };
}

// Each scenario gets a HEAD clone first, as the Go loop does: the same
// name with "(HEAD) " in front, no expected content and no body check.
function withHead(scenarios: Scenario[]): Scenario[] {
  return scenarios.flatMap((scenario) => {
    const head: Scenario = {
      ...scenario,
      name: `(HEAD) ${scenario.name}`,
      method: "HEAD",
    };
    delete head.expectedContent;
    delete head.after;
    return [head, scenario];
  });
}

const notFound = [`"data":{}`];

export const fileToken: Suite = {
  file: "apis/file_test.go",
  func: "TestFileToken",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/files/token",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "regular user",
      method: "POST",
      url: "/api/files/token",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [`"token":"`],
    },
    {
      name: "superuser",
      method: "POST",
      url: "/api/files/token",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"token":"`],
    },
  ],
};

const usersAuthFile = "_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png";
const usersAuthThumb = "_pb_users_auth_/4q1xlclmfloku33/thumbs_300_1SEi6Q6U72.png";
const demo1File = "wsmn24bux7wo113/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png";

export const fileDownload: Suite = {
  file: "apis/file_test.go",
  func: "TestFileDownload",
  scenarios: withHead([
    {
      name: "missing collection",
      method: "GET",
      url: "/api/files/missing/4q1xlclmfloku33/300_1SEi6Q6U72.png",
      expectedStatus: 404,
      expectedContent: notFound,
    },
    {
      name: "missing record",
      method: "GET",
      url: "/api/files/_pb_users_auth_/missing/300_1SEi6Q6U72.png",
      expectedStatus: 404,
      expectedContent: notFound,
    },
    {
      name: "missing file",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/missing.png",
      expectedStatus: 404,
      expectedContent: notFound,
    },
    {
      name: "existing image",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(usersAuthFile),
    },
    {
      name: "existing image - missing thumb (should fallback to the original)",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png?thumb=999x999",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(usersAuthFile),
    },
    {
      name: "existing image - existing thumb (crop center)",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png?thumb=70x50",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(`${usersAuthThumb}/70x50_300_1SEi6Q6U72.png`),
    },
    {
      name: "existing image - existing thumb (crop top)",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png?thumb=70x50t",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(`${usersAuthThumb}/70x50t_300_1SEi6Q6U72.png`),
    },
    {
      name: "existing image - existing thumb (crop bottom)",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png?thumb=70x50b",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(`${usersAuthThumb}/70x50b_300_1SEi6Q6U72.png`),
    },
    {
      name: "existing image - existing thumb (fit)",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png?thumb=70x50f",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(`${usersAuthThumb}/70x50f_300_1SEi6Q6U72.png`),
    },
    {
      name: "existing image - existing thumb (zero width)",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png?thumb=0x50",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(`${usersAuthThumb}/0x50_300_1SEi6Q6U72.png`),
    },
    {
      name: "existing image - existing thumb (zero height)",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png?thumb=70x0",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(`${usersAuthThumb}/70x0_300_1SEi6Q6U72.png`),
    },
    {
      name: "existing non image file - thumb parameter should be ignored",
      method: "GET",
      url: "/api/files/_pb_users_auth_/oap640cot4yru2s/test_kfd2wYLxkz.txt?thumb=100x100",
      expectedStatus: 200,
      expectedContent: ["test"],
      after: bodyIsFile("_pb_users_auth_/oap640cot4yru2s/test_kfd2wYLxkz.txt"),
    },

    // protected file access checks
    {
      name: "protected file - superuser with expired file token",
      method: "GET",
      url: "/api/files/demo1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MTY0MDk5MTY2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.nqqtqpPhxU0045F4XP_ruAkzAidYBc5oPy9ErN3XBq0",
      expectedStatus: 404,
      expectedContent: notFound,
    },
    {
      name: "protected file - superuser with valid file token",
      method: "GET",
      url: "/api/files/demo1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc",
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(demo1File),
    },
    {
      name: "protected file - superuser with non-whitelisted IP",
      method: "GET",
      url: "/api/files/demo1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc",
      headers: { "x-test-ip": "127.0.0.1" },
      prepare: setupWhitelist("0.0.0.0"),
      expectedStatus: 404,
      expectedContent: notFound,
    },
    {
      name: "protected file - superuser with whitelisted IP",
      method: "GET",
      url: "/api/files/demo1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc",
      headers: { "x-test-ip": "127.0.0.1" },
      prepare: setupWhitelist("127.0.0.1"),
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(demo1File),
    },
    {
      name: "protected file - guest without view access",
      method: "GET",
      url: "/api/files/demo1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png",
      expectedStatus: 404,
      expectedContent: notFound,
    },
    {
      name: "protected file - guest with view access",
      method: "GET",
      url: "/api/files/demo1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png",
      // mock public view access
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo1", (c) => {
          c.viewRule = "";
        }),
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(demo1File),
    },
    {
      name: "protected file - auth record without view access",
      method: "GET",
      url: "/api/files/demo1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8ifQ.nSTLuCPcGpWn2K2l-BFkC3Vlzc-ZTDPByYq8dN1oPSo",
      // mock restricted user view access
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo1", (c) => {
          c.viewRule = "@request.auth.verified = true";
        }),
      expectedStatus: 404,
      expectedContent: notFound,
    },
    {
      name: "protected file - auth record with view access",
      method: "GET",
      url: "/api/files/demo1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8ifQ.nSTLuCPcGpWn2K2l-BFkC3Vlzc-ZTDPByYq8dN1oPSo",
      // mock user view access
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo1", (c) => {
          c.viewRule = "@request.auth.verified = false";
        }),
      expectedStatus: 200,
      expectedContent: ["PNG"],
      after: bodyIsFile(demo1File),
    },
    {
      name: "protected file in view (view's View API rule failure)",
      method: "GET",
      url: "/api/files/view1/al1h9ijdeojtsjy/300_Jsjq7RdBgA.png?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8ifQ.nSTLuCPcGpWn2K2l-BFkC3Vlzc-ZTDPByYq8dN1oPSo",
      expectedStatus: 404,
      expectedContent: notFound,
    },
    {
      name: "protected file in view (view's View API rule success)",
      method: "GET",
      url: "/api/files/view1/84nmscqy84lsi1t/test_d61b33QdDU.txt?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8ifQ.nSTLuCPcGpWn2K2l-BFkC3Vlzc-ZTDPByYq8dN1oPSo",
      expectedStatus: 200,
      expectedContent: ["test"],
      after: bodyIsFile("wsmn24bux7wo113/84nmscqy84lsi1t/test_d61b33QdDU.txt"),
    },

    // rate limit checks
    {
      name: "RateLimit rule - users:file",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png",
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 100, label: "*:file" },
          { maxRequests: 0, label: "users:file" },
        ]),
      pending: {
        task: "M4.8",
        reason: "checkCollectionRateLimit and the settings rate limit rules",
      },
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
    {
      name: "RateLimit rule - *:file",
      method: "GET",
      url: "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png",
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 0, label: "*:file" },
        ]),
      pending: {
        task: "M4.8",
        reason: "checkCollectionRateLimit and the settings rate limit rules",
      },
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
  ]),
};

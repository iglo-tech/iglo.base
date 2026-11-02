// Upstream: apis/middlewares_test.go (TestSuperuserIPsWhitelist)
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).
// Upstream's scenarios add a custom route `/my/test` answering "test123";
// custom routes are a deliberate difference (no extension surface), so the
// requests go to `/api/health` instead, which every identity may call and
// which runs through the same default middlewares. Its "API is healthy."
// body stands for "test123". setupWhitelist stores the settings in the
// fixture copy, as upstream's app.Save(app.Settings()) does.
//
// The x-test-ip header is the configured trusted proxy header, so RealIP
// is the header's IP (127.0.0.1, also the remote address of these
// requests).
//
// TestPanicRecover is not ported: its routes, which panic, are custom
// routes (no extension surface). test/apis/base.test.ts checks the
// panicRecover middleware on an internal test route.

import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { Suite } from "@test/scenarios/scenario";
import { setupWhitelist } from "@test/scenarios/settings-prepare";

export const superuserIPsWhitelist: Suite = {
  file: "apis/middlewares_test.go",
  func: "TestSuperuserIPsWhitelist",
  scenarios: [
    {
      name: "guest with non-matching IP",
      method: "GET",
      url: "/api/health",
      headers: { "x-test-ip": "127.0.0.1" },
      prepare: setupWhitelist("0.0.0.0"),
      expectedStatus: 200,
      expectedContent: ["API is healthy."],
    },
    {
      name: "regular user with non-matching IP",
      method: "GET",
      url: "/api/health",
      headers: { "x-test-ip": "127.0.0.1", Authorization: usersToken },
      prepare: setupWhitelist("0.0.0.0"),
      expectedStatus: 200,
      expectedContent: ["API is healthy."],
    },
    {
      name: "superuser with non-matching IP",
      method: "GET",
      url: "/api/health",
      headers: { "x-test-ip": "127.0.0.1", Authorization: superuserToken },
      prepare: setupWhitelist("0.0.0.0"),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superuser with matching IP",
      method: "GET",
      url: "/api/health",
      headers: { "x-test-ip": "127.0.0.1", Authorization: superuserToken },
      prepare: setupWhitelist("0.0.0.0", "127.0.0.1"),
      expectedStatus: 200,
      expectedContent: ["API is healthy."],
    },
    {
      name: "superuser with no whitelisted IPs",
      method: "GET",
      url: "/api/health",
      headers: { "x-test-ip": "127.0.0.1", Authorization: superuserToken },
      prepare: setupWhitelist(),
      expectedStatus: 200,
      expectedContent: ["API is healthy."],
    },
  ],
};

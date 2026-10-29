// Upstream: apis/health_test.go
//
// The tokens are upstream's fixture tokens (test/fixtures/pocketbase,
// expiring in 2050): test data, not credentials.

import type { Suite } from "@test/scenarios/scenario";

export const healthAPI: Suite = {
  file: "apis/health_test.go",
  func: "TestHealthAPI",
  scenarios: [
    {
      name: "GET health status (guest)",
      method: "GET", // automatically matches also HEAD as a side-effect of the Go std mux
      url: "/api/health",
      expectedStatus: 200,
      expectedContent: [`"code":200`, `"data":{}`],
      notExpectedContent: ["canBackup", "realIP", "possibleProxyHeader"],
    },
    {
      name: "GET health status (regular user)",
      method: "GET",
      url: "/api/health",
      headers: {
        Authorization:
          "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo",
      },
      expectedStatus: 200,
      expectedContent: [`"code":200`, `"data":{}`],
      notExpectedContent: ["canBackup", "realIP", "possibleProxyHeader"],
    },
    {
      name: "GET health status (superuser)",
      method: "GET",
      url: "/api/health",
      headers: {
        Authorization:
          "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY",
      },
      expectedStatus: 200,
      expectedContent: [
        `"code":200`,
        `"data":{`,
        `"canBackup":true`,
        `"realIP"`,
        `"possibleProxyHeader"`,
      ],
    },
  ],
};

// Upstream: tests/api.go (ApiScenario)
//
// The scenario format for upstream's API table tests. Each scenario runs
// against iglo.base alone with upstream's expectations (plain `bun test`,
// test/scenarios/scenarios.test.ts) and against upstream v0.41.0 and
// iglo.base side by side (`bun run test:reference`,
// test/differential/scenarios.test.ts). Both modes give every server its own
// fresh copy of the fixture, as upstream's NewTestApp does.
//
// ApiScenario's ExpectedEvents (hook counts) are dropped: iglo.base has no
// hooks. TestAppFactory and BeforeTestFunc become `prepare`, AfterTestFunc
// becomes `after`. DisableTestAppCleanup has no counterpart: the runners
// own the fixture copies and always remove them.
//
// This format is a shared contract (docs/design/12-work-plan.md); changes
// to it go through the lead.

// The "Area" column of docs/design/04-api-compatibility.md's Deliberate
// differences table, verbatim.
export type DeliberateDifference =
  | "Custom routes from hooks or Go"
  | "Hook side effects"
  | "GET /_/extensions.js"
  | "GET /_/extensions/{name}/*"
  | "GET /api/crons"
  | "Logs `data`"
  | "`Server`-identifying output (`serve` banner, `--version`)"
  | "`update` command"
  | "Request paths with `.` or `..` segments (also `%2e%2e`) or `\\`"
  | "Repeated request header lines";

export interface Expectations {
  // ExpectedStatus
  expectedStatus: number;
  // ExpectedContent: substrings that must be in the response body, after
  // the JSON normalization of tests/api.go
  expectedContent?: string[];
  // NotExpectedContent: substrings that must not be in the response body.
  // With neither list set, the body must be empty.
  notExpectedContent?: string[];
}

export interface PrepareContext {
  // the scenario's copy of the fixture, before any server starts on it
  dataDir: string;
}

export interface AfterContext {
  // the server that answered; it is still running
  url: string;
  // its pb_data directory
  dataDir: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface Scenario extends Expectations {
  // Name, verbatim from the Go file, so the scenario can be found there
  name: string;
  // Method
  method: string;
  // URL: the request target, sent exactly as written
  url: string;
  // Body
  body?: string | Uint8Array;
  // Headers. As in tests/api.go, every request also gets
  // `content-type: application/json` unless it sets its own, and values
  // are trimmed.
  headers?: Record<string, string>;
  // Delay: wait this long after the response before checking it and
  // running `after`
  delayMs?: number;
  // Timeout: upstream cancels the request context after this long. Here
  // the runner stops reading the response then and checks the status,
  // headers and the body bytes received so far.
  timeoutMs?: number;
  // TestAppFactory and BeforeTestFunc: changes the fixture copy before
  // the servers start on it. Runs once per scenario; in differential mode
  // both servers then start on copies of the prepared directory.
  prepare?: (fixture: PrepareContext) => void | Promise<void>;
  // AfterTestFunc: more checks through public boundaries (HTTP, files on
  // disk). Throws to fail. Runs for every server the scenario runs on.
  after?: (result: AfterContext) => void | Promise<void>;
  // iglo.base cannot pass this scenario yet. It still runs and must fail;
  // once it passes, its test fails until the task removes the marker.
  pending?: { task: string; reason: string };
  // iglo.base answers differently on purpose. Upstream is still checked
  // against the scenario's expectations; iglo.base is checked against
  // `igloBase` instead, and the two responses are not compared.
  difference?: { name: DeliberateDifference; igloBase: Expectations };
}

// The scenarios of one Go test function.
export interface Suite {
  // the Go test file and function, e.g. apis/health_test.go, TestHealthAPI
  file: string;
  func: string;
  scenarios: Scenario[];
}

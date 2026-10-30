// bun run fuzz:filters -- --seed <n> --cases <n> [--first <n>]
//                         [--max-failures <n>] [--case <n>]
//
// --case replays one case: it prints the request and both answers.

import { parseArgs } from "node:util";

import { runCase, requestPath } from "@test/differential/fuzz/compare";
import { generateCase } from "@test/differential/fuzz/generate";
import { formatFailure, formatReport, runFuzz } from "@test/differential/fuzz/run";
import { startFuzzServers } from "@test/differential/fuzz/servers";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    cases: { type: "string", default: "1000" },
    first: { type: "string", default: "0" },
    case: { type: "string" },
    "max-failures": { type: "string", default: "40" },
  },
});

const seed = Number(values.seed);
const servers = await startFuzzServers();
let exitCode = 0;
try {
  if (values.case !== undefined) {
    const c = generateCase(servers.model, seed, Number(values.case));
    const result = await runCase(servers, c);
    console.log(`token ${c.who}\n${requestPath(c)}\n${decodeURIComponent(requestPath(c))}`);
    console.log(`upstream: ${JSON.stringify(result.up)}`);
    console.log(`iglo.base: ${JSON.stringify(result.ig)}`);
    console.log(`difference: ${JSON.stringify(result.difference)}`);
    exitCode = result.difference === null ? 0 : 1;
  } else {
    const report = await runFuzz(servers, {
      seed,
      cases: Number(values.cases),
      first: Number(values.first),
      maxFailures: Number(values["max-failures"]),
      log: console.log,
    });
    console.log(formatReport(report));
    for (const failure of report.failures) {
      console.log(formatFailure(failure));
    }
    exitCode = report.failures.length === 0 ? 0 : 1;
  }
} finally {
  await servers.stop();
}
process.exit(exitCode);

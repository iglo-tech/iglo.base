// A fuzz run: generates the cases, sends each to both servers at a bounded
// concurrency, retries clock-dependent differences once, shrinks the rest and
// keeps a bounded number of distinct failures.

import {
  type CaseResult,
  holdsEveryMatch,
  type ListBody,
  orderIsTotal,
  requestPath,
  runCase,
  sortText,
} from "@test/differential/fuzz/compare";
import { exclusions } from "@test/differential/fuzz/exclusions";
import { printFilter } from "@test/differential/fuzz/filter-ast";
import { type FuzzCase, generateCase } from "@test/differential/fuzz/generate";
import type { FuzzServers } from "@test/differential/fuzz/servers";
import { shrinkCase } from "@test/differential/fuzz/shrink";

// the brief's limit: at most 4 requests per server
export const concurrency = 4;

export interface Failure {
  signature: string;
  seed: number;
  n: number;
  who: string;
  url: string;
  kind: string;
  detail: string;
  shrunkUrl: string;
  shrunkDetail: string;
  shrunkWho: string;
  count: number;
}

export interface Report {
  seed: number;
  cases: number;
  seconds: number;
  statuses: Map<string, number>;
  who: Map<string, number>;
  tags: Map<string, number>;
  compared: Map<string, number>;
  empty: number;
  nonEmpty: number;
  invalid: number;
  clockRetries: number;
  clockFlips: number;
  excluded: Map<string, number>;
  failures: Failure[];
  // failures past the bound of distinct ones
  unrecorded: number;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// the shape of a filter: what is left when the values are gone
function shapeOf(c: FuzzCase): string {
  const filter = c.filter === null ? "" : printFilter(c.filter);
  return filter
    .replaceAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "S")
    .replaceAll(/-?\d+(\.\d+)?/g, "N")
    .replaceAll(/\s+/g, " ")
    .slice(0, 200);
}

function comparedAs(c: FuzzCase, result: CaseResult): string {
  if (result.up?.status !== 200) {
    return "error body";
  }
  if (orderIsTotal(c)) {
    return "ids in order";
  }
  const list = result.up.body as ListBody;
  return holdsEveryMatch(list) ? "id set" : "page size";
}

export function formatFailure(f: Failure): string {
  return [
    `DIFFERENCE ${f.kind} (seen ${f.count} time${f.count === 1 ? "" : "s"})`,
    `  seed ${f.seed} case ${f.n} token ${f.who}`,
    `  replay: bun run fuzz:filters -- --seed ${f.seed} --case ${f.n}`,
    `  url: ${f.url}`,
    `  detail: ${f.detail.slice(0, 600)}`,
    `  minimized (token ${f.shrunkWho}): ${f.shrunkUrl}`,
    `  decoded: ${decodeURIComponent(f.shrunkUrl)}`,
    `  minimized detail: ${f.shrunkDetail.slice(0, 600)}`,
  ].join("\n");
}

export async function checkCase(
  servers: FuzzServers,
  c: FuzzCase,
): Promise<{ result: CaseResult; clockFlip: boolean }> {
  const result = await runCase(servers, c);
  if (result.difference !== null && c.timeDependent) {
    const again = await runCase(servers, c);
    return { result: again, clockFlip: again.difference === null };
  }
  return { result, clockFlip: false };
}

export interface RunOptions {
  seed: number;
  cases: number;
  first?: number;
  maxFailures?: number;
  log?: (line: string) => void;
}

export async function runFuzz(servers: FuzzServers, options: RunOptions): Promise<Report> {
  const { seed, cases } = options;
  const first = options.first ?? 0;
  const maxFailures = options.maxFailures ?? 40;
  const log = options.log ?? (() => {});
  const report: Report = {
    seed,
    cases,
    seconds: 0,
    statuses: new Map(),
    who: new Map(),
    tags: new Map(),
    compared: new Map(),
    empty: 0,
    nonEmpty: 0,
    invalid: 0,
    clockRetries: 0,
    clockFlips: 0,
    excluded: new Map(),
    failures: [],
    unrecorded: 0,
  };
  const started = performance.now();
  const signatures = new Map<string, Failure>();
  let next = first;
  let transportErrors = 0;

  const recordFailure = async (c: FuzzCase, result: CaseResult): Promise<void> => {
    const difference = result.difference;
    if (difference === null) {
      return;
    }
    const shrunk = await shrinkCase(c, async (candidate) => {
      const { result: r } = await checkCase(servers, candidate);
      return r.difference?.kind === difference.kind;
    });
    const again = await runCase(servers, shrunk);
    const signature = `${difference.kind} ${result.up?.status}/${result.ig?.status} ${shapeOf(shrunk)} sort=${sortText(shrunk)}`;
    const known = signatures.get(signature);
    if (known !== undefined) {
      known.count++;
      return;
    }
    if (signatures.size >= maxFailures) {
      report.unrecorded++;
      return;
    }
    const failure: Failure = {
      signature,
      seed,
      n: c.n,
      who: c.who,
      url: requestPath(c),
      kind: difference.kind,
      detail: difference.detail,
      shrunkUrl: requestPath(shrunk),
      shrunkDetail: again.difference?.detail ?? "(no difference on the last run)",
      shrunkWho: shrunk.who,
      count: 1,
    };
    signatures.set(signature, failure);
    report.failures.push(failure);
    log(formatFailure(failure));
  };

  const worker = async (): Promise<void> => {
    while (next < first + cases && transportErrors < 20) {
      const n = next++;
      const c = generateCase(servers.model, seed, n);
      const { result, clockFlip } = await checkCase(servers, c);
      if (c.timeDependent) {
        report.clockRetries += clockFlip || result.difference !== null ? 1 : 0;
      }
      if (clockFlip) {
        report.clockFlips++;
      }
      bump(report.statuses, String(result.up?.status ?? "none"));
      bump(report.who, c.who);
      bump(report.compared, comparedAs(c, result));
      for (const tag of c.tags) {
        bump(report.tags, tag);
      }
      if (c.invalid) {
        report.invalid++;
      }
      if (result.up?.status === 200) {
        if ((result.up.body as { items: unknown[] }).items.length === 0) {
          report.empty++;
        } else {
          report.nonEmpty++;
        }
      }
      const { difference } = result;
      if (difference === null) {
        continue;
      }
      if (difference.kind === "transport") {
        transportErrors++;
      }
      const exclusion = exclusions.find((e) => e.applies(c, difference, result.up, result.ig));
      if (exclusion !== undefined) {
        bump(report.excluded, exclusion.name);
        continue;
      }
      await recordFailure(c, result);
    }
  };

  const progress = setInterval(() => {
    log(
      `... case ${next - first}/${cases}, ${report.failures.length} distinct failures, ${Math.round((performance.now() - started) / 1000)} s`,
    );
  }, 60_000);
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    clearInterval(progress);
  }
  report.seconds = (performance.now() - started) / 1000;
  return report;
}

function table(map: Map<string, number>): string {
  return [...map]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n");
}

export function formatReport(report: Report): string {
  return [
    `seed ${report.seed}, ${report.cases} cases, ${Math.round(report.seconds)} s`,
    `statuses (upstream):\n${table(report.statuses)}`,
    `tokens:\n${table(report.who)}`,
    `compared as:\n${table(report.compared)}`,
    `lists: ${report.nonEmpty} with records, ${report.empty} empty; invalid cases ${report.invalid}`,
    `clock-dependent cases retried: ${report.clockRetries}, cleared by the retry: ${report.clockFlips}`,
    `forms:\n${table(report.tags)}`,
    `excluded:\n${table(report.excluded) || "  none"}`,
    `distinct failures: ${report.failures.length}${report.unrecorded > 0 ? ` (+${report.unrecorded} past the bound)` : ""}`,
  ].join("\n");
}

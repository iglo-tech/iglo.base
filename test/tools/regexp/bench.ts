// matchString time for upstream-like patterns on 16 B, 1 KiB and 64 KiB
// inputs, each pattern compiled once (docs/perf/regexp.md). Not a test:
// run `bun test/tools/regexp/bench.ts`.

import { compile } from "@/tools/regexp/regexp";

// the first 50 words of Go's TestProgramTooLongForBacktrack pattern
const words = (
  "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen " +
  "sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour " +
  "twentyfive twentysix twentyseven twentyeight twentynine thirty thirtyone thirtytwo " +
  "thirtythree thirtyfour thirtyfive thirtysix thirtyseven thirtyeight thirtynine forty " +
  "fortyone fortytwo fortythree fortyfour fortyfive fortysix fortyseven fortyeight fortynine fifty"
).split(" ");

// deterministic lowercase text with spaces and digits, without the
// letters o, t, f, s, e and n, so no word of the alternation occurs
function text(n: number): string {
  let x = 0x2545f491;
  let out = "";
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += "abcdghijklmpqruvwxyz0123456789 "[(x >>> 0) % 31];
  }
  return out;
}

function word(n: number): string {
  return "a1_B".repeat(n / 4);
}

interface benchCase {
  name: string;
  pattern: string;
  input: (n: number) => string;
  note: string;
}

const cases: benchCase[] = [
  {
    name: "email-like",
    pattern: String.raw`^[\w.+-]+@[\w-]+(\.[\w-]+)+$`,
    input: (n) => word(n - 12) + "@example.com",
    note: "matches (local part grows)",
  },
  {
    name: String.raw`^\w+$`,
    pattern: String.raw`^\w+$`,
    input: word,
    note: "matches",
  },
  {
    name: "^[a-z0-9]{15}$",
    pattern: "^[a-z0-9]{15}$",
    input: (n) => "a".repeat(n),
    note: "16th byte rejects",
  },
  {
    name: "50-alternation",
    pattern: `(${words.join("|")})`,
    input: text,
    note: "unanchored, no match",
  },
  {
    name: "50-alternation, anchored",
    pattern: `^(${words.join("|")})$`,
    input: text,
    note: "no match",
  },
];

const sizes = [16, 1024, 64 * 1024];

function measure(fn: () => void): number {
  // warm up, then repeat until 200 ms have passed; ms per call
  for (let i = 0; i < 5; i++) {
    fn();
  }
  let n = 0;
  const start = performance.now();
  let now = start;
  while (now - start < 200) {
    fn();
    n++;
    now = performance.now();
  }
  return (now - start) / n;
}

function format(ms: number): string {
  if (ms < 0.001) {
    return `${(ms * 1e6).toFixed(0)} ns`;
  }
  if (ms < 1) {
    return `${(ms * 1000).toFixed(1)} µs`;
  }
  return `${ms.toFixed(2)} ms`;
}

console.log(
  `| Pattern | Input | ${sizes.map((s) => (s < 1024 ? `${s} B` : `${s / 1024} KiB`)).join(" | ")} |`,
);
console.log(`|---|---|${sizes.map(() => "---:").join("|")}|`);
for (const c of cases) {
  const re = compile(c.pattern);
  const cells = sizes.map((size) => {
    const s = c.input(size);
    return format(measure(() => re.matchString(s)));
  });
  console.log(`| \`${c.name}\` | ${c.note} | ${cells.join(" | ")} |`);
}

# M1.1b Go regexp matching: baseline

First implementation of `src/tools/regexp` matching (Go's regexp on the M1.1a parser), so there is no "before". Regexp runs on the record write path through text and password field patterns; later changes compare against these numbers, measured the same way.

## Setup

| | |
|---|---|
| Date | 2026-10-28 |
| Machine | AMD Ryzen 5 1600 (6 cores), 16 GiB RAM, Linux 6.12 (Debian 13), VM |
| Bun | 1.4.4 |
| Commit | `task/M1.1b-regexp` |

## Method

`bun test/tools/regexp/bench.ts`, run with `nice -n 10` while the host was otherwise idle. Each pattern is compiled once with `compile`; each cell is the mean time of one `matchString(input)` call, repeated for 200 ms after a warm-up. The time includes encoding the JS string to UTF-8 bytes, which every call does.

- **email-like:** `^[\w.+-]+@[\w-]+(\.[\w-]+)+$` on `a1_B…a1_B@example.com` (matches; the local part fills the input).
- **`^\w+$`:** on `a1_B` repeated (matches).
- **`^[a-z0-9]{15}$`:** on `a` repeated; the 16th byte rejects, so the larger inputs measure the call and the encoding.
- **50-alternation:** the first 50 words of Go's `TestProgramTooLongForBacktrack` pattern (`one|two|…|fifty`) in a capture group, unanchored, on deterministic text without the letters o, t, f, s, e and n (no match, every position is tried). Also anchored (`^(…)$`), which rejects at the first byte.

The first four patterns and the anchored alternation compile to one-pass programs (Go's `onepass.go`, ported); the unanchored alternation runs on the NFA (`exec.go`). Go's backtracker (`backtrack.go`) is not ported: it gives the same results and the NFA stays under 1 ms per match at 1 KiB.

## Results

Two runs; the second in parentheses.

| Pattern | Input | 16 B | 1 KiB | 64 KiB |
|---|---|---:|---:|---:|
| email-like | matches | 0.85 µs (1.3 µs) | 34.9 µs (39.3 µs) | 2.21 ms (2.40 ms) |
| `^\w+$` | matches | 0.75 µs (0.88 µs) | 28.6 µs (33.4 µs) | 1.81 ms (2.03 ms) |
| `^[a-z0-9]{15}$` | 16th byte rejects | 0.44 µs (0.69 µs) | 1.8 µs (2.4 µs) | 57.5 µs (89.8 µs) |
| 50-alternation | unanchored, no match | 9.6 µs (10.3 µs) | 504 µs (545 µs) | 31.8 ms (35.3 ms) |
| 50-alternation, anchored | no match | 1.0 µs (1.0 µs) | 2.8 µs (2.4 µs) | 86.5 µs (73.3 µs) |

Time grows linearly with the input for every pattern. The unanchored NFA case, the slowest, is about 0.5 µs per input byte; text field values are at most 5,000 characters by default (`core/field_text.go`), about 2.5 ms in this worst case.

## Linear time

`test/tools/regexp/linear.test.ts` checks that patterns which take exponential time in a backtracking engine (`(a+)+$`, `(a|aa)*b`, `(x+x+)+y`, `^(a|a?)+$`) take about the same time per byte on 30 and 3,000 characters. Measured once with `findStringSubmatchIndex` and `matchString` per run: `(a+)+$` 0.011 ms at 30 characters and 0.80 ms at 3,000; `(a|aa)*b` 0.015 ms and 1.12 ms.

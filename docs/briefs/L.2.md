# L.2 Type-safety rules, part 1: unsafe flows, non-null, throws, methods

Written by the chief of staff on 2026-11-21. Owner request 2026-11-21: fix all the issues `@cloudflare/oxlint-config` reports (D44). L.1 (#111) fixed about 14,000 findings and left twelve rules off in the "L.1 open items" override at the end of `oxlint.config.ts`. They are split into three tasks so each PR stays reviewable (D44, split decided by agents):

| Task | Rules | Findings at L.1 |
|---|---|---:|
| **L.2** (this) | `typescript/no-non-null-assertion` 166, `no-unsafe-call` 118, `no-unsafe-assignment` 107, `no-unsafe-member-access` 103, `no-unsafe-argument` 32, `only-throw-error` 17, `no-unsafe-return` 15, `unbound-method` 11 | 569 |
| L.3 | `quality/no-unsafe-dictionary-type` 679, `quality/no-known-value-widening` 545, `quality/no-unknown-returns` 301 | 1,525 |
| L.4 | `typescript/no-unsafe-type-assertion` | 3,192 |

**Base branch: `main`.** No release.

## Rules for every part (L.2, L.3, L.4)

- Remove the task's rules from the "L.1 open items" override and fix every finding. When the last part is done, the override is gone; until then, the comment above it names the task that owns each remaining rule.
- **No behavior change.** The data and API contracts (AGENTS.md) and SDK parity with JS SDK v0.29.0 (D36) win over the lint rule. Prefer type-level fixes: real types instead of `any`, generics, typed return values, `unknown` plus narrowing.
- **Runtime guards only where behavior stays identical.** A guard added at a boundary (`JSON.parse`, `Bun.SQL`/`bun:sqlite` rows, request bodies, worker messages) may only narrow types, and must take the same path for every input that reaches it today. It must not add a new error response, change an error message or reject input that is accepted today. If a correct guard would change what a client sees, keep the old flow and use a typed assertion helper or a reasoned disable comment instead.
- **Raw JSON stays raw** (AGENTS.md). Never parse and re-stringify to satisfy a rule.
- **Hot paths.** If a fix adds runtime work in the database layer, filters, realtime or file handling (anything beyond types), measure before and after and store it under `docs/perf/` (AGENTS.md). Pure type changes need no measurement.
- `// oxlint-disable-next-line <rule> -- <reason>` only where a fix would break one of the points above; count them per rule in the PR body. A rule may be narrowed by a file override only for the same reasons, listed in the PR body with its count.
- One commit per rule (or small group of related rules). Subagents on your model for bulk work are fine; you check their output.
- Tests: no test may be weakened. Test files get the preset's test relaxations already; findings that remain in tests are fixed the same way.

## L.2 specifics

- `only-throw-error`: if a thrown non-Error value is caught and inspected, or reaches a client (error body, log line, SDK `ClientResponseError`), making it an `Error` may change behavior. Fix it only where the thrown value is invisible; otherwise keep it with a reasoned disable comment and say why in the PR body.
- `unbound-method`: bind or use an arrow only where `this` is really used; for static-like functions annotate `this: void`.
- `no-non-null-assertion`: replace `!` with a real check only where the check cannot fail differently from today (e.g. a value just set, or a `Map.get` after `has`); where the old code relied on a later TypeError, keep the same failure (throw the same thing at the same point) or use a reasoned disable comment.

## Verification

- `bun run check` (from a clean tree: remove `dist/`, `sdk/dist/`, `ui/dist/` first), then `bun run test:reference`, then `bun run test:browser`, one after the other. Report exit codes and counts, and the lint output (0 errors, 0 warnings).
- The worker instructions in `docs/chief-of-staff.md` apply.
- PR titled "L.2: type-safety rules, part 1" against `main`, with per-rule before/after counts, disable-comment counts and any narrowed rule. Do not merge.

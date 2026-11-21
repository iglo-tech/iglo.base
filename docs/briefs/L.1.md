# L.1 Lint with @cloudflare/oxlint-config

Written by the chief of staff on 2026-11-21. Owner request 2026-11-21: adopt [`@cloudflare/oxlint-config`](https://www.npmjs.com/package/@cloudflare/oxlint-config) and fix all the issues it reports. Decision record: D44. **Base branch: `main`.** No release; this is a code-quality change.

## Setup

- Dev dependencies: `@cloudflare/oxlint-config` (0.1.0; it pulls `@nkzw/oxlint-config` 3.0.0 with JS plugins), `oxlint` ^1.94.0 (from 1.90.0) and its type-aware backend `tsrs` at the version the preset's README names (`0.25.0-ts7.1.0-beta`). Exact versions, `bun.lock` updated. They are lint tools only: nothing enters the server executable or the SDK package.
- Replace `.oxlintrc.json` with `oxlint.config.ts` that spreads the preset as its README says (`import cloudflare from '@cloudflare/oxlint-config'; export default defineConfig({ ...cloudflare, ... })`). Keep our own rules on top: the `@/` alias rule (`no-restricted-imports` on `./*`, `../*`), `typescript/no-explicit-any`, `eqeqeq`, and the ignore patterns (`dist/**`, `sdk/dist/**`, `ui/**`, `examples/**`; `ui/` is vendored upstream code and stays unlinted).
- **No React (owner 2026-11-21):** drop the `react` and `jsx-a11y` plugins and every `react/` and `jsx-a11y/` rule from the spread preset with one filter at the top of the config; iglo.base has no React or JSX. This is not an exception to "fix everything".
- `bun run lint` keeps `--deny-warnings` and runs the type-aware rules. Note memory: the host is small; if the type-aware run needs a lot of memory, say how much in the PR.
- The preset's test overrides match `*.test.ts`/`*.spec.ts`. Our test support files (`test/**` and `sdk/test/**` helpers, harnesses, fixtures, scenario data) get the same test relaxations by an override.
- Read the preset's migration guidance in its README and, if you can reach it, `skills/migrate-oxlint-config/SKILL.md` in https://github.com/cloudflare/oxlint-config (the npm tarball does not contain it).

## Fix everything it reports

The owner asked for all reported issues to be fixed. First record the count per rule in the PR body (before fixes). Then fix them, one commit per rule (or per small group of related rules), with subagents on your model for bulk mechanical fixes.

A rule may be turned off, or narrowed by a file override, **only** when fixing it would break one of these, and each such case is listed in the PR body with the reason and the count it would have reported:
1. **Behavior.** No fix may change what the server, CLI, SDK or migrations do (AGENTS.md contracts). In code ported from upstream, keep upstream's logic; `== null` becomes `=== null || === undefined`, never a narrower check.
2. **SDK parity.** `sdk/src` must keep the upstream JS SDK's behavior (D36); type-only and assertion fixes are fine, logic changes are not. The existing `sdk/**` exceptions (`eqeqeq`, `no-underscore-dangle`) stay if still needed.
3. **Project rules.** CLI command output (including the `serve` banner) is allowed console output (AGENTS.md "Rules"): use a `no-console` override for the CLI output paths, not per-line disables. Application code keeps `no-console`.
4. **Raw JSON.** Stored JSON stays raw text (AGENTS.md); do not "fix" an unsafe-`any` by parsing and re-stringifying.

Avoid `// oxlint-disable` comments; where one is unavoidable, give the reason on the same line, and count them in the PR body. Sorting rules from the preset (perfectionist) are mechanical: apply their autofix (`oxlint --fix`) in their own commit(s). No other refactors.

`docs/design/` and `AGENTS.md` mention `oxlint --deny-warnings` and `.oxlintrc.json`: update them to the new config. Add D44 to `docs/design/10-decisions.md` only if the lead's stub is missing (the lead writes it).

Changes in the database layer, filters, realtime or file handling are lint fixes only, so no perf measurements are needed, unless a fix changes the logic of a hot path (it should not).

## Verification

- `bun run check`, then `bun run test:reference`, then `bun run test:browser` (the dashboard is built from code the lint touches only if `ui/` were linted; it is not, but run it anyway), one after the other. Report each exit code and counts, and the final lint output (0 errors, 0 warnings).
- The worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "L.1: lint with @cloudflare/oxlint-config" against `main`. Do not merge.

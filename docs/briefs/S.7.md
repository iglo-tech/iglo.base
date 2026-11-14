# S.7 Merge `develop` into `main` and prepare the release

Written by the chief of staff on 2026-11-14. Owner direction 2026-11-09: schema as code (#76–#81) is released only when all six PRs are merged into `develop`. S.1–S.6 are merged there (#96, #97, #101, #102, #103, #104). **Base branch: `main`.**

## Scope

- **Branch and merge:** create `task/S.7-release` from `origin/main` and run `git merge --no-ff origin/develop`. This is a real merge, so `develop`'s history stays.
  - Resolve conflicts so that both sides survive. `main` has P.14 (SDK renamed to `@iglo.tech/iglo.base`, D36/D38 notes), the runbook, status and briefs. `develop` has D40–D41, `src/schema/`, the CLI and the docs.
  - Expect conflicts in `docs/design/10-decisions.md`, `docs/design/01-scope.md`, `AGENTS.md`, `sdk/README.md`, `README.md` and `bun.lock`. Regenerate `bun.lock` with `bun install` rather than hand-merging it.
- **After the merge:**
  - **Package name:** every place `develop` names the SDK package uses `@iglo.tech/iglo.base`. Check with `git grep -n "from \"iglo.base"` and `git grep -n "'iglo.base"`, and treat other hits the way P.14 did. The generated types already import `@iglo.tech/iglo.base`.
  - **Server version:** the next server release is **v1.2.0** (new features, nothing breaking). Update `AGENTS.md` "Current state" and the root `README.md` where they name the released version or list features (add schema as code, briefly). There is no server changelog file; if `docs/` has release notes, add a 1.2.0 entry.
  - **SDK:** bump `sdk/package.json` to **1.0.1** and add `## 1.0.1` to `sdk/CHANGELOG.md`. Move everything under "Unreleased" there; if nothing is there, write "README: a pointer to the generated types (`iglo-base schema types`)". Merging to `main` then publishes it automatically (`docs/releasing.md`).
  - **Docs:**
    - `docs/schema.md` is the user guide. Read it once from start to end against the merged code: every flag and command it names exists (`--help` output), and the examples match. Fix what doesn't.
    - `docs/design/01-scope.md`: schema-as-code items marked built.
    - `docs/design/12-work-plan.md`: S.1–S.6 merged, S.7 in this PR.
- **Linux arm64:** after pushing the branch, run `gh workflow run ci.yml --ref task/S.7-release`. It must pass, including the job `check-linux-arm64`. Wait for it with bounded loops on `gh run view`, never `--watch`. Put the run URL in the PR.
- **Not in scope:** tagging, publishing the GitHub release and the iglo.tech site listing. The lead does those after the merge.

## Verification

- Run `bun run check`, `bun run test:reference`, `bun run test:browser` and `bun run test:examples`, one after the other, in the foreground, on the final head. Report each exit code. Delete every `node_modules` (outside the root), `.next`, `.svelte-kit` and build output that `test:examples` creates.
- The worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "S.7: merge develop (schema as code) into main" against `main`. The body says "Closes #76, closes #77, closes #78, closes #79, closes #80, closes #81", and lists the conflict resolutions. The lead merges it with a merge commit, not a squash. Do not merge.

# P.12 SDK releases

Written by the chief of staff on 2026-11-07. Owner direction: "auto releases on CI", npm as the registry. Spec: D36 in `docs/design/10-decisions.md` ("Versions"). P.11 (#89) put the SDK in `sdk/` as the npm package `iglo.base`, version 1.0.0, ESM only, with `sdk:build` and `sdk:check-package` scripts.

## Scope

- New workflow `.github/workflows/sdk-release.yml`:
  - Triggers: `push` to `main` with `paths: [sdk/package.json]`, and `workflow_dispatch` with a boolean `dry-run` input.
  - Reads the version from `sdk/package.json`. If `iglo.base@<version>` is already on npm (`npm view`) or the tag `sdk-v<version>` exists, it ends successfully without doing anything (so ordinary edits to `sdk/package.json` publish nothing).
  - Refuses (fails) when `sdk/CHANGELOG.md` has no section for that version.
  - Builds and checks with Bun as the repository does (`bun install --frozen-lockfile`, lint/typecheck for the SDK where cheap, the SDK unit tests, `sdk:build`, `sdk:check-package`). It does not run the server's test suites.
  - Publishes from `sdk/` with `npm publish --provenance --access public` through npm trusted publishing (OIDC: `permissions: id-token: write`; a Node and npm version that supports trusted publishing). No npm token or secret anywhere in the repository. `dry-run` runs `npm publish --dry-run` and skips the tag and release.
  - After a successful publish: creates the tag `sdk-v<version>` on the published commit and a GitHub release for it with that version's CHANGELOG section as notes, **not** marked as latest (`--latest=false`), so the server's releases stay "latest".
  - Pin actions by commit SHA with a version comment, as `release.yml` does. Least-privilege `permissions` per job. `concurrency` so two runs cannot publish at once.
- `.github/workflows/docker.yml` runs on every published release: make it ignore releases whose tag is not a server tag (`v*`, not `sdk-v*`), and check `release.yml` and `ci.yml` for the same class of trigger problem (an `sdk-v*` tag or release must start no server build).
- `docs/releasing.md`: an "SDK releases" section: bump `sdk/package.json` and add a CHANGELOG section in one PR; merging it publishes; how to dry-run; the one-time npm setup the owner does (trusted publisher for `iglo-tech/iglo.base`, workflow file `sdk-release.yml`), and what happens if it is missing (the publish step fails with npm's error; nothing is tagged). Update D36's "Versions" bullet only if the implementation has to differ, and say so in the PR.
- No version bump in this task: 1.0.0 is the first version, published when the owner has done the npm setup.

## Verification

- `actionlint` on the changed workflows (install it into a `mktemp -d` directory if missing) and `bun run check`. `test:reference` is not needed unless you touch code outside `.github/` and docs.
- Run the release job's shell logic locally where possible (version read, npm view check against the real registry, which must report `iglo.base@1.0.0` as not published, CHANGELOG section check, `npm publish --dry-run` from `sdk/` after `sdk:build`). Show the commands and output in the PR body.
- Do not run the workflow on GitHub (`workflow_dispatch`) and do not publish anything.

Worker rules from `docs/design/12-work-plan.md` apply. Open a PR titled "P.12: SDK releases" against `main`; do not merge.

# P.14 SDK package name `@iglo.tech/iglo.base`

Written by the chief of staff on 2026-11-12. Owner direction 2026-11-12: the SDK is published under the npm organization `iglo.tech` as **`@iglo.tech/iglo.base`**, not as the unscoped `iglo.base`. Nothing is published yet, so there is no old package to deprecate. Amends D36 and D38. **Base branch: `main`.**

## Scope

- **Package name.** `sdk/package.json` `name` becomes `@iglo.tech/iglo.base`. Add `"publishConfig": { "access": "public" }`, because scoped packages are private by default. The version stays 1.0.0. Every subpath keeps its path under the new name: `@iglo.tech/iglo.base/ssr`, `/ssr/browser`, `/ssr/next`, `/ssr/sveltekit`, `/ssr/nuxt`, `/ssr/astro`, `/ssr/react-router`.
- **Every reference to the package name**, and only those. The project and product are still called iglo.base: the server, the repository, prose like "iglo.base's SDK", the executable `iglo-base`, and the root workspace package `iglo.base-server`. Change only places that name the npm package or import it:
  - `sdk/` (README, CHANGELOG under "Unreleased", the `check-package` script and its consumer fixtures, and any source that names the package, such as the server-only error message in `sdk/src/ssr/`);
  - `.github/workflows/sdk-release.yml` (`npm view` and similar), `docs/releasing.md`;
  - `docs/ssr.md`, `docs/design/13-ssr.md`, the root `README.md`;
  - `examples/nextjs` and `examples/sveltekit` (package.json dependency, imports, lockfiles regenerated with Bun);
  - the differential and SDK test harnesses that import the workspace SDK by name;
  - the root `package.json` and `bun.lock` (workspace dependency name).

  Leave the briefs of finished tasks (`docs/briefs/P.11.md` and others) as they are; they are history. Use `git grep` to find every case, and say in the PR how you told package references apart from the project name.
- **Decision docs.** In `docs/design/10-decisions.md`, add to D36 a dated line: "Package name `@iglo.tech/iglo.base` (owner, 2026-11-12), published under the npm organization `iglo.tech`; replaces `iglo.base`." Also correct the "Considered" sentence about scoped names. Add the same note to D38 if it names the import path.
- **Release docs.** `docs/releasing.md` "One-time npm setup" becomes this:
  - the owner creates the npm organization `iglo.tech` (free plan, public packages);
  - the first publish is a manual `npm publish` of 1.0.0 from a clean `main`, with the owner's interactive `npm login` (no token), then `npm logout`;
  - the release workflow then creates the `sdk-v1.0.0` tag and GitHub release;
  - the owner adds the trusted publisher (GitHub Actions, `iglo-tech/iglo.base`, `sdk-release.yml`, no environment, direct publishing allowed);
  - a throwaway prerelease validates the trusted publisher within 2 days.

  Remove the `NPM_TOKEN` bootstrap route from the docs and from `sdk-release.yml`, since the owner chose no tokens. Keep the workflow's OIDC path unchanged.

## Verification

- `bun run check` passes; `sdk:check-package` imports the packed tarball under the new name with Node and Bun, and its browser-bundle checks pass.
- `bun run test:reference` passes.
- `bun run test:examples` passes (one app at a time; it installs framework packages).
- The worker rules in `docs/design/12-work-plan.md` and the worker instructions in `docs/chief-of-staff.md` apply. Open a PR titled "P.14: SDK package name @iglo.tech/iglo.base" against `main`. Do not merge. Delete every `node_modules`, `.next`, `.svelte-kit` and build output you created before you finish.

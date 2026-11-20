# U.2 Dashboard, SDK 0.29.0 and v1.3.0 release prep

Written by the chief of staff on 2026-11-20. Decision record: [D43](../design/10-decisions.md#d43-baseline-moved-from-v0410-to-v0423). U.1 is merged: the reference is PocketBase v0.42.3 in `.upstream/` (`bun run upstream:prepare`). **Base branch: `main`.**

## 1. Dashboard

- Re-copy upstream v0.42.3 `ui/` into `ui/` and re-apply every entry of `ui/PATCHES.md` by hand, as its header says. Update the header to v0.42.3 (`c5003ce63deee71cc6821f338f0d4e1994b3db40`). Keep the fonts' new license `README.md` files.
- `bun.lock` follows upstream's `package.json` (`pocketbase` ^0.29.0); `PATCHES.md` entry 2 names the new resolved versions.
- Remove every `// U.2:` skip U.1 left in `test/differential/ui/` and make those cases pass.
- `docs/design/08-admin-ui.md` names the new base version.
- Run `bun run test:browser` too (needs agent-browser) and report it.

## 2. SDK

- Port upstream JS SDK v0.28.2 and v0.29.0 changes into `sdk/` (source: tag `v0.29.0` of `https://ganigeorgiev.com/git/pocketbase/js-sdk`; fetch it into a `mktemp -d` directory). 0.28.2 only changes links: keep ours where they point at iglo.base. 0.29.0: `authStore` cleared after a 401 for an expired or externally invalidated token, `autoClearAuthStore(false)` to turn it off; port its tests into `sdk/test`.
- Version `1.1.0` in `sdk/package.json` (merging publishes it to npm automatically); update the description's base version and `sdk/README.md` if it names one.

## 3. v1.3.0 release prep

- `AGENTS.md` "Current state": v1.3.0 is the move to the v0.42.3 baseline (D43), with one line on the 401 change.
- Search for `v1.2.1` URLs that should follow (for example the `$schema` URL in `docs/schema.md`) and update them.
- In the user docs that explain auth tokens (find them under `docs/`), add a short note: since v1.3.0 an unknown or expired token gets 401 instead of guest access, and the SDK clears its auth store on that 401.

The lead tags and publishes v1.3.0 after the merge.

## Verification

- `bun run check`, then `bun run test:reference`, one after the other. Report each exit code and counts.
- The worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "U.2: dashboard and SDK from v0.42.3, v1.3.0 prep" against `main`. Do not merge.

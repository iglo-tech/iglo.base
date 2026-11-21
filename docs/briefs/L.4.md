# L.4 Type-safety rules, part 3: unsafe type assertions

Written by the chief of staff on 2026-11-21. Part 3 of 3 of the rules L.1 left off (D44). Rule: `typescript/no-unsafe-type-assertion` (3,192 at L.1). **Base branch: `main`** after L.3 merged. When done, the "L.1 open items" override is removed.

Follow "Rules for every part" in `docs/briefs/L.2.md` and its Verification section. PR titled "L.4: type-safety rules, part 3". Start with a per-directory count in the PR body; prefer fixing the types an assertion works around (typed rows, typed parse results, generics) over adding checks. If the count is too large for one reviewable PR, stop after `src/` and `sdk/src`, report, and the lead splits the rest.

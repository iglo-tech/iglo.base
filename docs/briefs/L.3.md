# L.3 Type-safety rules, part 2: dictionary types, value widening, unknown returns

Written by the chief of staff on 2026-11-21. Part 2 of 3 of the rules L.1 left off (D44). Rules: `quality/no-unsafe-dictionary-type` (679 at L.1), `quality/no-known-value-widening` (545), `quality/no-unknown-returns` (301). **Base branch: `main`** after L.2 merged.

Follow "Rules for every part" in `docs/briefs/L.2.md` and its Verification section. PR titled "L.3: type-safety rules, part 2". Dictionary types: use `Record<string, T | undefined>`, `Map` only where it does not change iteration order or serialization, or a precise object type; never change what is stored or sent.

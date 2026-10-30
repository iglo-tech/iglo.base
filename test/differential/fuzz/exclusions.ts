// Named, narrow exclusions from the comparison: differences that D26 covers
// (hand-crafted input handled safely). A difference a real client filter can
// hit is fixed, never listed here. Each one goes into the PR for the lead to
// judge, and the run counts how often each one applied.

import type { Difference, Outcome } from "@test/differential/fuzz/compare";
import type { FuzzCase } from "@test/differential/fuzz/generate";

export interface Exclusion {
  name: string;
  reason: string;
  applies(c: FuzzCase, difference: Difference, up: Outcome | null, ig: Outcome | null): boolean;
}

export const exclusions: Exclusion[] = [];

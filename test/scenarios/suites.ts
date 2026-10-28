// Every ported scenario suite, in upstream file order. Both runners
// (test/scenarios/scenarios.test.ts and test/differential/scenarios.test.ts)
// read this list, so a suite added here runs in both modes.

import { healthAPI } from "@test/scenarios/health";
import type { Suite } from "@test/scenarios/scenario";

export const suites: Suite[] = [healthAPI];

// Every ported scenario suite, in upstream file order. Both runners
// (test/scenarios/scenarios.test.ts and test/differential/scenarios.test.ts)
// read this list, so a suite added here runs in both modes.

import { healthAPI } from "@test/scenarios/health";
import { superuserIPsWhitelist } from "@test/scenarios/middlewares";
import { recordCrudList, recordCrudView } from "@test/scenarios/record-crud";
import {
  recordCrudSuperuserCreate,
  recordCrudSuperuserDelete,
  recordCrudSuperuserList,
  recordCrudSuperuserUpdate,
  recordCrudSuperuserView,
} from "@test/scenarios/record-crud-superuser";
import {
  recordCrudCreate,
  recordCrudDelete,
  recordCrudUpdate,
} from "@test/scenarios/record-crud-write";
import type { Suite } from "@test/scenarios/scenario";
import {
  generateAppleClientSecret,
  settingsList,
  settingsSet,
  settingsTestEmail,
  settingsTestS3,
} from "@test/scenarios/settings";

export const suites: Suite[] = [
  healthAPI,
  superuserIPsWhitelist,
  recordCrudList,
  recordCrudView,
  recordCrudDelete,
  recordCrudCreate,
  recordCrudUpdate,
  recordCrudSuperuserList,
  recordCrudSuperuserView,
  recordCrudSuperuserDelete,
  recordCrudSuperuserCreate,
  recordCrudSuperuserUpdate,
  settingsList,
  settingsSet,
  settingsTestS3,
  settingsTestEmail,
  generateAppleClientSecret,
];

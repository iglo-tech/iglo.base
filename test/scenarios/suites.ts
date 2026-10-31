// Every ported scenario suite, in upstream file order. Both runners
// (test/scenarios/scenarios.test.ts and test/differential/scenarios.test.ts)
// read this list, so a suite added here runs in both modes.

import {
  collectionCreate,
  collectionDelete,
  collectionOAuth2Providers,
  collectionScaffolds,
  collectionTestView,
  collectionTruncate,
  collectionUpdate,
  collectionView,
  collectionsList,
} from "@test/scenarios/collection";
import { collectionsImport } from "@test/scenarios/collection-import";
import { fileDownload, fileToken } from "@test/scenarios/file";
import { healthAPI } from "@test/scenarios/health";
import { superuserIPsWhitelist } from "@test/scenarios/middlewares";
import {
  recordAuthImpersonate,
  recordAuthMethodsList,
  recordAuthRefresh,
  recordAuthWithPassword,
} from "@test/scenarios/record-auth";
import { recordAuthWithOAuth2 } from "@test/scenarios/record-auth-oauth2";
import { recordAuthWithOTP, recordRequestOTP } from "@test/scenarios/record-auth-otp";
import {
  recordConfirmEmailChange,
  recordRequestEmailChange,
} from "@test/scenarios/record-auth-email-change";
import {
  recordConfirmPasswordReset,
  recordRequestPasswordReset,
} from "@test/scenarios/record-auth-password-reset";
import {
  recordConfirmVerification,
  recordRequestVerification,
} from "@test/scenarios/record-auth-verification";
import { recordCrudList, recordCrudView } from "@test/scenarios/record-crud";
import {
  recordCrudAuthOriginCreate,
  recordCrudAuthOriginDelete,
  recordCrudAuthOriginList,
  recordCrudAuthOriginUpdate,
  recordCrudAuthOriginView,
} from "@test/scenarios/record-crud-auth-origin";
import {
  recordCrudMFACreate,
  recordCrudMFADelete,
  recordCrudMFAList,
  recordCrudMFAUpdate,
  recordCrudMFAView,
} from "@test/scenarios/record-crud-mfa";
import {
  recordCrudOTPCreate,
  recordCrudOTPDelete,
  recordCrudOTPList,
  recordCrudOTPUpdate,
  recordCrudOTPView,
} from "@test/scenarios/record-crud-otp";
import {
  recordCrudExternalAuthCreate,
  recordCrudExternalAuthDelete,
  recordCrudExternalAuthList,
  recordCrudExternalAuthUpdate,
  recordCrudExternalAuthView,
} from "@test/scenarios/record-crud-external-auth";
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
import { batchRequest } from "@test/scenarios/batch";
import type { Suite } from "@test/scenarios/scenario";
import {
  generateAppleClientSecret,
  settingsList,
  settingsSet,
  settingsTestEmail,
  settingsTestS3,
  testEmailSendValidateAndSubmit,
} from "@test/scenarios/settings";

export const suites: Suite[] = [
  batchRequest,
  collectionsList,
  collectionView,
  collectionDelete,
  collectionCreate,
  collectionUpdate,
  collectionScaffolds,
  collectionTruncate,
  collectionOAuth2Providers,
  collectionTestView,
  collectionsImport,
  fileToken,
  fileDownload,
  healthAPI,
  superuserIPsWhitelist,
  recordAuthImpersonate,
  recordAuthMethodsList,
  recordAuthRefresh,
  recordAuthWithPassword,
  recordRequestOTP,
  recordAuthWithOAuth2,
  recordAuthWithOTP,
  recordRequestVerification,
  recordConfirmVerification,
  recordRequestPasswordReset,
  recordConfirmPasswordReset,
  recordRequestEmailChange,
  recordConfirmEmailChange,
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
  recordCrudAuthOriginList,
  recordCrudAuthOriginView,
  recordCrudAuthOriginDelete,
  recordCrudAuthOriginCreate,
  recordCrudAuthOriginUpdate,
  recordCrudOTPList,
  recordCrudOTPView,
  recordCrudOTPDelete,
  recordCrudOTPCreate,
  recordCrudOTPUpdate,
  recordCrudExternalAuthList,
  recordCrudExternalAuthView,
  recordCrudExternalAuthDelete,
  recordCrudExternalAuthCreate,
  recordCrudExternalAuthUpdate,
  recordCrudMFAList,
  recordCrudMFAView,
  recordCrudMFADelete,
  recordCrudMFACreate,
  recordCrudMFAUpdate,
  settingsList,
  settingsSet,
  settingsTestS3,
  settingsTestEmail,
  testEmailSendValidateAndSubmit,
  generateAppleClientSecret,
];

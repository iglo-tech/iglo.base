// Upstream: apis/record_crud_superuser_test.go (TestRecordCrudSuperuserList,
// TestRecordCrudSuperuserView, TestRecordCrudSuperuserDelete,
// TestRecordCrudSuperuserCreate, TestRecordCrudSuperuserUpdate)
//
// The URLs use core.CollectionNameSuperusers, which is "_superusers". The
// `after` steps check the stored superusers (test/scenarios/record-checks.ts).

import {
  checks,
  recordCount,
  recordHas,
  recordMissing,
  responsePasswordIs,
  responseRecordStored,
  rowHas,
} from "@test/scenarios/record-checks";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import { deleteOtherSuperusers } from "@test/scenarios/record-prepare";
import type { Suite } from "@test/scenarios/scenario";

export const recordCrudSuperuserList: Suite = {
  file: "apis/record_crud_superuser_test.go",
  func: "TestRecordCrudSuperuserList",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_superusers/records",
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-superusers auth",
      method: "GET",
      url: "/api/collections/_superusers/records",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "GET",
      url: "/api/collections/_superusers/records",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":4`,
        `"items":[{`,
      ],
    },
  ],
};

export const recordCrudSuperuserView: Suite = {
  file: "apis/record_crud_superuser_test.go",
  func: "TestRecordCrudSuperuserView",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_superusers/records/sywbhecnh46rhm0",
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-superusers auth",
      method: "GET",
      url: "/api/collections/_superusers/records/sywbhecnh46rhm0",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "GET",
      url: "/api/collections/_superusers/records/sywbhecnh46rhm0",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"id":"sywbhecnh46rhm0"`],
    },
  ],
};

export const recordCrudSuperuserDelete: Suite = {
  file: "apis/record_crud_superuser_test.go",
  func: "TestRecordCrudSuperuserDelete",
  scenarios: [
    {
      name: "guest",
      method: "DELETE",
      url: "/api/collections/_superusers/records/sbmbsdb40jyxf7h",
      after: recordHas("_superusers", "sbmbsdb40jyxf7h"),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-superusers auth",
      method: "DELETE",
      url: "/api/collections/_superusers/records/sbmbsdb40jyxf7h",
      headers: { Authorization: usersToken },
      after: recordHas("_superusers", "sbmbsdb40jyxf7h"),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "DELETE",
      url: "/api/collections/_superusers/records/sbmbsdb40jyxf7h",
      headers: { Authorization: superuserToken },
      after: recordMissing("_superusers", "sbmbsdb40jyxf7h"),
      expectedStatus: 204,
    },
    {
      name: "delete the last superuser",
      method: "DELETE",
      url: "/api/collections/_superusers/records/sywbhecnh46rhm0",
      headers: { Authorization: superuserToken },
      // delete all other superusers
      prepare: ({ dataDir }) => deleteOtherSuperusers(dataDir, "sywbhecnh46rhm0"),
      after: checks(recordHas("_superusers", "sywbhecnh46rhm0"), recordCount("_superusers", 1)),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
  ],
};

export const recordCrudSuperuserCreate: Suite = {
  file: "apis/record_crud_superuser_test.go",
  func: "TestRecordCrudSuperuserCreate",
  scenarios: [
    {
      name: "guest",
      method: "POST",
      url: "/api/collections/_superusers/records",
      body: `{
			"email":           "test_new@example.com",
			"password":        "1234567890",
			"passwordConfirm": "1234567890",
			"verified":        false
		}`,
      after: recordCount("_superusers", 4),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-superusers auth",
      method: "POST",
      url: "/api/collections/_superusers/records",
      headers: { Authorization: usersToken },
      body: `{
			"email":           "test_new@example.com",
			"password":        "1234567890",
			"passwordConfirm": "1234567890",
			"verified":        false
		}`,
      after: recordCount("_superusers", 4),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "POST",
      url: "/api/collections/_superusers/records",
      headers: { Authorization: superuserToken },
      body: `{
			"email":           "test_new@example.com",
			"password":        "1234567890",
			"passwordConfirm": "1234567890",
			"verified":        false
		}`,
      after: checks(
        responseRecordStored("_superusers", { email: "test_new@example.com", verified: true }),
        responsePasswordIs("_superusers", "1234567890"),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"collectionName":"_superusers"`,
        `"email":"test_new@example.com"`,
        `"verified":true`,
      ],
    },
  ],
};

export const recordCrudSuperuserUpdate: Suite = {
  file: "apis/record_crud_superuser_test.go",
  func: "TestRecordCrudSuperuserUpdate",
  scenarios: [
    {
      name: "guest",
      method: "PATCH",
      url: "/api/collections/_superusers/records/sywbhecnh46rhm0",
      body: `{
			"email":    "test_new@example.com",
			"verified": true
		}`,
      after: recordHas("_superusers", "sywbhecnh46rhm0", { email: "test@example.com" }),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-superusers auth",
      method: "PATCH",
      url: "/api/collections/_superusers/records/sywbhecnh46rhm0",
      headers: { Authorization: usersToken },
      body: `{
			"email":    "test_new@example.com",
			"verified": true
		}`,
      after: recordHas("_superusers", "sywbhecnh46rhm0", { email: "test@example.com" }),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "PATCH",
      url: "/api/collections/_superusers/records/sywbhecnh46rhm0",
      headers: { Authorization: superuserToken },
      body: `{
			"email":    "test_new@example.com",
			"verified": true
		}`,
      after: rowHas("_superusers", "sywbhecnh46rhm0", {
        email: "test_new@example.com",
        verified: 1,
      }),
      expectedStatus: 200,
      expectedContent: [
        `"collectionName":"_superusers"`,
        `"id":"sywbhecnh46rhm0"`,
        `"email":"test_new@example.com"`,
        `"verified":true`,
      ],
    },
  ],
};

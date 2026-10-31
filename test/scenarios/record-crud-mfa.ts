// Upstream: apis/record_crud_mfa_test.go
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).

import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import { stubMFARecords } from "@test/scenarios/record-auth-prepare";
import type { Suite } from "@test/scenarios/scenario";

export const recordCrudMFAList: Suite = {
  file: "apis/record_crud_mfa_test.go",
  func: "TestRecordCrudMFAList",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_mfas/records",
      prepare: stubMFARecords,
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":0`,
        `"totalPages":0`,
        `"items":[]`,
      ],
    },
    {
      name: "regular auth with mfas",
      method: "GET",
      url: "/api/collections/_mfas/records",
      // users, test@example.com
      headers: { Authorization: usersToken },
      prepare: stubMFARecords,
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":1`,
        `"totalPages":1`,
        `"id":"user1_0"`,
      ],
    },
    {
      name: "regular auth without mfas",
      method: "GET",
      url: "/api/collections/_mfas/records",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      prepare: stubMFARecords,
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":0`,
        `"totalPages":0`,
        `"items":[]`,
      ],
    },
  ],
};

export const recordCrudMFAView: Suite = {
  file: "apis/record_crud_mfa_test.go",
  func: "TestRecordCrudMFAView",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_mfas/records/user1_0",
      prepare: stubMFARecords,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-owner",
      method: "GET",
      url: "/api/collections/_mfas/records/user1_0",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      prepare: stubMFARecords,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner",
      method: "GET",
      url: "/api/collections/_mfas/records/user1_0",
      // users, test@example.com
      headers: { Authorization: usersToken },
      prepare: stubMFARecords,
      expectedStatus: 200,
      expectedContent: [`"id":"user1_0"`],
    },
  ],
};

export const recordCrudMFADelete: Suite = {
  file: "apis/record_crud_mfa_test.go",
  func: "TestRecordCrudMFADelete",
  scenarios: [
    {
      name: "guest",
      method: "DELETE",
      url: "/api/collections/_mfas/records/user1_0",
      prepare: stubMFARecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-owner",
      method: "DELETE",
      url: "/api/collections/_mfas/records/user1_0",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      prepare: stubMFARecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner",
      method: "DELETE",
      url: "/api/collections/_mfas/records/user1_0",
      // users, test@example.com
      headers: { Authorization: usersToken },
      prepare: stubMFARecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "DELETE",
      url: "/api/collections/_mfas/records/user1_0",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      prepare: stubMFARecords,
      expectedStatus: 204,
    },
  ],
};

export const recordCrudMFACreate: Suite = {
  file: "apis/record_crud_mfa_test.go",
  func: "TestRecordCrudMFACreate",
  scenarios: [
    {
      name: "guest",
      method: "POST",
      url: "/api/collections/_mfas/records",
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"method":        "abc"
		}`,
      prepare: stubMFARecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "POST",
      url: "/api/collections/_mfas/records",
      // users, test@example.com
      headers: { Authorization: usersToken },
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"method":        "abc"
		}`,
      prepare: stubMFARecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "POST",
      url: "/api/collections/_mfas/records",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"method":        "abc"
		}`,
      prepare: stubMFARecords,
      expectedStatus: 200,
      expectedContent: [`"recordRef":"4q1xlclmfloku33"`],
    },
  ],
};

export const recordCrudMFAUpdate: Suite = {
  file: "apis/record_crud_mfa_test.go",
  func: "TestRecordCrudMFAUpdate",
  scenarios: [
    {
      name: "guest",
      method: "PATCH",
      url: "/api/collections/_mfas/records/user1_0",
      body: `{
			"method":"abc"
		}`,
      prepare: stubMFARecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "PATCH",
      url: "/api/collections/_mfas/records/user1_0",
      // users, test@example.com
      headers: { Authorization: usersToken },
      body: `{
			"method":"abc"
		}`,
      prepare: stubMFARecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "PATCH",
      url: "/api/collections/_mfas/records/user1_0",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      body: `{
			"method":"abc"
		}`,
      prepare: stubMFARecords,
      expectedStatus: 200,
      expectedContent: [`"id":"user1_0"`],
    },
  ],
};

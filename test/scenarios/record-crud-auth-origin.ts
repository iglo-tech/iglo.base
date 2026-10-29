// Upstream: apis/record_crud_auth_origin_test.go
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).

import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { Suite } from "@test/scenarios/scenario";

export const recordCrudAuthOriginList: Suite = {
  file: "apis/record_crud_auth_origin_test.go",
  func: "TestRecordCrudAuthOriginList",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_authOrigins/records",
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
      name: "regular auth with authOrigins",
      method: "GET",
      url: "/api/collections/_authOrigins/records",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":1`,
        `"totalPages":1`,
        `"id":"9r2j0m74260ur8i"`,
      ],
    },
    {
      name: "regular auth without authOrigins",
      method: "GET",
      url: "/api/collections/_authOrigins/records",
      // users, test@example.com
      headers: { Authorization: usersToken },
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

export const recordCrudAuthOriginView: Suite = {
  file: "apis/record_crud_auth_origin_test.go",
  func: "TestRecordCrudAuthOriginView",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-owner",
      method: "GET",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      // users, test@example.com
      headers: { Authorization: usersToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner",
      method: "GET",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      expectedStatus: 200,
      expectedContent: [`"id":"9r2j0m74260ur8i"`],
    },
  ],
};

export const recordCrudAuthOriginDelete: Suite = {
  file: "apis/record_crud_auth_origin_test.go",
  func: "TestRecordCrudAuthOriginDelete",
  scenarios: [
    {
      name: "guest",
      method: "DELETE",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-owner",
      method: "DELETE",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      // users, test@example.com
      headers: { Authorization: usersToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner",
      method: "DELETE",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      expectedStatus: 204,
    },
  ],
};

export const recordCrudAuthOriginCreate: Suite = {
  file: "apis/record_crud_auth_origin_test.go",
  func: "TestRecordCrudAuthOriginCreate",
  scenarios: [
    {
      name: "guest",
      method: "POST",
      url: "/api/collections/_authOrigins/records",
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"fingerprint":   "abc"
		}`,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "POST",
      url: "/api/collections/_authOrigins/records",
      // users, test@example.com
      headers: { Authorization: usersToken },
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"fingerprint":   "abc"
		}`,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "POST",
      url: "/api/collections/_authOrigins/records",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"fingerprint":   "abc"
		}`,
      expectedStatus: 200,
      expectedContent: [`"fingerprint":"abc"`],
    },
  ],
};

export const recordCrudAuthOriginUpdate: Suite = {
  file: "apis/record_crud_auth_origin_test.go",
  func: "TestRecordCrudAuthOriginUpdate",
  scenarios: [
    {
      name: "guest",
      method: "PATCH",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      body: `{
			"fingerprint":"abc"
		}`,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "PATCH",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      body: `{
			"fingerprint":"abc"
		}`,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "PATCH",
      url: "/api/collections/_authOrigins/records/9r2j0m74260ur8i",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      body: `{
			"fingerprint":"abc"
		}`,
      expectedStatus: 200,
      expectedContent: [`"id":"9r2j0m74260ur8i"`, `"fingerprint":"abc"`],
    },
  ],
};

// Upstream: apis/record_crud_external_auth_test.go
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).

import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { Suite } from "@test/scenarios/scenario";

// users, test2@example.com
const usersToken2 =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Im9hcDY0MGNvdDR5cnUycyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.GfJo6EHIobgas_AXt-M-tj5IoQendPnrkMSe9ExuSEY";

const externalAuthCreateBody = `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"provider":      "github",
			"providerId":    "abc"
		}`;

const externalAuthUpdateBody = `{
			"providerId": "abc"
		}`;

export const recordCrudExternalAuthList: Suite = {
  file: "apis/record_crud_external_auth_test.go",
  func: "TestRecordCrudExternalAuthList",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_externalAuths/records",
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
      name: "regular auth with externalAuths",
      method: "GET",
      url: "/api/collections/_externalAuths/records",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":1`,
        `"totalPages":1`,
        `"id":"f1z5b3843pzc964"`,
      ],
    },
    {
      name: "regular auth without externalAuths",
      method: "GET",
      url: "/api/collections/_externalAuths/records",
      // users, test2@example.com
      headers: { Authorization: usersToken2 },
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

export const recordCrudExternalAuthView: Suite = {
  file: "apis/record_crud_external_auth_test.go",
  func: "TestRecordCrudExternalAuthView",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-owner",
      method: "GET",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner",
      method: "GET",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      // users, test@example.com
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [`"id":"dlmflokuq1xl342"`],
    },
  ],
};

export const recordCrudExternalAuthDelete: Suite = {
  file: "apis/record_crud_external_auth_test.go",
  func: "TestRecordCrudExternalAuthDelete",
  scenarios: [
    {
      name: "guest",
      method: "DELETE",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-owner",
      method: "DELETE",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner",
      method: "DELETE",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      // users, test@example.com
      headers: { Authorization: usersToken },
      expectedStatus: 204,
    },
  ],
};

export const recordCrudExternalAuthCreate: Suite = {
  file: "apis/record_crud_external_auth_test.go",
  func: "TestRecordCrudExternalAuthCreate",
  scenarios: [
    {
      name: "guest",
      method: "POST",
      url: "/api/collections/_externalAuths/records",
      body: externalAuthCreateBody,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "POST",
      url: "/api/collections/_externalAuths/records",
      // users, test@example.com
      headers: { Authorization: usersToken },
      body: externalAuthCreateBody,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "POST",
      url: "/api/collections/_externalAuths/records",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      body: externalAuthCreateBody,
      expectedStatus: 200,
      expectedContent: [`"recordRef":"4q1xlclmfloku33"`, `"providerId":"abc"`],
    },
  ],
};

export const recordCrudExternalAuthUpdate: Suite = {
  file: "apis/record_crud_external_auth_test.go",
  func: "TestRecordCrudExternalAuthUpdate",
  scenarios: [
    {
      name: "guest",
      method: "PATCH",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      body: externalAuthUpdateBody,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "PATCH",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      body: externalAuthUpdateBody,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "PATCH",
      url: "/api/collections/_externalAuths/records/dlmflokuq1xl342",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      body: externalAuthUpdateBody,
      expectedStatus: 200,
      expectedContent: [`"id":"dlmflokuq1xl342"`, `"providerId":"abc"`],
    },
  ],
};

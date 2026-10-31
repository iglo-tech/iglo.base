// Upstream: apis/record_crud_otp_test.go
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).

import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import { stubOTPRecords } from "@test/scenarios/record-auth-prepare";
import type { Suite } from "@test/scenarios/scenario";

export const recordCrudOTPList: Suite = {
  file: "apis/record_crud_otp_test.go",
  func: "TestRecordCrudOTPList",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_otps/records",
      prepare: stubOTPRecords,
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
      name: "regular auth with otps",
      method: "GET",
      url: "/api/collections/_otps/records",
      // users, test@example.com
      headers: { Authorization: usersToken },
      prepare: stubOTPRecords,
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
      name: "regular auth without otps",
      method: "GET",
      url: "/api/collections/_otps/records",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      prepare: stubOTPRecords,
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

export const recordCrudOTPView: Suite = {
  file: "apis/record_crud_otp_test.go",
  func: "TestRecordCrudOTPView",
  scenarios: [
    {
      name: "guest",
      method: "GET",
      url: "/api/collections/_otps/records/user1_0",
      prepare: stubOTPRecords,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-owner",
      method: "GET",
      url: "/api/collections/_otps/records/user1_0",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      prepare: stubOTPRecords,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner",
      method: "GET",
      url: "/api/collections/_otps/records/user1_0",
      // users, test@example.com
      headers: { Authorization: usersToken },
      prepare: stubOTPRecords,
      expectedStatus: 200,
      expectedContent: [`"id":"user1_0"`],
    },
  ],
};

export const recordCrudOTPDelete: Suite = {
  file: "apis/record_crud_otp_test.go",
  func: "TestRecordCrudOTPDelete",
  scenarios: [
    {
      name: "guest",
      method: "DELETE",
      url: "/api/collections/_otps/records/user1_0",
      prepare: stubOTPRecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-owner auth",
      method: "DELETE",
      url: "/api/collections/_otps/records/user1_0",
      // clients, test@example.com
      headers: { Authorization: clientsToken },
      prepare: stubOTPRecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "DELETE",
      url: "/api/collections/_otps/records/user1_0",
      // users, test@example.com
      headers: { Authorization: usersToken },
      prepare: stubOTPRecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "DELETE",
      url: "/api/collections/_otps/records/user1_0",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      prepare: stubOTPRecords,
      expectedStatus: 204,
    },
  ],
};

export const recordCrudOTPCreate: Suite = {
  file: "apis/record_crud_otp_test.go",
  func: "TestRecordCrudOTPCreate",
  scenarios: [
    {
      name: "guest",
      method: "POST",
      url: "/api/collections/_otps/records",
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"password":      "abc"
		}`,
      prepare: stubOTPRecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "POST",
      url: "/api/collections/_otps/records",
      // users, test@example.com
      headers: { Authorization: usersToken },
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"password":      "abc"
		}`,
      prepare: stubOTPRecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "POST",
      url: "/api/collections/_otps/records",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      body: `{
			"recordRef":     "4q1xlclmfloku33",
			"collectionRef": "_pb_users_auth_",
			"password":      "abc"
		}`,
      prepare: stubOTPRecords,
      expectedStatus: 200,
      expectedContent: [`"recordRef":"4q1xlclmfloku33"`],
    },
  ],
};

export const recordCrudOTPUpdate: Suite = {
  file: "apis/record_crud_otp_test.go",
  func: "TestRecordCrudOTPUpdate",
  scenarios: [
    {
      name: "guest",
      method: "PATCH",
      url: "/api/collections/_otps/records/user1_0",
      body: `{
			"password":"abc"
		}`,
      prepare: stubOTPRecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "owner regular auth",
      method: "PATCH",
      url: "/api/collections/_otps/records/user1_0",
      // users, test@example.com
      headers: { Authorization: usersToken },
      body: `{
			"password":"abc"
		}`,
      prepare: stubOTPRecords,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers auth",
      method: "PATCH",
      url: "/api/collections/_otps/records/user1_0",
      // superusers, test@example.com
      headers: { Authorization: superuserToken },
      body: `{
			"password":"abc"
		}`,
      prepare: stubOTPRecords,
      expectedStatus: 200,
      expectedContent: [`"id":"user1_0"`],
    },
  ],
};

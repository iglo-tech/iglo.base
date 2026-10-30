// Upstream: apis/batch_test.go (TestBatchRequest)
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).
// BeforeTestFunc steps become `prepare` steps on the fixture copy, and
// AfterTestFunc checks become `after` checks through the records API. The
// ExpectedEvents hook counts are dropped.
//
// "transaction timeout" is not here: upstream delays the items with a hook
// (OnRecordCreateRequest) that the binary cannot take. Its result is covered
// by test/batch/batch.test.ts with an injected clock (D28).

import { after } from "@test/scenarios/batch-checks";
import { multipart } from "@test/scenarios/multipart";
import { checks, recordHas, recordMissing } from "@test/scenarios/record-checks";
import { clientsToken, superuserToken } from "@test/scenarios/record-crud";
import type { PrepareContext, Suite } from "@test/scenarios/scenario";
import { changeSettings } from "@test/scenarios/settings-prepare";

function batchSettings(change: Record<string, unknown>): (ctx: PrepareContext) => void {
  return ({ dataDir }) => {
    changeSettings(dataDir, (settings) => {
      Object.assign(settings["batch"] as Record<string, unknown>, change);
    });
  };
}

const formData = multipart(
  {
    "@jsonPayload": `{
				"requests":[
					{"method":"POST", "url":"/api/collections/demo3/records", "body": {"title": "batch1"}},
					{"method":"POST", "url":"/api/collections/demo3/records", "body": {"title": "batch2"}},
					{"method":"POST", "url":"/api/collections/demo3/records", "body": {"title": "batch3"}},
					{"method":"PATCH", "url":"/api/collections/demo3/records/lcl9d87w22ml6jy", "body": {"files-": "test_FLurQTgrY8.txt"}}
				]
			}`,
  },
  "requests.0.files",
  "requests.0.files",
  "requests.0.files",
  "requests[2].files",
);

export const batchRequest: Suite = {
  file: "apis/batch_test.go",
  func: "TestBatchRequest",
  scenarios: [
    {
      name: "disabled batch requets",
      method: "POST",
      url: "/api/batch",
      prepare: batchSettings({ enabled: false }),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "max request limits reached",
      method: "POST",
      url: "/api/batch",
      body: `{
				"requests": [
					{"method":"GET", "url":"/test1"},
					{"method":"GET", "url":"/test2"},
					{"method":"GET", "url":"/test3"}
				]
			}`,
      prepare: batchSettings({ enabled: true, maxRequests: 2 }),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"requests":{"code":"validation_length_too_long"`],
    },
    {
      name: "trigger requests validations",
      method: "POST",
      url: "/api/batch",
      body: `{
				"requests": [
					{},
					{"method":"GET", "url":"/valid"},
					{"method":"invalid", "url":"/valid"},
					{"method":"POST", "url":"${"a".repeat(2001)}"}
				]
			}`,
      prepare: batchSettings({ enabled: true, maxRequests: 100 }),
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"requests":{`,
        `"0":{"method":{"code":"validation_required"`,
        `"2":{"method":{"code":"validation_in_invalid"`,
        `"3":{"url":{"code":"validation_length_too_long"`,
      ],
      notExpectedContent: [`"1":`],
    },
    {
      name: "unknown batch request action",
      method: "POST",
      url: "/api/batch",
      body: `{
				"requests": [
					{"method":"GET", "url":"/api/health"}
				]
			}`,
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"requests":{`,
        `0":{"code":"batch_request_failed"`,
        `"response":{`,
      ],
    },
    {
      name: "base 2 successful and 1 failed (public collection)",
      method: "POST",
      url: "/api/batch",
      body: `{
				"requests": [
                    {"method":"POST", "url":"/api/collections/demo2/records", "body": {"title": "batch1"}},
					{"method":"POST", "url":"/api/collections/demo2/records", "body": {"title": "batch2"}},
					{"method":"POST", "url":"/api/collections/demo2/records", "body": {"title": ""}}
				]
			}`,
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"response":{`,
        `"2":{"code":"batch_request_failed"`,
        `"response":{"data":{"title":{"code":"validation_required"`,
      ],
      notExpectedContent: [`"0":`, `"1":`],
      after: after.titleCount("demo2", "batch", 0),
    },
    {
      name: "base 4 successful (public collection)",
      method: "POST",
      url: "/api/batch",
      body: `{
				"requests": [
					{"method":"POST", "url":"/api/collections/demo2/records", "body": {"title": "batch1"}},
					{"method":"POST", "url":"/api/collections/demo2/records", "body": {"title": "batch2"}},
					{"method":"PUT", "url":"/api/collections/demo2/records", "body": {"title": "batch3"}},
					{"method":"PUT", "url":"/api/collections/demo2/records?fields=*,id:excerpt(4,true)", "body": {"id":"achvryl401bhse3","title": "batch4"}}
				]
			}`,
      expectedStatus: 200,
      expectedContent: [
        `"title":"batch1"`,
        `"title":"batch2"`,
        `"title":"batch3"`,
        `"title":"batch4"`,
        `"id":"achv..."`,
        `"active":false`,
        `"active":true`,
        `"status":200`,
        `"body":{`,
      ],
      after: after.titleCount("demo2", "batch", 4),
    },
    {
      name: "mixed create/update/delete (non-superuser rule failure)",
      method: "POST",
      url: "/api/batch",
      body: `{
				"requests": [
					{"method":"POST", "url":"/api/collections/demo2/records", "body": {"title": "batch_create"}},
					{"method":"DELETE", "url":"/api/collections/demo2/records/achvryl401bhse3"},
					{"method":"PATCH", "url":"/api/collections/demo3/records/1tmknxy2868d869", "body": {"title": "batch_update"}}
				]
			}`,
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"requests":{`,
        `"2":{"code":"batch_request_failed"`,
        `"response":{`,
      ],
      // only demo3 requires authentication
      notExpectedContent: [`"0":`, `"1":`],
      after: checks(
        after.titleCount("demo2", "batch_create", 0),
        after.titleCount("demo3", "batch_update", 0),
        recordHas("demo2", "achvryl401bhse3"),
      ),
    },
    {
      name: "mixed create/update/delete (superuser rule failure)",
      method: "POST",
      url: "/api/batch",
      headers: { Authorization: clientsToken },
      body: `{
				"requests": [
					{"method":"DELETE", "url":"/api/collections/demo2/records/achvryl401bhse3", "headers": {"Authorization": "ignored"}},
					{"method":"PATCH", "url":"/api/collections/demo3/records/1tmknxy2868d869", "body": {"title": "batch_update"}, "headers": {"Authorization": "ignored"}},
					{"method":"POST", "url":"/api/collections/_superusers/records", "body": {"email":"test_batch@example.com","password":"1234567890"}}
				]
			}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"requests":{`, `"2":{"code":"batch_request_failed"`, `403`],
      notExpectedContent: [`"0":`, `"1":`],
      after: checks(
        recordHas("demo2", "achvryl401bhse3"),
        after.titleCount("demo3", "batch_update", 0),
        after.superuserMissing("test_batch@example.com"),
      ),
    },
    {
      name: "mixed create/update/delete (rules success)",
      method: "POST",
      url: "/api/batch",
      headers: { Authorization: clientsToken },
      body: `{
				"requests": [
					{"method":"POST", "url":"/api/collections/demo2/records", "body": {"title": "batch_create"}, "headers": {"Authorization": "ignored"}},
					{"method":"DELETE", "url":"/api/collections/demo2/records/achvryl401bhse3", "headers": {"Authorization": "ignored"}},
					{"method":"PATCH", "url":"/api/collections/demo3/records/1tmknxy2868d869", "body": {"title": "batch_update"}, "headers": {"Authorization": "ignored"}}
				]
			}`,
      expectedStatus: 200,
      expectedContent: [
        `"title":"batch_create"`,
        `"title":"batch_update"`,
        `"status":200`,
        `"status":204`,
        `"body":{`,
        `"body":null`,
      ],
      after: checks(
        after.titleCount("demo2", "batch_create", 1),
        after.titleCount("demo3", "batch_update", 1),
        recordMissing("demo2", "achvryl401bhse3"),
      ),
    },
    {
      name: "mixed create/update/delete (superuser auth)",
      method: "POST",
      url: "/api/batch",
      headers: { Authorization: superuserToken },
      body: `{
				"requests": [
					{"method":"POST", "url":"/api/collections/demo2/records", "body": {"title": "batch_create"}},
					{"method":"DELETE", "url":"/api/collections/demo2/records/achvryl401bhse3"},
					{"method":"PATCH", "url":"/api/collections/demo3/records/1tmknxy2868d869", "body": {"title": "batch_update"}}
				]
			}`,
      expectedStatus: 200,
      expectedContent: [
        `"title":"batch_create"`,
        `"title":"batch_update"`,
        `"status":200`,
        `"status":204`,
        `"body":{`,
        `"body":null`,
      ],
      after: checks(
        after.titleCount("demo2", "batch_create", 1),
        after.titleCount("demo3", "batch_update", 1),
        recordMissing("demo2", "achvryl401bhse3"),
      ),
    },
    {
      name: "cascade delete/update",
      method: "POST",
      url: "/api/batch",
      headers: { Authorization: superuserToken },
      body: `{
				"requests": [
					{"method":"DELETE", "url":"/api/collections/demo3/records/1tmknxy2868d869"},
					{"method":"DELETE", "url":"/api/collections/demo3/records/mk5fmymtx4wsprk"}
				]
			}`,
      expectedStatus: 200,
      expectedContent: [`"status":204`, `"body":null`],
      notExpectedContent: [`"status":200`, `"body":{`],
      after: checks(
        recordMissing("demo2", "1tmknxy2868d869"),
        recordMissing("demo2", "mk5fmymtx4wsprk"),
        recordMissing("demo2", "qzaqccwrmva4o1n"),
      ),
    },
    {
      name: "multipart/form-data + file upload",
      method: "POST",
      url: "/api/batch",
      body: formData.body,
      headers: { Authorization: clientsToken, ...formData.headers },
      expectedStatus: 200,
      expectedContent: [
        `"title":"batch1"`,
        `"title":"batch2"`,
        `"title":"batch3"`,
        `"id":"lcl9d87w22ml6jy"`,
        `"files":["300_UhLKX91HVb.png"]`,
        `"tmpfile_`,
        `"status":200`,
        `"body":{`,
      ],
      after: checks(
        after.filesCount("demo3", `title="batch1"`, 3),
        after.filesCount("demo3", `title="batch2"`, 0),
        after.filesCount("demo3", `title="batch3"`, 1),
        after.filesCount("demo3", `id="lcl9d87w22ml6jy"`, 1),
      ),
    },
    {
      name: "create/update with expand query params",
      method: "POST",
      url: "/api/batch",
      headers: { Authorization: superuserToken },
      body: `{
				"requests": [
					{"method":"POST", "url":"/api/collections/demo5/records?expand=rel_one", "body": {"total": 9, "rel_one":"qzaqccwrmva4o1n"}},
					{"method":"PATCH", "url":"/api/collections/demo5/records/qjeql998mtp1azp?expand=rel_many", "body": {"total": 10}}
				]
			}`,
      expectedStatus: 200,
      expectedContent: [
        `"body":{`,
        `"id":"qjeql998mtp1azp"`,
        `"id":"qzaqccwrmva4o1n"`,
        `"id":"i9naidtvr6qsgb4"`,
        `"expand":{"rel_one"`,
        `"expand":{"rel_many"`,
      ],
    },
    {
      name: "check body limit middleware",
      method: "POST",
      url: "/api/batch",
      headers: { Authorization: superuserToken },
      body: `{
				"requests": [
					{"method":"POST", "url":"/api/collections/demo5/records?expand=rel_one", "body": {"total": 9, "rel_one":"qzaqccwrmva4o1n"}},
					{"method":"PATCH", "url":"/api/collections/demo5/records/qjeql998mtp1azp?expand=rel_many", "body": {"total": 10}}
				]
			}`,
      prepare: batchSettings({ maxBodySize: 10 }),
      expectedStatus: 413,
      expectedContent: [`"data":{}`],
    },
  ],
};

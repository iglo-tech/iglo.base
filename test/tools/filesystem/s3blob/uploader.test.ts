// Upstream: tools/filesystem/internal/s3blob/s3/uploader_test.go
//
// Every upload goes to a local server, and the test reads back each request
// it sent. The Go test's request functions are not ported: the headers they
// set are the Uploader's headers option. Blank, no-S3 and no-payload cases are
// not runtime checks here: the Uploader type requires them. Multipart parts
// are sent in any order, so the recorded requests are sorted before they are
// compared.

import { afterEach, describe, expect, test } from "bun:test";

import { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";
import { Uploader } from "@/tools/filesystem/internal/s3blob/s3/uploader";
import { type RecordedRequest, type S3Recorder, startS3Recorder } from "@test/support/s3-recorder";

const recorders: S3Recorder[] = [];
afterEach(() => {
  for (const r of recorders.splice(0)) {
    r.stop();
  }
});

function startRecorder(respond: (req: RecordedRequest) => Response): S3Recorder {
  const recorder = startS3Recorder(respond);
  recorders.push(recorder);
  return recorder;
}

function s3For(recorder: S3Recorder): S3 {
  return new S3({
    region: "test_region",
    bucket: "test_bucket",
    endpoint: recorder.endpoint,
    accessKey: "123",
    secretKey: "abc",
    usePathStyle: true,
  });
}

const testHeaders = (): Headers => new Headers({ test_header: "test" });

// every request carries the caller's header and is signed with access key 123
function expectSignedWithHeader(req: RecordedRequest): void {
  expect(req.headers.get("test_header")).toBe("test");
  expect(req.headers.get("Authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=123\//);
}

// "METHOD /path?query" of each request, sorted
function sortedTargets(requests: RecordedRequest[]): string[] {
  return requests.map((r) => `${r.method} ${r.path}?${r.query}`).toSorted();
}

const initiateBody = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult>
  <Bucket>test_bucket</Bucket>
  <Key>test_key</Key>
  <UploadId>test_id</UploadId>
</InitiateMultipartUploadResult>`;

// answers the requests of a multipart upload of key test_key: the failures
// are given by the part number and the complete request status
function multipartResponder(
  options: {
    failPart?: number;
    failPartStatus?: number;
    completeStatus?: number;
    completeBody?: string;
    emptyEtagPart?: number;
    initBody?: string;
  } = {},
): (req: RecordedRequest) => Response {
  return (req) => {
    const params = new URLSearchParams(req.query);
    if (req.method === "POST" && req.query === "uploads") {
      return new Response(options.initBody ?? initiateBody);
    }
    if (req.method === "PUT" && params.has("partNumber")) {
      const partNumber = Number(params.get("partNumber"));
      if (partNumber === options.failPart) {
        return new Response("", { status: options.failPartStatus ?? 400 });
      }
      if (partNumber === options.emptyEtagPart) {
        return new Response("");
      }
      return new Response("", { headers: { ETag: `"etag${partNumber}"` } });
    }
    if (req.method === "POST" && params.has("uploadId")) {
      return new Response(options.completeBody ?? "", { status: options.completeStatus ?? 200 });
    }
    return new Response("");
  };
}

describe("Uploader required fields", () => {
  test("rejects an upload without a key before sending anything", async () => {
    const recorder = startRecorder(() => new Response(""));
    const uploader = new Uploader({
      s3: s3For(recorder),
      payload: new Blob(["test"]),
      key: "",
    });

    await expect(uploader.upload()).rejects.toThrow("Uploader.Key is required");
    expect(recorder.requests).toHaveLength(0);
  });

  test("uploads with S3, Key and Payload", async () => {
    const recorder = startRecorder(() => new Response(""));
    const uploader = new Uploader({
      s3: s3For(recorder),
      payload: new Blob(["test"]),
      key: "abc",
    });

    await uploader.upload();

    expect(recorder.requests).toHaveLength(1);
    const [req] = recorder.requests;
    expect(req?.method).toBe("PUT");
    expect(req?.path).toBe("/test_bucket/abc");
  });
});

test("single upload sends the payload in one PUT", async () => {
  const recorder = startRecorder(() => new Response(""));
  const uploader = new Uploader({
    s3: s3For(recorder),
    key: "test_key",
    payload: new Blob(["abcdefg"]),
    metadata: new Map([
      ["a", "123"],
      ["b", "456"],
    ]),
    headers: testHeaders(),
    minPartSize: 8,
  });

  await uploader.upload();

  expect(recorder.requests).toHaveLength(1);
  const req = recorder.requests[0] as RecordedRequest;
  expect(req.method).toBe("PUT");
  expect(req.path).toBe("/test_bucket/test_key");
  expect(req.query).toBe("");
  expect(new TextDecoder().decode(req.body)).toBe("abcdefg");
  expect(req.headers.get("Content-Length")).toBe("7");
  expect(req.headers.get("x-amz-meta-a")).toBe("123");
  expect(req.headers.get("x-amz-meta-b")).toBe("456");
  expectSignedWithHeader(req);
});

const upload = (recorder: ReturnType<typeof startRecorder>) =>
  new Uploader({
    s3: s3For(recorder),
    key: "test_key",
    payload: new Blob(["abcdef"]),
    headers: testHeaders(),
    minPartSize: 3,
  }).upload();

describe("Uploader multipart upload", () => {
  // the Go test's MaxConcurrency values; the worker count does not change
  // what goes on the wire
  test.each([-1, 0, 1, 10])("succeeds with MaxConcurrency %d", async (maxConcurrency) => {
    const recorder = startRecorder(multipartResponder());
    const uploader = new Uploader({
      s3: s3For(recorder),
      key: "test_key",
      payload: new Blob(["abcdefg"]),
      metadata: new Map([
        ["a", "123"],
        ["b", "456"],
      ]),
      headers: testHeaders(),
      minPartSize: 3,
      maxConcurrency,
    });

    await uploader.upload();

    expect(sortedTargets(recorder.requests)).toEqual([
      "POST /test_bucket/test_key?uploadId=test_id",
      "POST /test_bucket/test_key?uploads",
      "PUT /test_bucket/test_key?partNumber=1&uploadId=test_id",
      "PUT /test_bucket/test_key?partNumber=2&uploadId=test_id",
      "PUT /test_bucket/test_key?partNumber=3&uploadId=test_id",
    ]);

    const initiate = recorder.requests.find((r) => r.query === "uploads");
    expect(initiate?.headers.get("x-amz-meta-a")).toBe("123");
    expect(initiate?.headers.get("x-amz-meta-b")).toBe("456");

    const parts = recorder.requests.filter((r) => r.method === "PUT");
    const bodies = Object.fromEntries(
      parts.map((r) => [
        new URLSearchParams(r.query).get("partNumber"),
        new TextDecoder().decode(r.body),
      ]),
    );
    expect(bodies).toEqual({ "1": "abc", "2": "def", "3": "g" });
    for (const r of parts) {
      expect(r.headers.get("Content-Length")).toBe(String(r.body.length));
    }

    const complete = recorder.requests.find(
      (r) => r.method === "POST" && new URLSearchParams(r.query).has("uploadId"),
    );
    expect(new TextDecoder().decode(complete?.body)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>' +
        "<Part><ETag>&#34;etag1&#34;</ETag><PartNumber>1</PartNumber></Part>" +
        "<Part><ETag>&#34;etag2&#34;</ETag><PartNumber>2</PartNumber></Part>" +
        "<Part><ETag>&#34;etag3&#34;</ETag><PartNumber>3</PartNumber></Part>" +
        "</CompleteMultipartUpload>",
    );

    for (const r of recorder.requests) {
      expectSignedWithHeader(r);
    }
  });

  test("a failed part aborts the upload and reports the part error", async () => {
    const recorder = startRecorder(multipartResponder({ failPart: 2 }));
    const uploader = new Uploader({
      s3: s3For(recorder),
      key: "test_key",
      payload: new Blob(["abcdefg"]),
      metadata: new Map([
        ["a", "123"],
        ["b", "456"],
      ]),
      headers: testHeaders(),
      minPartSize: 3,
    });

    await expect(uploader.upload()).rejects.toThrow("400 S3ResponseError");

    // the other workers may have sent part 3 before the failure stopped them,
    // but nothing is sent after the abort, and the upload is never completed
    const targets = sortedTargets(recorder.requests);
    expect(targets).toContain("POST /test_bucket/test_key?uploads");
    expect(targets).toContain("PUT /test_bucket/test_key?partNumber=2&uploadId=test_id");
    expect(targets.filter((t) => t.startsWith("POST") && t.includes("uploadId="))).toHaveLength(0);

    const last = recorder.requests.at(-1);
    expect(last?.method).toBe("DELETE");
    expect(last?.query).toBe("uploadId=test_id");
    expectSignedWithHeader(last as RecordedRequest);
  });

  test("a failed complete request aborts the upload", async () => {
    const recorder = startRecorder(multipartResponder({ completeStatus: 400 }));
    const uploader = new Uploader({
      s3: s3For(recorder),
      key: "test_key",
      payload: new Blob(["abcdef"]),
      metadata: new Map([
        ["a", "123"],
        ["b", "456"],
      ]),
      headers: testHeaders(),
      minPartSize: 3,
    });

    await expect(uploader.upload()).rejects.toThrow("400 S3ResponseError");

    expect(sortedTargets(recorder.requests)).toEqual([
      "DELETE /test_bucket/test_key?uploadId=test_id",
      "POST /test_bucket/test_key?uploadId=test_id",
      "POST /test_bucket/test_key?uploads",
      "PUT /test_bucket/test_key?partNumber=1&uploadId=test_id",
      "PUT /test_bucket/test_key?partNumber=2&uploadId=test_id",
    ]);
    expect(recorder.requests.at(-1)?.method).toBe("DELETE");
    for (const r of recorder.requests) {
      expectSignedWithHeader(r);
    }
  });
  test("a 200 Complete response carrying an <Error> aborts the upload", async () => {
    const recorder = startRecorder(
      multipartResponder({
        completeBody:
          '<?xml version="1.0"?><Error><Code>InternalError</Code><Message>try again</Message></Error>',
      }),
    );

    await expect(upload(recorder)).rejects.toThrow("200 InternalError: try again");
    expect(recorder.requests.at(-1)?.method).toBe("DELETE");
  });

  test("a 200 Complete response with a result body succeeds", async () => {
    const recorder = startRecorder(
      multipartResponder({
        completeBody:
          "<CompleteMultipartUploadResult><Location>x</Location></CompleteMultipartUploadResult>",
      }),
    );

    await upload(recorder);
    expect(recorder.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("a part response without an ETag aborts the upload", async () => {
    const recorder = startRecorder(multipartResponder({ emptyEtagPart: 1 }));

    await expect(upload(recorder)).rejects.toThrow("missing ETag in the response of part 1");
    expect(recorder.requests.at(-1)?.method).toBe("DELETE");
    expect(
      recorder.requests.filter((r) => r.method === "POST" && r.query.includes("uploadId=")),
    ).toHaveLength(0);
  });

  test("an init response without an UploadId fails before any part is sent", async () => {
    const recorder = startRecorder(
      multipartResponder({
        initBody:
          "<InitiateMultipartUploadResult><UploadId></UploadId></InitiateMultipartUploadResult>",
      }),
    );

    await expect(upload(recorder)).rejects.toThrow("missing UploadId");
    expect(recorder.requests).toHaveLength(1);
  });
});

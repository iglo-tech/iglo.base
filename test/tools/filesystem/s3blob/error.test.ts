// Upstream: tools/filesystem/internal/s3blob/s3/error_test.go
//
// The errors come off the wire: a response of 400 or more becomes a
// ResponseError, so the Go test's status 123 is not used (signAndSend takes
// anything under 400 as a success). The Go test's "empty" case (status 0) and
// its case without a raw body are not reachable this way and are dropped. The
// RequestId and Resource members of the XML are not kept by ResponseError.

import { afterEach, describe, expect, test } from "bun:test";

import { ResponseError } from "@/tools/filesystem/internal/s3blob/s3/error";
import { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";
import { type S3Recorder, startS3Recorder } from "@test/support/s3-recorder";

const recorders: S3Recorder[] = [];
afterEach(() => {
  for (const r of recorders.splice(0)) {
    r.stop();
  }
});

// a request that the local server answers with the status and body given
async function failureOf(status: number, body: string): Promise<unknown> {
  const recorder = startS3Recorder(() => new Response(body, { status }));
  recorders.push(recorder);

  const s3 = new S3({
    region: "test_region",
    bucket: "test_bucket",
    endpoint: recorder.endpoint,
    accessKey: "123",
    secretKey: "abc",
    usePathStyle: true,
  });

  return s3.signAndSend({ method: "GET", url: s3.url("test_key") }).then(
    () => {
      throw new Error("expected the request to fail");
    },
    (err: unknown) => err,
  );
}

const errorBody = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>test_code</Code><Message>test_message</Message><RequestId>test_request_id</RequestId><Resource>test_resource</Resource></Error>`;

test("an error response is read into the error fields", async () => {
  const err = await failureOf(403, errorBody);

  expect(err).toBeInstanceOf(ResponseError);
  const respErr = err as ResponseError;
  expect(respErr.status).toBe(403);
  expect(respErr.code).toBe("test_code");
  expect(respErr.s3Message).toBe("test_message");
  expect(new TextDecoder().decode(respErr.raw)).toBe(errorBody);
});

describe("ResponseError message", () => {
  test("with code and message", async () => {
    const err = (await failureOf(403, errorBody)) as ResponseError;
    expect(err.message).toBe(`403 test_code: test_message\n(RAW: ${errorBody})`);
  });

  test("without a body", async () => {
    const err = (await failureOf(403, "")) as ResponseError;
    expect(err.message).toBe("403 S3ResponseError");
  });
});

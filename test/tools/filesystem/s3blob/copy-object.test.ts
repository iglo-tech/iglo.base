// Upstream: tools/filesystem/internal/s3blob/s3/copy_object.go

import { afterEach, expect, test } from "bun:test";

import { copyObject } from "@/tools/filesystem/internal/s3blob/s3/copy-object";
import { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";
import { type S3Recorder, startS3Recorder } from "@test/support/s3-recorder";

let recorder: S3Recorder | undefined;

afterEach(() => {
  recorder?.stop();
  recorder = undefined;
});

function client(body: string): S3 {
  recorder = startS3Recorder(() => new Response(body));
  return new S3({
    bucket: "b",
    region: "r",
    endpoint: recorder.endpoint,
    accessKey: "k",
    secretKey: "s",
    usePathStyle: true,
  });
}

test("the response's root element may have any name", async () => {
  const s3 = client("<AnyName><ETag>x</ETag></AnyName>");
  await copyObject(s3, "src", "dst");
  expect(recorder?.requests[0]?.headers.get("x-amz-copy-source")).toBe("b%2Fsrc");
});

test("an empty response fails as Go's decoder does", async () => {
  await expect(copyObject(client(""), "src", "dst")).rejects.toThrow("EOF");
});

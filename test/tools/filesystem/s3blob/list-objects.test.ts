// Upstream: tools/filesystem/internal/s3blob/s3/list_objects_test.go
//
// The query of each list request is read back from the wire. The response
// keeps the members the driver reads; the owner, storage class, restore status
// and the list's own echo fields (name, prefix, keyCount, maxKeys...) are not
// ported. The test header of the Go test came from request functions, which
// listObjects does not take.

import { afterEach, describe, expect, test } from "bun:test";

import { listObjects, type ListParams } from "@/tools/filesystem/internal/s3blob/s3/list-objects";
import { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";
import { type S3Recorder, startS3Recorder } from "@test/support/s3-recorder";

const emptyList = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></ListBucketResult>`;

const recorders: S3Recorder[] = [];
afterEach(() => {
  for (const r of recorders.splice(0)) {
    r.stop();
  }
});

function startRecorder(body: string): S3Recorder {
  const recorder = startS3Recorder(() => new Response(body));
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

describe("list request query", () => {
  test.each([
    ["blank", {}, "list-type=2"],
    [
      "filled",
      {
        continuationToken: "test_ct",
        delimiter: "test_delimiter",
        prefix: "test_prefix",
        encodingType: "test_et",
        startAfter: "test_sa",
        maxKeys: 1,
        fetchOwner: true,
      },
      "continuation-token=test_ct&delimiter=test_delimiter&encoding-type=test_et&fetch-owner=true&list-type=2&max-keys=1&prefix=test_prefix&start-after=test_sa",
    ],
  ] as [string, ListParams, string][])("%s", async (_name, params, expectedQuery) => {
    const recorder = startRecorder(emptyList);
    await listObjects(s3For(recorder), params);

    expect(recorder.requests).toHaveLength(1);
    const req = recorder.requests[0];
    expect(req?.method).toBe("GET");
    expect(req?.path).toBe("/test_bucket/");
    expect(req?.query).toBe(expectedQuery);
  });
});

test("parses a list response", async () => {
  const recorder = startRecorder(`
    <?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Name>example</Name>
      <EncodingType>test_encoding</EncodingType>
      <Prefix>a/</Prefix>
      <Delimiter>/</Delimiter>
      <ContinuationToken>ct</ContinuationToken>
      <NextContinuationToken>nct</NextContinuationToken>
      <StartAfter>example0.txt</StartAfter>
      <KeyCount>1</KeyCount>
      <MaxKeys>3</MaxKeys>
      <IsTruncated>true</IsTruncated>
      <Contents>
        <Key>example1.txt</Key>
        <LastModified>2025-01-01T01:02:03.123Z</LastModified>
        <ChecksumAlgorithm>test_ca</ChecksumAlgorithm>
        <ETag>test_etag1</ETag>
        <Size>123</Size>
        <StorageClass>STANDARD</StorageClass>
        <Owner>
          <DisplayName>owner_dn</DisplayName>
          <ID>owner_id</ID>
        </Owner>
        <RestoreStatus>
          <RestoreExpiryDate>2025-01-02T01:02:03.123Z</RestoreExpiryDate>
          <IsRestoreInProgress>true</IsRestoreInProgress>
        </RestoreStatus>
      </Contents>
      <Contents>
        <Key>example2.txt</Key>
        <LastModified>2025-01-02T01:02:03.123Z</LastModified>
        <ETag>test_etag2</ETag>
        <Size>456</Size>
        <StorageClass>STANDARD</StorageClass>
      </Contents>
      <CommonPrefixes>
        <Prefix>a/b/</Prefix>
      </CommonPrefixes>
      <CommonPrefixes>
        <Prefix>a/c/</Prefix>
      </CommonPrefixes>
    </ListBucketResult>
  `);

  const resp = await listObjects(s3For(recorder), {
    continuationToken: "test_ct",
    delimiter: "test_delimiter",
    prefix: "test_prefix",
    encodingType: "test_et",
    startAfter: "test_sa",
    maxKeys: 10,
    fetchOwner: true,
  });

  // the request carries the parameters and the signature
  expect(recorder.requests).toHaveLength(1);
  const req = recorder.requests[0];
  expect(req?.query).toBe(
    "continuation-token=test_ct&delimiter=test_delimiter&encoding-type=test_et&fetch-owner=true&list-type=2&max-keys=10&prefix=test_prefix&start-after=test_sa",
  );
  expect(req?.headers.get("Authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=123\//);

  expect(resp.nextContinuationToken).toBe("nct");
  expect(resp.commonPrefixes).toEqual(["a/b/", "a/c/"]);
  expect(resp.contents).toEqual([
    {
      key: "example1.txt",
      etag: "test_etag1",
      lastModified: BigInt(Date.parse("2025-01-01T01:02:03.123Z")) * 1_000_000n,
      size: 123,
    },
    {
      key: "example2.txt",
      etag: "test_etag2",
      lastModified: BigInt(Date.parse("2025-01-02T01:02:03.123Z")) * 1_000_000n,
      size: 456,
    },
  ]);
});

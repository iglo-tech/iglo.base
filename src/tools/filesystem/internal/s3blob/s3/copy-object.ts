// Upstream: tools/filesystem/internal/s3blob/s3/copy_object.go
//
// The response's checksums, which nothing reads, are not kept. Its root element
// may have any name, as CopyObjectResponse has no XMLName.

import { urlPathEscape } from "@/tools/filesystem/internal/s3blob/s3/url-escape";
import type { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";
import { parseXml } from "@/tools/filesystem/internal/s3blob/s3/xml";

// CopyObject copies a single object from srcKey to dstKey destination (both
// keys are expected to be operating within the same bucket).
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
export async function copyObject(
  s3: S3,
  srcKey: string,
  dstKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const headers = new Headers();
  // per the doc the header value must be URL-encoded
  headers.set("x-amz-copy-source", urlPathEscape(`${s3.bucket}/${srcKey.replace(/^\/+/, "")}`));

  const resp = await s3.signAndSend({ method: "PUT", url: s3.url(dstKey), headers, signal });

  parseXml(new Uint8Array(await resp.arrayBuffer()));
}

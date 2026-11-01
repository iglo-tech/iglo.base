// Upstream: tools/filesystem/internal/s3blob/s3/get_object.go

import {
  type HeadObjectResponse,
  loadHeadObject,
} from "@/tools/filesystem/internal/s3blob/s3/head-object";
import type { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";

// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html#API_GetObject_ResponseElements
export interface GetObjectResponse extends HeadObjectResponse {
  body: ReadableStream<Uint8Array> | null;
}

// GetObject retrieves a single object by its key.
//
// NB! Make sure to read or cancel the body after done working with the
// result.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
export async function getObject(
  s3: S3,
  key: string,
  headers?: Headers,
  signal?: AbortSignal,
): Promise<GetObjectResponse> {
  const resp = await s3.signAndSend({ method: "GET", url: s3.url(key), headers, signal });
  return { ...loadHeadObject(resp.headers), body: resp.body };
}

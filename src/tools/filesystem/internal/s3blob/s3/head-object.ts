// Upstream: tools/filesystem/internal/s3blob/s3/head_object.go

import { extractMetadata, type S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";
import { parseTime } from "@/server/serve-content";

// https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html#API_HeadObject_ResponseElements
export interface HeadObjectResponse {
  // Metadata is the extra data that is stored with the S3 object (aka. the
  // "x-amz-meta-*" header values). The map keys are lower-case.
  metadata: Map<string, string>;
  // LastModified in Unix nanoseconds (0 when it does not parse, Go's zero
  // time)
  lastModified: bigint;
  cacheControl: string;
  contentDisposition: string;
  contentEncoding: string;
  contentLanguage: string;
  contentType: string;
  contentRange: string;
  etag: string;
  contentLength: number;
}

// load parses the header values into the HeadObjectResponse fields.
export function loadHeadObject(headers: Headers): HeadObjectResponse {
  const contentLength = Number.parseInt(headers.get("Content-Length") ?? "", 10);
  return {
    lastModified: parseTime(headers.get("Last-Modified") ?? "") ?? 0n,
    cacheControl: headers.get("Cache-Control") ?? "",
    contentDisposition: headers.get("Content-Disposition") ?? "",
    contentEncoding: headers.get("Content-Encoding") ?? "",
    contentLanguage: headers.get("Content-Language") ?? "",
    contentType: headers.get("Content-Type") ?? "",
    contentRange: headers.get("Content-Range") ?? "",
    etag: headers.get("ETag") ?? "",
    contentLength: Number.isNaN(contentLength) ? 0 : contentLength,
    metadata: extractMetadata(headers),
  };
}

// HeadObject sends a HEAD request for a single object to check its existence
// and to retrieve its metadata.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
export async function headObject(
  s3: S3,
  key: string,
  signal?: AbortSignal,
): Promise<HeadObjectResponse> {
  const resp = await s3.signAndSend({ method: "HEAD", url: s3.url(key), signal });
  return loadHeadObject(resp.headers);
}

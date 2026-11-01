// Upstream: tools/filesystem/internal/s3blob/s3/delete_object.go

import type { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";

// DeleteObject deletes a single object by its key.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html
export async function deleteObject(s3: S3, key: string, signal?: AbortSignal): Promise<void> {
  const resp = await s3.signAndSend({ method: "DELETE", url: s3.url(key), signal });
  await resp.arrayBuffer();
}

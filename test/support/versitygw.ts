// Starts versitygw (.upstream/bin/versitygw, see scripts/upstream/prepare.ts)
// with the posix backend on a temp directory and creates a test bucket. The
// credentials are fixed dummy strings for this test server only; they grant
// access to nothing outside its temp directory.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { S3Client } from "bun";

import { spawnChild, waitUntilReady } from "@test/support/child";
import { freePort } from "@test/support/executable";
import { defaultLayout, requireTool, type Layout } from "@test/support/reference-tools";

export const testS3Credentials = {
  accessKeyId: "iglo-test-access-key",
  secretAccessKey: "iglo-test-secret-key-not-real",
  region: "us-east-1",
};

export interface Versitygw {
  endpoint: string;
  bucket: string;
  // a Bun.S3Client for the test bucket
  client: S3Client;
  stop(): Promise<void>;
}

export async function startVersitygw(
  bucket = "iglo-test",
  layout: Layout = defaultLayout,
): Promise<Versitygw> {
  const binary = requireTool("versitygw", layout);
  const root = mkdtempSync(join(tmpdir(), "iglo-base-s3-"));
  // the posix backend keeps each bucket as a directory under its root
  const posixRoot = join(root, "data");
  mkdirSync(join(posixRoot, bucket), { recursive: true });
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawnChild(
    [
      binary,
      "--access",
      testS3Credentials.accessKeyId,
      "--secret",
      testS3Credentials.secretAccessKey,
      "--region",
      testS3Credentials.region,
      "--port",
      `127.0.0.1:${port}`,
      "posix",
      posixRoot,
    ],
    { cwd: root },
  );

  try {
    // any HTTP answer means the gateway is listening; unsigned requests get 403
    await waitUntilReady(child, "versitygw", async () => {
      await fetch(endpoint);
      return true;
    });
  } catch (error) {
    await child.stop();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const client = new S3Client({ ...testS3Credentials, endpoint, bucket });
  return {
    endpoint,
    bucket,
    client,
    async stop() {
      try {
        await child.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

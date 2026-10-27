// Smoke test for the reference S3 server: Bun.S3Client puts, lists and gets
// one object in versitygw's posix backend. Run with `bun run test:reference`.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { startVersitygw, type Versitygw } from "@test/support/versitygw";

let s3: Versitygw;

beforeAll(async () => {
  s3 = await startVersitygw();
});

afterAll(async () => {
  await s3?.stop();
});

test("Bun.S3Client puts, lists and gets one object", async () => {
  const client = s3.client;
  const key = "smoke/hello.txt";
  const body = "hello from the reference S3 server";

  await client.write(key, body);

  const listing = await client.list({ prefix: "smoke/" });
  expect(listing.contents?.map((object) => object.key)).toEqual([key]);

  expect(await client.file(key).text()).toBe(body);
});

// Upstream: tools/subscriptions/message_test.go

import { expect, test } from "bun:test";

import { Message } from "@/tools/subscriptions/message";

test("TestMessageWrite", () => {
  const m = new Message("test_name", new TextEncoder().encode("test_data"));

  const chunks: Uint8Array[] = [];
  m.writeSSE((chunk) => chunks.push(chunk), "test_id");

  const expected = "id:test_id\nevent:test_name\ndata:test_data\n\n";
  const written = Buffer.concat(chunks).toString("utf8");

  expect(written).toBe(expected);
});

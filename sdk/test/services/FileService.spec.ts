// js-sdk v0.28.1 tests/services/FileService.spec.ts
import { describe, test, beforeAll, afterAll, afterEach } from "bun:test";
import { assert } from "@sdk-test/assert";
import { FetchMock } from "@sdk-test/mocks";
import Client from "@sdk/Client";
import { FileService } from "@sdk/services/FileService";

describe("FileService", () => {
  const client = new Client("test_base_url");
  const service = new FileService(client);
  const fetchMock = new FetchMock();

  beforeAll(() => {
    fetchMock.init();
  });

  afterAll(() => {
    fetchMock.restore();
  });

  afterEach(() => {
    fetchMock.clearMocks();
  });

  describe("getUrl()", () => {
    test("Should return empty string (missing record id)", async () => {
      const record = { id: "", collectionId: "123", collectionName: "789" };
      const result = service.getURL(record, "demo.png");

      assert.deepEqual(result, "");
    });

    test("Should return empty string (missing filename)", async () => {
      const record = { id: "456", collectionId: "123", collectionName: "789" };
      const result = service.getURL(record, "");

      assert.deepEqual(result, "");
    });

    test("Should return a formatted url", async () => {
      const record = { id: "456", collectionId: "123", collectionName: "789" };
      const result = service.getURL(record, "demo.png");

      assert.deepEqual(result, "test_base_url/api/files/123/456/demo.png");
    });

    test("Should return a formatted url + query params", async () => {
      const record = { id: "456", collectionId: "123", collectionName: "789" };
      const result = service.getURL(record, "demo=", {
        test: "abc",
        skip1: null,
        skip2: undefined,
        arr: [1, 2],
      });

      assert.deepEqual(result, "test_base_url/api/files/123/456/demo%3D?test=abc&arr=1&arr=2");
    });
  });

  describe("getToken()", () => {
    test("Should send a file token request", async () => {
      fetchMock.on({
        method: "POST",
        url: service.client.buildURL("/api/files/token") + "?q1=123",
        additionalMatcher: (_, config) => {
          return config?.headers?.["x-test"] === "456";
        },
        replyCode: 200,
        replyBody: { token: "789" },
      });

      const result = await service.getToken({
        q1: 123,
        headers: { "x-test": "456" },
      });

      assert.deepEqual(result, "789");
    });
  });
});

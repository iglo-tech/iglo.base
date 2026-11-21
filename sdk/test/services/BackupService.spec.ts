// js-sdk v0.28.1 tests/services/BackupService.spec.ts
import { describe, test, beforeAll, afterAll, afterEach } from "bun:test";
import { assert } from "@sdk-test/assert";
import { FetchMock } from "@sdk-test/mocks";
import Client from "@sdk/Client";
import { BackupService } from "@sdk/services/BackupService";

describe("BackupService", () => {
  const client = new Client("test_base_url");
  const service = new BackupService(client);
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

  describe("getFullList()", () => {
    test("Should fetch all backups", async () => {
      const replyBody = [
        { key: "test1", size: 100, modified: "2023-05-18 10:00:00.123Z" },
        { key: "test2", size: 200, modified: "2023-05-18 11:00:00.123Z" },
      ];

      fetchMock.on({
        method: "GET",
        url: service.client.buildURL("/api/backups") + "?q1=123",
        additionalMatcher: (_, config) => {
          return config?.headers?.["x-test"] === "123";
        },
        replyCode: 200,
        replyBody: replyBody,
      });

      const result = await service.getFullList({
        q1: 123,
        headers: { "x-test": "123" },
      });

      assert.deepEqual(result, replyBody);
    });
  });

  describe("create()", () => {
    test("Should initialize a backup create", async () => {
      fetchMock.on({
        method: "POST",
        url: service.client.buildURL("/api/backups") + "?q1=123",
        body: { name: "@test" },
        additionalMatcher: (_, config) => {
          return config?.headers?.["x-test"] === "123";
        },
        replyCode: 204,
        replyBody: true,
      });

      const result = await service.create("@test", {
        q1: 123,
        headers: { "x-test": "123" },
      });

      assert.deepEqual(result, true);
    });
  });

  describe("upload()", () => {
    test("Should upload a backup", async () => {
      fetchMock.on({
        method: "POST",
        url: service.client.buildURL("/api/backups/upload") + "?q1=123",
        body: { file: "123" },
        additionalMatcher: (_, config) => {
          return config?.headers?.["x-test"] === "123";
        },
        replyCode: 204,
        replyBody: true,
      });

      const result = await service.upload(
        { file: "123" },
        { q1: 123, headers: { "x-test": "123" } },
      );

      assert.deepEqual(result, true);
    });
  });

  describe("delete()", () => {
    test("Should delete a single backup", async () => {
      fetchMock.on({
        method: "DELETE",
        url: service.client.buildURL("/api/backups") + "/%40test?q1=123",
        additionalMatcher: (_, config) => {
          return config?.headers?.["x-test"] === "123";
        },
        replyCode: 204,
        replyBody: true,
      });

      const result = await service.delete("@test", {
        q1: 123,
        headers: { "x-test": "123" },
      });

      assert.deepEqual(result, true);
    });
  });

  describe("restore()", () => {
    test("Should initialize a backup restore", async () => {
      fetchMock.on({
        method: "POST",
        url: service.client.buildURL("/api/backups") + "/%40test/restore?q1=123",
        additionalMatcher: (_, config) => {
          return config?.headers?.["x-test"] === "123";
        },
        replyCode: 204,
        replyBody: true,
      });

      const result = await service.restore("@test", {
        q1: 123,
        headers: { "x-test": "123" },
      });

      assert.deepEqual(result, true);
    });
  });

  describe("getDownloadURL()", () => {
    test("Should initialize a backup getDownloadURL", () => {
      const result = service.getDownloadURL("@token", "@test");

      assert.deepEqual(result, service.client.buildURL("/api/backups") + "/%40test?token=%40token");
    });
  });
});

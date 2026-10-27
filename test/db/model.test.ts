// Upstream: core/db_model_test.go

import { expect, test } from "bun:test";

import { Demo } from "@test/db/models";

test("TestBaseModel", () => {
  const id = "test_id";

  const m = new Demo();
  m.id = id;

  // before PostScan
  expect(m.pk()).toBe(id);
  expect(m.lastSavedPK()).toBe("");
  expect(m.isNew()).toBe(true);

  m.postScan();

  // after PostScan
  expect(m.pk()).toBe(id);
  expect(m.lastSavedPK()).toBe(id);
  expect(m.isNew()).toBe(false);

  m.markAsNew();

  // after MarkAsNew
  expect(m.pk()).toBe(id);
  expect(m.lastSavedPK()).toBe("");
  expect(m.isNew()).toBe(true);

  // mark as not new without id
  m.markAsNotNew();

  // after MarkAsNotNew
  expect(m.pk()).toBe(id);
  expect(m.lastSavedPK()).toBe(id);
  expect(m.isNew()).toBe(false);
});

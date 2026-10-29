// Upstream: core/field_file_test.go (TestFileFieldIntercept,
// TestFileFieldInterceptTx, checkRecordFiles)
//
// The other tests of the file are in file.test.ts. These save records of
// the fixture's demo1 collection through the record save chain
// (src/records/record-save.ts) on a copy of the vendored fixture and check
// the stored files in its pb_data/storage. The transaction test saves
// inside a write transaction, where the uploads run synchronously.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { findCollectionByNameOrId, runInAppTransaction } from "@/collections/collection-query";
import type { Collection } from "@/collections/collection-model";
import { TextField } from "@/fields/text";
import { newRecord, type Record } from "@/records/record-model";
import type { RecordsApp } from "@/records/record-query";
import { saveRecord, saveRecordSync } from "@/records/record-save";
import { type File, NewFileFromBytes } from "@/tools/filesystem/file";
import { toUniqueStringSlice } from "@/tools/list/list";
import { marshal } from "@/tools/types/go-json";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";
import { expectValidationErrors } from "@test/collections/validation";

const content = new TextEncoder().encode("test");

async function newFiles(): Promise<File[]> {
  return Promise.all(
    ["new1.txt", "new2.txt", "new3.txt", "new4.txt"].map((n) => NewFileFromBytes(content, n)),
  );
}

// demo1 with its "text" field required (to trigger a validation error)
function demo1WithRequiredText(app: RecordsApp): Collection {
  const demo1 = findCollectionByNameOrId(app, "demo1");
  (demo1.fields.getByName("text") as TextField).required = true;
  return demo1;
}

function errorOf(fn: () => void): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

async function errorOfAsync(p: Promise<void>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err as Error;
  }
}

// the record's stored files (without thumbs) are exactly expectedKeys
function checkRecordFiles(app: RecordsApp, record: Record, expectedKeys: string[]): void {
  const fsys = app.filesystem.newFilesystem();
  try {
    const objects = fsys.list(record.baseFilesPath() + "/");
    const objectKeys = objects.map((o) => o.key).filter((k) => !k.includes("/thumbs_"));
    expect(objectKeys.toSorted()).toEqual(
      expectedKeys.map((k) => record.baseFilesPath() + "/" + k).toSorted(),
    );
  } finally {
    fsys.close();
  }
}

describe("TestFileFieldIntercept", () => {
  let app: TestCollectionsApp;
  let demo1: Collection;
  let f1: File, f2: File, f3: File, f4: File;
  let record: Record;

  beforeAll(async () => {
    app = openTestApp();
    demo1 = demo1WithRequiredText(app);
    [f1, f2, f3, f4] = (await newFiles()) as [File, File, File, File];
    record = newRecord(demo1);
  });

  afterAll(() => {
    app.cleanup();
  });

  test("1. create - with validation error", async () => {
    record.set("file_many", [f1, f2]);

    expectValidationErrors(await errorOfAsync(saveRecord(app, record)), ["text"]);

    const value = record.getRaw("file_many") as unknown[];
    expect(value.length).toBe(2);
  });

  test("2. create - fixing the validation error", async () => {
    record.set("text", "abc");

    expect(await errorOfAsync(saveRecord(app, record))).toBeNull();

    const expectedKeys = [f1.name, f2.name];

    // ensure that the value was replaced with the file names
    const value = toUniqueStringSlice(record.getRaw("file_many"));
    expect(value.toSorted()).toEqual(expectedKeys.toSorted());

    checkRecordFiles(app, record, expectedKeys);
  });

  test("3. update - validation error", async () => {
    record.set("text", "");
    record.set("file_many+", f3);
    record.set("file_many-", f2.name);

    expectValidationErrors(await errorOfAsync(saveRecord(app, record)), ["text"]);

    expect(marshal(record.getRaw("file_many"))).toBe(marshal([f1.name, f3]));

    checkRecordFiles(app, record, [f1.name, f2.name]);
  });

  test("4. update - fixing the validation error", async () => {
    record.set("text", "abc2");

    expect(await errorOfAsync(saveRecord(app, record))).toBeNull();

    expect(marshal(record.getRaw("file_many"))).toBe(marshal([f1.name, f3.name]));

    checkRecordFiles(app, record, [f1.name, f3.name]);
  });

  test("5. update - second time update", async () => {
    record.set("file_many-", f1.name);
    record.set("file_many+", f4);

    expect(await errorOfAsync(saveRecord(app, record))).toBeNull();

    expect(marshal(record.getRaw("file_many"))).toBe(marshal([f3.name, f4.name]));

    checkRecordFiles(app, record, [f3.name, f4.name]);
  });
});

describe("TestFileFieldInterceptTx", () => {
  let app: TestCollectionsApp;
  let demo1: Collection;
  let f1: File, f2: File, f3: File, f4: File;
  let record: Record;

  beforeAll(async () => {
    app = openTestApp();
    demo1 = demo1WithRequiredText(app);
    [f1, f2, f3, f4] = (await newFiles()) as [File, File, File, File];
  });

  afterAll(() => {
    app.cleanup();
  });

  // the steps inside the transaction; the expectations throw, so a failed
  // step also fails the transaction
  const steps = (txApp: RecordsApp): void => {
    record = newRecord(demo1);

    // create with validation error
    record.set("text", "");
    record.set("file_many", [f1, f2]);
    expectValidationErrors(
      errorOf(() => saveRecordSync(txApp, record)),
      ["text"],
    );
    checkRecordFiles(txApp, record, []); // no uploaded files

    // create with fixed validation error
    record.set("text", "abc");
    expect(errorOf(() => saveRecordSync(txApp, record))).toBeNull();
    checkRecordFiles(txApp, record, [f1.name, f2.name]);

    // update with validation error
    record.set("text", "");
    record.set("file_many+", f3);
    record.set("file_many-", f2.name);
    expectValidationErrors(
      errorOf(() => saveRecordSync(txApp, record)),
      ["text"],
    );
    expect(marshal(record.getRaw("file_many"))).toBe(marshal([f1.name, f3]));
    checkRecordFiles(txApp, record, [f1.name, f2.name]); // no file changes

    // update with fixed validation error
    record.set("text", "abc2");
    expect(errorOf(() => saveRecordSync(txApp, record))).toBeNull();
    expect(marshal(record.getRaw("file_many"))).toBe(marshal([f1.name, f3.name]));
    checkRecordFiles(txApp, record, [f1.name, f3.name, f2.name]); // f2 shouldn't be deleted yet

    // second time update
    record.set("file_many-", f1.name);
    record.set("file_many+", f4);
    expect(errorOf(() => saveRecordSync(txApp, record))).toBeNull();
    expect(marshal(record.getRaw("file_many"))).toBe(marshal([f3.name, f4.name]));
    // f1 and f2 shouldn't be deleted yet
    checkRecordFiles(txApp, record, [f3.name, f4.name, f1.name, f2.name]);
  };

  test("[tx_false] failed transaction", () => {
    const txErr = errorOf(() =>
      runInAppTransaction(app, (txApp) => {
        steps(txApp);
        throw new Error("tx error");
      }),
    );
    expect(txErr?.message).toBe("tx error");

    // there shouldn't be any files associated with the record id
    checkRecordFiles(app, record, []);
  });

  test("[tx_true] successful transaction", () => {
    expect(errorOf(() => runInAppTransaction(app, steps))).toBeNull();

    // only the last updated files should remain
    checkRecordFiles(app, record, [f3.name, f4.name]);
  });
});

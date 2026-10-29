// `prepare` steps of the record write scenarios (upstream's BeforeTestFunc
// in apis/record_crud_test.go and record_crud_superuser_test.go): they
// change a scenario's fixture copy before any server starts on it, through
// the same model functions upstream's tests call on the test app.

import {
  findCachedCollectionByNameOrId,
  reloadCachedCollections,
} from "@/collections/collection-query";
import { HashExp, NotExp } from "@/db/dbx/expression";
import type { FileField } from "@/fields/file";
import type { JSONField } from "@/fields/json";
import { newRecord } from "@/records/record-model";
import { findAllRecords } from "@/records/record-query";
import { deleteRecordSync, saveRecordSync } from "@/records/record-save";

import { openDataDir } from "@test/collections/app";
import { updateCollection } from "@test/scenarios/prepare";

function withApp(dataDir: string, fn: (app: ReturnType<typeof openDataDir>) => void): void {
  const app = openDataDir(dataDir);
  try {
    reloadCachedCollections(app);
    fn(app);
  } finally {
    app.cleanup();
  }
}

// three dummy auth origins of a record (core.NewAuthOrigin + app.Save)
export function addAuthOrigins(dataDir: string, collection: string, recordId: string): void {
  withApp(dataDir, (app) => {
    const col = findCachedCollectionByNameOrId(app, collection);
    const origins = findCachedCollectionByNameOrId(app, "_authOrigins");
    for (let i = 0; i < 3; i++) {
      const d = newRecord(origins);
      d.set("collectionRef", col.id);
      d.set("recordRef", recordId);
      d.set("fingerprint", "abc_" + String(i));
      saveRecordSync(app, d);
    }
  });
}

// deletes every superuser except the given one
export function deleteOtherSuperusers(dataDir: string, keepId: string): void {
  withApp(dataDir, (app) => {
    const superusers = findAllRecords(app, "_superusers", new NotExp(new HashExp({ id: keepId })));
    for (const superuser of superusers) {
      deleteRecordSync(app, superuser);
    }
  });
}

// demo1 with small file and json limits (the dynamic body limit scenarios)
export function smallDemo1BodyLimit(dataDir: string): void {
  updateCollection(dataDir, "demo1", (collection) => {
    // adjust field sizes for the test
    const fileOneField = collection.fields.getByName("file_one") as FileField;
    fileOneField.maxSize = 5;

    const fileManyField = collection.fields.getByName("file_many") as FileField;
    fileManyField.maxSize = 10;
    fileManyField.maxSelect = 2;

    const jsonField = collection.fields.getByName("json") as JSONField;
    jsonField.maxSize = 2;
  });
}

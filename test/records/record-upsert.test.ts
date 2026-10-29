// Upstream: forms/record_upsert_test.go (TestRecordUpsertLoad,
// TestRecordUpsertSubmitValidations, TestRecordUpsertSubmitFailure,
// TestRecordUpsertSubmitSuccess, TestRecordUpsertPasswordsSync)
//
// Left out: TestRecordUpsertDrySubmitFailure, TestRecordUpsertDrySubmitCreateSuccess
// and TestRecordUpsertDrySubmitUpdateSuccess (DrySubmit is deprecated and not
// ported), and the OnRecordValidate call counters of TestRecordUpsertSubmitFailure
// and TestRecordUpsertSubmitSuccess (hook events).
//
// Each Go test function runs on its own copy of the vendored fixture. The
// PasswordsSync subtests share one copy, as the Go test shares its testApp.
// openTestApp does not expose the data dir that testFilesCount needs, so
// openUpsertApp opens the same kind of fixture copy with a known data dir.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { findCollectionByNameOrId, reloadCachedCollections } from "@/collections/collection-query";
import { type DataMap, type Record, newRecord } from "@/records/record-model";
import { findAuthRecordByEmail, findRecordById } from "@/records/record-query";
import { RecordUpsert } from "@/records/record-upsert";
import { NewFileFromBytes } from "@/tools/filesystem/file";
import { marshal } from "@/tools/types/go-json";

import { openDataDir, type TestCollectionsApp } from "@test/collections/app";
import { expectValidationErrors } from "@test/collections/validation";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

interface UpsertApp extends TestCollectionsApp {
  readonly dataDir: string;
}

// tests.NewTestApp: a fixture copy (with the collections cache loaded) whose
// data dir is known, for the storage checks
function openUpsertApp(): UpsertApp {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-upsert-"));
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const app = openDataDir(dataDir, undefined, () => rmSync(root, { recursive: true, force: true }));
  reloadCachedCollections(app);
  return Object.assign(app, { dataDir });
}

// runs fn on a fresh fixture copy, cleaned up afterwards
async function withApp<T>(fn: (app: UpsertApp) => T | Promise<T>): Promise<T> {
  const app = openUpsertApp();
  try {
    return await fn(app);
  } finally {
    app.cleanup();
  }
}

// the rejection of a promise, or null (Go's returned error)
async function errorOf(p: Promise<unknown>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// testFilesCount: the number of entries in the record's storage dir
function testFilesCount(app: UpsertApp, record: Record, count: number): void {
  const storageDir = join(app.dataDir, "storage", record.collection().id, record.id);

  let entries: string[] = [];
  try {
    entries = readdirSync(storageDir);
  } catch {
    // a missing storage dir has no entries (Go ignores the ReadDir error)
  }
  expect(entries).toHaveLength(count);
}

describe("TestRecordUpsertLoad", () => {
  const scenarios: {
    name: string;
    data: DataMap;
    record: (app: UpsertApp) => Record;
    managerAccessLevel?: boolean;
    superuserAccessLevel?: boolean;
    expected: string[];
    notExpected?: string[];
    file?: boolean;
  }[] = [
    {
      name: "base collection record",
      data: {
        text: "test_text",
        custom: "123", // should be ignored
        number: "456", // should be normalized by the setter
        "select_many+": ["optionB", "optionC"], // test modifier fields
        created: "2022-01:01 10:00:00.000Z", // should be ignored
        // ignore special auth fields
        oldPassword: "123",
        password: "456",
        passwordConfirm: "789",
      },
      record: (app) => newRecord(findCollectionByNameOrId(app, "demo1")),
      expected: [
        `"text":"test_text"`,
        `"number":456`,
        `"select_many":["optionB","optionC"]`,
        `"created":""`,
        `"updated":""`,
        `"json":null`,
      ],
      notExpected: [
        `"custom"`,
        `"password"`,
        `"oldPassword"`,
        `"passwordConfirm"`,
        `"select_many-"`,
        `"select_many+"`,
      ],
    },
    {
      name: "auth collection record",
      data: {
        email: "test@example.com",
        // special auth fields
        oldPassword: "123",
        password: "456",
        passwordConfirm: "789",
      },
      record: (app) => newRecord(findCollectionByNameOrId(app, "users")),
      expected: [`"email":"test@example.com"`, `"password":"456"`],
      notExpected: [`"oldPassword"`, `"passwordConfirm"`],
    },
    {
      name: "hidden fields (manager)",
      data: {
        email: "test@example.com",
        tokenKey: "abc", // should be ignored
        // special auth fields
        password: "456",
        oldPassword: "123",
        passwordConfirm: "789",
      },
      managerAccessLevel: true,
      record: (app) => newRecord(findCollectionByNameOrId(app, "users")),
      expected: [`"email":"test@example.com"`, `"tokenKey":""`, `"password":"456"`],
      notExpected: [`"oldPassword"`, `"passwordConfirm"`],
    },
    {
      name: "hidden fields (superuser)",
      data: {
        email: "test@example.com",
        tokenKey: "abc",
        // special auth fields
        password: "456",
        oldPassword: "123",
        passwordConfirm: "789",
      },
      superuserAccessLevel: true,
      record: (app) => newRecord(findCollectionByNameOrId(app, "users")),
      expected: [`"email":"test@example.com"`, `"tokenKey":"abc"`, `"password":"456"`],
      notExpected: [`"oldPassword"`, `"passwordConfirm"`],
    },
    {
      name: "with file field",
      data: {
        // file_one is set from the file built in the test; url is ignored for non-file fields
        file_one: "__file__",
        url: "__file__", // should be ignored for non-file fields
      },
      record: (app) => newRecord(findCollectionByNameOrId(app, "demo1")),
      expected: [`"file_one":{`, `"originalName":"test.txt"`, `"url":""`],
      file: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, async () => {
      await withApp(async (app) => {
        const data = { ...s.data };
        if (s.file) {
          const file = await NewFileFromBytes(new TextEncoder().encode("test"), "test.txt");
          data["file_one"] = file;
          data["url"] = file;
        }

        const record = s.record(app);
        const form = new RecordUpsert(app, record);

        if (s.managerAccessLevel) {
          form.grantManagerAccess();
        }

        if (s.superuserAccessLevel) {
          form.grantSuperuserAccess();
        }

        // ensure that the form access level was updated
        if (!form.hasManageAccess() && (s.superuserAccessLevel || s.managerAccessLevel)) {
          throw new Error("Expected the form to have manage access level (manager or superuser)");
        }

        form.load(data);

        // json.Marshal of the loaded fields (DateTime and File marshal as in Go)
        const raw = marshal({ ...record.fieldsData(), ...record.customData() });

        for (const str of s.expected) {
          expect(raw).toContain(str);
        }

        for (const str of s.notExpected ?? []) {
          expect(raw).not.toContain(str);
        }
      });
    });
  }
});

// the records of the Go scenarios, looked up in the scenario's app
const demo2 = (app: UpsertApp): Record => newRecord(findCollectionByNameOrId(app, "demo2"));
const demo2Existing = (app: UpsertApp): Record => findRecordById(app, "demo2", "llvuca81nly1qls");
const users = (app: UpsertApp): Record => newRecord(findCollectionByNameOrId(app, "users"));
const userExisting = (app: UpsertApp): Record => findRecordById(app, "users", "4q1xlclmfloku33");

describe("TestRecordUpsertSubmitValidations", () => {
  const scenarios: {
    name: string;
    record: (app: UpsertApp) => Record;
    data: DataMap;
    managerAccess?: boolean;
    expectedErrors: string[];
  }[] = [
    // base
    {
      name: "new base collection record with empty data",
      record: demo2,
      data: {},
      expectedErrors: ["title"],
    },
    {
      name: "new base collection record with invalid data",
      record: demo2,
      data: {
        title: "",
        // should be ignored
        custom: "abc",
        oldPassword: "123",
        password: "456",
        passwordConfirm: "789",
      },
      expectedErrors: ["title"],
    },
    {
      name: "new base collection record with valid data",
      record: demo2,
      data: {
        title: "abc",
        // should be ignored
        custom: "abc",
        oldPassword: "123",
        password: "456",
        passwordConfirm: "789",
      },
      expectedErrors: [],
    },
    {
      name: "existing base collection record with empty data",
      record: demo2Existing,
      data: {},
      expectedErrors: [],
    },
    {
      name: "existing base collection record with invalid data",
      record: demo2Existing,
      data: { title: "" },
      expectedErrors: ["title"],
    },
    {
      name: "existing base collection record with valid data",
      record: demo2Existing,
      data: { title: "abc" },
      expectedErrors: [],
    },

    // auth
    {
      name: "new auth collection record with empty data",
      record: users,
      data: {},
      expectedErrors: ["password", "passwordConfirm"],
    },
    {
      name: "new auth collection record with invalid record and invalid form data (without manager access)",
      record: users,
      data: {
        verified: true,
        emailVisibility: true,
        email: "test@example.com",
        password: "456",
        passwordConfirm: "789",
        username: "!invalid",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
        oldPassword: "123",
      },
      // fail the form validator
      expectedErrors: ["verified", "passwordConfirm"],
    },
    {
      name: "new auth collection record with invalid record and valid form data (without manager access)",
      record: users,
      data: {
        verified: false,
        emailVisibility: true,
        email: "test@example.com",
        password: "456",
        passwordConfirm: "456",
        username: "!invalid",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
        oldPassword: "123",
      },
      // fail the record fields validator
      expectedErrors: ["password", "username"],
    },
    {
      name: "new auth collection record with invalid record and invalid form data (with manager access)",
      record: users,
      managerAccess: true,
      data: {
        verified: true,
        emailVisibility: true,
        email: "test@example.com",
        password: "456",
        passwordConfirm: "789",
        username: "!invalid",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
        oldPassword: "123",
      },
      // fail the form validator
      expectedErrors: ["passwordConfirm"],
    },
    {
      name: "new auth collection record with invalid record and valid form data (with manager access)",
      record: users,
      managerAccess: true,
      data: {
        verified: true,
        emailVisibility: true,
        email: "test@example.com",
        password: "456",
        passwordConfirm: "456",
        username: "!invalid",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
        oldPassword: "123",
      },
      // fail the record fields validator
      expectedErrors: ["password", "username"],
    },
    {
      name: "new auth collection record with valid data",
      record: users,
      data: {
        emailVisibility: true,
        email: "test_new@example.com",
        password: "1234567890",
        passwordConfirm: "1234567890",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
        oldPassword: "123",
      },
      expectedErrors: [],
    },
    {
      name: "new auth collection record with valid data and duplicated email",
      record: users,
      data: {
        email: "test@example.com",
        password: "1234567890",
        passwordConfirm: "1234567890",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
        oldPassword: "123",
      },
      // fail the unique db validator
      expectedErrors: ["email"],
    },
    {
      name: "existing auth collection record with empty data",
      record: userExisting,
      data: {},
      expectedErrors: [],
    },
    {
      name: "existing auth collection record with invalid record data and invalid form data (without manager access)",
      record: userExisting,
      data: {
        verified: true,
        email: "test_new@example.com", // not allowed to change
        oldPassword: "123",
        password: "456",
        passwordConfirm: "789",
        username: "!invalid",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
      },
      // fail form validator
      expectedErrors: ["verified", "email", "oldPassword", "passwordConfirm"],
    },
    {
      name: "existing auth collection record with invalid record data and valid form data (without manager access)",
      record: userExisting,
      data: {
        oldPassword: "1234567890",
        password: "12345678901",
        passwordConfirm: "12345678901",
        username: "!invalid",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
      },
      // fail record fields validator
      expectedErrors: ["username"],
    },
    {
      name: "existing auth collection record with invalid record data and invalid form data (with manager access)",
      record: userExisting,
      managerAccess: true,
      data: {
        verified: true,
        email: "test_new@example.com",
        oldPassword: "123", // should be ignored
        password: "456",
        passwordConfirm: "789",
        username: "!invalid",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
      },
      // fail form validator
      expectedErrors: ["passwordConfirm"],
    },
    {
      name: "existing auth collection record with invalid record data and valid form data (with manager access)",
      record: userExisting,
      managerAccess: true,
      data: {
        verified: true,
        email: "test_new@example.com",
        oldPassword: "1234567890",
        password: "12345678901",
        passwordConfirm: "12345678901",
        username: "!invalid",
        // should be ignored (custom or hidden fields)
        tokenKey: "aa",
        custom: "abc",
      },
      // fail record fields validator
      expectedErrors: ["username"],
    },
    {
      name: "existing auth collection record with base valid data",
      record: userExisting,
      data: { name: "test" },
      expectedErrors: [],
    },
    {
      name: "existing auth collection record with valid password and invalid oldPassword data",
      record: userExisting,
      data: {
        name: "test",
        oldPassword: "invalid",
        password: "1234567890",
        passwordConfirm: "1234567890",
      },
      expectedErrors: ["oldPassword"],
    },
    {
      name: "existing auth collection record with valid password data",
      record: userExisting,
      data: {
        name: "test",
        oldPassword: "1234567890",
        password: "0987654321",
        passwordConfirm: "0987654321",
      },
      expectedErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, async () => {
      await withApp(async (app) => {
        // the Go scenario's record is taken from the scenario's own app
        const form = new RecordUpsert(app, s.record(app).original());
        if (s.managerAccess) {
          form.grantManagerAccess();
        }
        form.load(s.data);

        expectValidationErrors(await errorOf(form.submit()), s.expectedErrors);
      });
    });
  }
});

describe("TestRecordUpsertSubmitFailure", () => {
  test("TestRecordUpsertSubmitFailure", async () => {
    await withApp(async (app) => {
      const col = findCollectionByNameOrId(app, "demo1");
      const record = findRecordById(app, "demo1", "imy661ixudk5izi");

      const file = await NewFileFromBytes(new TextEncoder().encode("test"), "test.txt");

      const form = new RecordUpsert(app, record);
      form.load({
        text: "test_update",
        file_one: file,
        select_one: "invalid",
      });

      const err = await errorOf(form.submit());
      expect(err).not.toBeNull();

      // refresh the record to ensure that the changes weren't persisted
      const refreshed = findRecordById(app, col.name, record.id);

      expect(refreshed.getString("text")).not.toBe("test_update");
      expect(refreshed.getString("select_one")).toBe("");
      expect(refreshed.getString("file_one")).toBe("");

      testFilesCount(app, refreshed, 0);
    });
  });
});

describe("TestRecordUpsertSubmitSuccess", () => {
  test("TestRecordUpsertSubmitSuccess", async () => {
    await withApp(async (app) => {
      const col = findCollectionByNameOrId(app, "demo1");
      const record = findRecordById(app, "demo1", "imy661ixudk5izi");

      const file = await NewFileFromBytes(new TextEncoder().encode("test"), "test.txt");

      const form = new RecordUpsert(app, record);
      form.load({
        text: "test_update",
        file_one: file,
        select_one: "optionC",
      });

      const err = await errorOf(form.submit());
      expect(err).toBeNull();

      // refresh the record to ensure that the changes were persisted
      const refreshed = findRecordById(app, col.name, record.id);

      expect(refreshed.getString("text")).toBe("test_update");
      expect(refreshed.getString("select_one")).toBe("optionC");
      expect(refreshed.getString("file_one")).toBe(file.name);

      testFilesCount(app, refreshed, 2); // the file + attrs
    });
  });
});

describe("TestRecordUpsertPasswordsSync", () => {
  // the subtests share one app, as the Go test shares its testApp
  let app: UpsertApp;

  beforeAll(() => {
    app = openUpsertApp();
  });

  afterAll(() => {
    app.cleanup();
  });

  test("new user without password", async () => {
    const record = newRecord(findCollectionByNameOrId(app, "users"));

    const form = new RecordUpsert(app, record);

    expectValidationErrors(await errorOf(form.submit()), ["password", "passwordConfirm"]);
  });

  test("new user with manual password", async () => {
    const record = newRecord(findCollectionByNameOrId(app, "users"));

    const form = new RecordUpsert(app, record);

    record.setPassword("1234567890");

    expect(await errorOf(form.submit())).toBeNull();
  });

  test("new user with random password", async () => {
    const record = newRecord(findCollectionByNameOrId(app, "users"));

    const form = new RecordUpsert(app, record);

    record.setRandomPassword();

    expect(await errorOf(form.submit())).toBeNull();
  });

  test("update user with no password change", async () => {
    const record = findAuthRecordByEmail(
      app,
      findCollectionByNameOrId(app, "users"),
      "test@example.com",
    );

    const oldHash = record.getString("password:hash");

    const form = new RecordUpsert(app, record);

    expect(await errorOf(form.submit())).toBeNull();

    const newHash = record.getString("password:hash");
    expect(newHash).not.toBe("");
    expect(newHash).toBe(oldHash);
  });

  test("update user with manual password change", async () => {
    const record = findAuthRecordByEmail(
      app,
      findCollectionByNameOrId(app, "users"),
      "test@example.com",
    );

    const oldHash = record.getString("password:hash");

    const form = new RecordUpsert(app, record);

    record.setPassword("1234567890");

    expect(await errorOf(form.submit())).toBeNull();

    const newHash = record.getString("password:hash");
    expect(newHash).not.toBe("");
    expect(newHash).not.toBe(oldHash);
  });

  test("update user with random password change", async () => {
    const record = findAuthRecordByEmail(
      app,
      findCollectionByNameOrId(app, "users"),
      "test@example.com",
    );

    const oldHash = record.getString("password:hash");

    const form = new RecordUpsert(app, record);

    record.setRandomPassword();

    expect(await errorOf(form.submit())).toBeNull();

    const newHash = record.getString("password:hash");
    expect(newHash).not.toBe("");
    expect(newHash).not.toBe(oldHash);
  });
});

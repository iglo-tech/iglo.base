// Upstream: core/collection_model_test.go (TestNewCollection through
// TestCollectionIndexHelpers; TestCollectionDelete, ModelEventSync and the
// Save* tests are M1.7's)
//
// The tests that need upstream's test app read the vendored fixture
// (test/fixtures/pocketbase/) through src/db. FindCollectionByNameOrId and
// the collections cache come with M1.6a; until then a collection is read
// from its `_collections` row with the model's own dbx scan (dbScan and
// postScan), which is what upstream's lookup does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";
import {
  Collection,
  CollectionTypeAuth,
  CollectionTypeBase,
  CollectionTypeView,
  newAuthCollection,
  newBaseCollection,
  newCollection,
  newViewCollection,
} from "@/collections/collection-model";
import { HashExp } from "@/db/dbx/expression";
import { BoolField } from "@/fields/bool";
import { anyType, marshal, unmarshal } from "@/tools/types/go-json";
import { DateTime, parseDateTime } from "@/tools/types/datetime";
import { JSONRaw } from "@/tools/types/json-raw";

import {
  oauth2UpdateCases,
  oauth2UpdateCreateBody,
  oauth2UpdatePatchBody,
} from "@test/differential/collections/cases";
import { TestApp } from "@test/support/fields";

let app: TestApp;

beforeAll(() => {
  app = TestApp.open();
});

afterAll(() => {
  app.cleanup();
});

// app.FindCollectionByNameOrId(name), read through the model's dbx scan
function findCollection(name: string): Collection {
  const c = new Collection();
  app.concurrentDB().select("*").from("_collections").where(new HashExp({ name })).one(c);
  return c;
}

function expectParts(
  result: string,
  expected: readonly string[],
  notExpected: readonly string[] = [],
) {
  for (const part of expected) {
    expect({ part, found: result.includes(part) }).toEqual({ part, found: true });
  }
  for (const part of notExpected) {
    expect({ part, found: result.includes(part) }).toEqual({ part, found: false });
  }
}

const baseParts = (name: string): string[] => [
  `"id":"pbc_`,
  `"name":"${name}"`,
  `"type":"base"`,
  `"system":false`,
  `"indexes":[]`,
  `"fields":[{`,
  `"name":"id"`,
  `"type":"text"`,
  `"listRule":null`,
  `"viewRule":null`,
  `"createRule":null`,
  `"updateRule":null`,
  `"deleteRule":null`,
];

const viewParts = (name: string): string[] => [
  `"id":"pbc_`,
  `"name":"${name}"`,
  `"type":"view"`,
  `"indexes":[]`,
  `"fields":[]`,
  `"system":false`,
  `"listRule":null`,
  `"viewRule":null`,
  `"createRule":null`,
  `"updateRule":null`,
  `"deleteRule":null`,
];

const authParts = (name: string, id: string): string[] => [
  id,
  `"name":"${name}"`,
  `"type":"auth"`,
  `"fields":[{`,
  `"system":false`,
  `"type":"text"`,
  `"type":"email"`,
  `"name":"id"`,
  `"name":"email"`,
  `"name":"password"`,
  `"name":"tokenKey"`,
  `"name":"emailVisibility"`,
  `"name":"verified"`,
  `idx_email`,
  `idx_tokenKey`,
  `"listRule":null`,
  `"viewRule":null`,
  `"createRule":null`,
  `"updateRule":null`,
  `"deleteRule":null`,
  `"identityFields":["email"]`,
];

describe("NewCollection", () => {
  const scenarios: { typ: string; name: string; expected: string[] }[] = [
    { typ: "", name: "", expected: baseParts("") },
    { typ: "unknown", name: "test", expected: baseParts("test") },
    { typ: "base", name: "test", expected: baseParts("test") },
    { typ: "view", name: "test", expected: viewParts("test") },
    { typ: "auth", name: "test", expected: authParts("test", `"id":"pbc_`) },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.typ}_${s.name}`, () => {
      const result = newCollection(s.typ, s.name).string();

      expectParts(result, s.expected);
    });
  }
});

describe("NewBaseCollection", () => {
  const scenarios: { name: string; expected: string[] }[] = [
    { name: "", expected: baseParts("") },
    { name: "test", expected: baseParts("test") },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.name}`, () => {
      const result = newBaseCollection(s.name).string();

      expectParts(result, s.expected);
    });
  }
});

describe("NewViewCollection", () => {
  const scenarios: { name: string; expected: string[] }[] = [
    { name: "", expected: viewParts("") },
    { name: "test", expected: viewParts("test") },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.name}`, () => {
      const result = newViewCollection(s.name).string();

      expectParts(result, s.expected);
    });
  }
});

describe("NewAuthCollection", () => {
  // upstream expects `"id":""` for the empty name; it matches the OAuth2
  // mappedFields member, which every auth collection's JSON has
  const scenarios: { name: string; expected: string[] }[] = [
    { name: "", expected: authParts("", `"id":""`) },
    { name: "test", expected: authParts("test", `"id":"pbc_`) },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.name}`, () => {
      const result = newAuthCollection(s.name).string();

      expectParts(result, s.expected);
    });
  }
});

test("CollectionTableName", () => {
  const c = newBaseCollection("test");
  expect(c.tableName()).toBe("_collections");
});

test("CollectionBaseFilesPath", () => {
  const c = new Collection();

  expect(c.baseFilesPath()).toBe("");

  c.id = "test";

  expect(c.baseFilesPath()).toBe(c.id);
});

describe("CollectionIsBase", () => {
  const scenarios: [string, boolean][] = [
    ["unknown", false],
    [CollectionTypeBase, true],
    [CollectionTypeView, false],
    [CollectionTypeAuth, false],
  ];

  for (const [typ, expected] of scenarios) {
    test(typ, () => {
      const c = new Collection();
      c.type = typ;

      expect(c.isBase()).toBe(expected);
    });
  }
});

describe("CollectionIsView", () => {
  const scenarios: [string, boolean][] = [
    ["unknown", false],
    [CollectionTypeBase, false],
    [CollectionTypeView, true],
    [CollectionTypeAuth, false],
  ];

  for (const [typ, expected] of scenarios) {
    test(typ, () => {
      const c = new Collection();
      c.type = typ;

      expect(c.isView()).toBe(expected);
    });
  }
});

describe("CollectionIsAuth", () => {
  const scenarios: [string, boolean][] = [
    ["unknown", false],
    [CollectionTypeBase, false],
    [CollectionTypeView, false],
    [CollectionTypeAuth, true],
  ];

  for (const [typ, expected] of scenarios) {
    test(typ, () => {
      const c = new Collection();
      c.type = typ;

      expect(c.isAuth()).toBe(expected);
    });
  }
});

describe("CollectionPostScan", () => {
  const rawOptions = new JSONRaw(`{
		"viewQuery":"select 1",
		"authRule":"1=2"
	}`);

  // upstream checks the %#v dump for lastSavedPK:"test", ViewQuery and
  // whether AuthRule is a nil pointer
  const scenarios: {
    typ: string;
    rawOptions: JSONRaw;
    viewQuery: string;
    authRule: string | null;
  }[] = [
    { typ: CollectionTypeBase, rawOptions, viewQuery: "", authRule: null },
    { typ: CollectionTypeView, rawOptions, viewQuery: "select 1", authRule: null },
    { typ: CollectionTypeAuth, rawOptions, viewQuery: "", authRule: "1=2" },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.typ}`, () => {
      const c = new Collection();
      c.id = "test";
      c.type = s.typ;
      c.rawOptions = s.rawOptions;

      c.postScan();

      expect(c.isNew()).toBe(false);
      expect(c.lastSavedPK()).toBe("test");
      expect(c.viewQuery).toBe(s.viewQuery);
      expect(c.authRule).toBe(s.authRule);
    });
  }
});

describe("CollectionUnmarshalJSON", () => {
  const scenarios: {
    name: string;
    raw: string;
    collection: () => Collection;
    expected: string[];
    notExpected: string[];
  }[] = [
    {
      name: "base new empty",
      raw: `{"type":"base","name":"test","listRule":"1=2","authRule":"1=3","viewQuery":"abc"}`,
      collection: () => new Collection(),
      expected: [
        `"type":"base"`,
        `"id":"pbc_`,
        `"name":"test"`,
        `"listRule":"1=2"`,
        `"fields":[`,
        `"name":"id"`,
        `"indexes":[]`,
      ],
      notExpected: [`"authRule":"1=3"`, `"viewQuery":"abc"`],
    },
    {
      name: "view new empty",
      raw: `{"type":"view","name":"test","listRule":"1=2","authRule":"1=3","viewQuery":"abc"}`,
      collection: () => new Collection(),
      expected: [
        `"type":"view"`,
        `"id":"pbc_`,
        `"name":"test"`,
        `"listRule":"1=2"`,
        `"fields":[]`,
        `"viewQuery":"abc"`,
        `"indexes":[]`,
      ],
      notExpected: [`"authRule":"1=3"`],
    },
    {
      name: "auth new empty",
      raw: `{"type":"auth","name":"test","listRule":"1=2","authRule":"1=3","viewQuery":"abc"}`,
      collection: () => new Collection(),
      expected: [
        `"type":"auth"`,
        `"id":"pbc_`,
        `"name":"test"`,
        `"listRule":"1=2"`,
        `"authRule":"1=3"`,
        `"fields":[`,
        `"name":"id"`,
      ],
      notExpected: [`"indexes":[]`, `"viewQuery":"abc"`],
    },
    {
      name: "new but with set type (no default fields load)",
      raw: `{"type":"base","name":"test","listRule":"1=2","authRule":"1=3","viewQuery":"abc"}`,
      collection: () => {
        const c = new Collection();
        c.type = CollectionTypeBase;
        return c;
      },
      expected: [`"type":"base"`, `"id":""`, `"name":"test"`, `"listRule":"1=2"`, `"fields":[]`],
      notExpected: [`"authRule":"1=3"`, `"viewQuery":"abc"`],
    },
    {
      name: "existing (no default fields load)",
      raw: `{"type":"auth","name":"test","listRule":"1=2","authRule":"1=3","viewQuery":"abc"}`,
      collection: () => findCollection("demo1"),
      expected: [
        `"type":"auth"`,
        `"name":"test"`,
        `"listRule":"1=2"`,
        `"authRule":"1=3"`,
        `"fields":[`,
        `"name":"id"`,
      ],
      notExpected: [`"name":"tokenKey"`, `"viewQuery":"abc"`],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = s.collection();

      collection.unmarshalJSON(s.raw);

      const rawResultStr = marshal(collection);

      expectParts(rawResultStr, s.expected, s.notExpected);
    });
  }
});

function withOptions(typ: string): Collection {
  const c = newCollection(typ, "test");
  c.viewQuery = "1=1";
  c.oauth2.providers = [
    new OAuth2ProviderConfig({
      name: "test1",
      clientId: "test_client_id1",
      clientSecret: "test_client_secret1",
    }),
    new OAuth2ProviderConfig({
      name: "test2",
      clientId: "test_client_id2",
      clientSecret: "test_client_secret2",
    }),
  ];
  return c;
}

describe("CollectionSerialize", () => {
  const scenarios: {
    name: string;
    collection: () => Collection;
    expected: string[];
    notExpected: string[];
  }[] = [
    {
      name: "base",
      collection: () => withOptions(CollectionTypeBase),
      expected: [`"id":"pbc_`, `"name":"test"`, `"type":"base"`],
      notExpected: [
        "verificationTemplate",
        "manageRule",
        "authRule",
        "secret",
        "oauth2",
        "clientId",
        "clientSecret",
        "viewQuery",
      ],
    },
    {
      name: "view",
      collection: () => withOptions(CollectionTypeView),
      expected: [`"id":"pbc_`, `"name":"test"`, `"type":"view"`, `"viewQuery":"1=1"`],
      notExpected: [
        "verificationTemplate",
        "manageRule",
        "authRule",
        "secret",
        "oauth2",
        "clientId",
        "clientSecret",
      ],
    },
    {
      name: "auth",
      collection: () => withOptions(CollectionTypeAuth),
      expected: [
        `"id":"pbc_`,
        `"name":"test"`,
        `"type":"auth"`,
        `"oauth2":{`,
        `"providers":[{`,
        `"clientId":"test_client_id1"`,
        `"clientId":"test_client_id2"`,
      ],
      notExpected: ["viewQuery", "secret", "clientSecret"],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = s.collection();

      const rawStr = collection.marshalJSON();

      expect(rawStr).toBe(collection.string());

      expectParts(rawStr, s.expected, s.notExpected);
    });
  }
});

// Upstream reads "users" with FindCachedCollectionByNameOrId; the cache
// comes with M1.6a, so the collection is read from its row here. The check
// is the same: marshaling does not clear the secrets of the model.
test("CollectionSerializeNotModifyingCache", () => {
  const c = findCollection("users");

  marshal(c);

  const redactedFields = new Map<string, string>([
    ["AuthToken.Secret", c.authToken.secret],
    ["FileToken.Secret", c.fileToken.secret],
    ["PasswordResetToken.Secret", c.passwordResetToken.secret],
    ["EmailChangeToken.Secret", c.emailChangeToken.secret],
    ["VerificationToken.Secret", c.verificationToken.secret],
  ]);

  const providers = c.oauth2.providers ?? [];
  expect(providers.length).toBeGreaterThan(0);
  for (const p of providers) {
    redactedFields.set(p.name + ".ClientSecret", p.clientSecret);
  }

  for (const [k, v] of redactedFields) {
    expect({ k, empty: v === "" }).toEqual({ k, empty: false });
  }
});

describe("CollectionDBExport", () => {
  const date = parseDateTime("2024-07-01 01:02:03.456Z");

  const scenarios: { typ: string; expected: string }[] = [
    {
      typ: "unknown",
      expected: `{"createRule":"1=3","created":"2024-07-01 01:02:03.456Z","deleteRule":"1=5","fields":[{"help":"","hidden":false,"id":"f1_id","name":"f1","presentable":false,"required":false,"system":true,"type":"bool"},{"help":"","hidden":false,"id":"f2_id","name":"f2","presentable":false,"required":true,"system":false,"type":"bool"}],"id":"test_id","indexes":["CREATE INDEX idx1 on test_name(id)","CREATE INDEX idx2 on test_name(id)"],"listRule":"1=1","name":"test_name","options":"{}","system":true,"type":"unknown","updateRule":"1=4","updated":"2024-07-01 01:02:03.456Z","viewRule":"1=7"}`,
    },
    {
      typ: CollectionTypeBase,
      expected: `{"createRule":"1=3","created":"2024-07-01 01:02:03.456Z","deleteRule":"1=5","fields":[{"help":"","hidden":false,"id":"f1_id","name":"f1","presentable":false,"required":false,"system":true,"type":"bool"},{"help":"","hidden":false,"id":"f2_id","name":"f2","presentable":false,"required":true,"system":false,"type":"bool"}],"id":"test_id","indexes":["CREATE INDEX idx1 on test_name(id)","CREATE INDEX idx2 on test_name(id)"],"listRule":"1=1","name":"test_name","options":"{}","system":true,"type":"base","updateRule":"1=4","updated":"2024-07-01 01:02:03.456Z","viewRule":"1=7"}`,
    },
    {
      typ: CollectionTypeView,
      expected: `{"createRule":"1=3","created":"2024-07-01 01:02:03.456Z","deleteRule":"1=5","fields":[{"help":"","hidden":false,"id":"f1_id","name":"f1","presentable":false,"required":false,"system":true,"type":"bool"},{"help":"","hidden":false,"id":"f2_id","name":"f2","presentable":false,"required":true,"system":false,"type":"bool"}],"id":"test_id","indexes":["CREATE INDEX idx1 on test_name(id)","CREATE INDEX idx2 on test_name(id)"],"listRule":"1=1","name":"test_name","options":{"viewQuery":"select 1"},"system":true,"type":"view","updateRule":"1=4","updated":"2024-07-01 01:02:03.456Z","viewRule":"1=7"}`,
    },
    {
      typ: CollectionTypeAuth,
      expected: `{"createRule":"1=3","created":"2024-07-01 01:02:03.456Z","deleteRule":"1=5","fields":[{"help":"","hidden":false,"id":"f1_id","name":"f1","presentable":false,"required":false,"system":true,"type":"bool"},{"help":"","hidden":false,"id":"f2_id","name":"f2","presentable":false,"required":true,"system":false,"type":"bool"}],"id":"test_id","indexes":["CREATE INDEX idx1 on test_name(id)","CREATE INDEX idx2 on test_name(id)"],"listRule":"1=1","name":"test_name","options":{"authRule":null,"manageRule":"1=6","authAlert":{"enabled":false,"emailTemplate":{"subject":"","body":""}},"oauth2":{"providers":[],"mappedFields":{"id":"","name":"","username":"","avatarURL":""},"enabled":false},"passwordAuth":{"enabled":false,"identityFields":[]},"mfa":{"enabled":false,"duration":0,"rule":""},"otp":{"enabled":false,"duration":0,"length":0,"emailTemplate":{"subject":"","body":""}},"authToken":{"duration":0},"passwordResetToken":{"duration":0},"emailChangeToken":{"duration":0},"verificationToken":{"duration":0},"fileToken":{"duration":0},"verificationTemplate":{"subject":"","body":""},"resetPasswordTemplate":{"subject":"","body":""},"confirmEmailChangeTemplate":{"subject":"","body":""}},"system":true,"type":"auth","updateRule":"1=4","updated":"2024-07-01 01:02:03.456Z","viewRule":"1=7"}`,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.typ}`, () => {
      const c = new Collection();
      c.type = s.typ;
      c.id = "test_id";
      c.name = "test_name";
      c.system = true;
      c.listRule = "1=1";
      c.viewRule = "1=2";
      c.createRule = "1=3";
      c.updateRule = "1=4";
      c.deleteRule = "1=5";
      c.manageRule = "1=6";
      c.viewRule = "1=7";
      c.created = date;
      c.updated = date;
      c.indexes = ["CREATE INDEX idx1 on test_name(id)", "CREATE INDEX idx2 on test_name(id)"];
      c.viewQuery = "select 1";
      c.fields.add(new BoolField({ id: "f1_id", name: "f1", system: true }));
      c.fields.add(new BoolField({ id: "f2_id", name: "f2", required: true }));
      c.rawOptions = new JSONRaw(`{"viewQuery": "select 2"}`); // should be ignored

      const result = c.dbExport();

      expect(marshal(result)).toBe(s.expected);
    });
  }
});

function checkIndexes(indexes: readonly string[], expectedIndexes: readonly string[]): void {
  expect(indexes.length).toBe(expectedIndexes.length);

  for (const idx of expectedIndexes) {
    expect(indexes).toContain(idx);
  }
}

test("CollectionIndexHelpers", () => {
  const c = newBaseCollection("test");
  checkIndexes(c.indexes, []);

  c.addIndex("idx1", false, "colA,colB", "colA != 1");
  c.addIndex("idx2", true, "colA", "");
  c.addIndex("idx3", false, "colA", "");
  c.addIndex("idx3", false, "colB", ""); // should overwrite the previous one

  const idx1 = "CREATE INDEX `idx1` ON `test` (colA,colB) WHERE colA != 1";
  const idx2 = "CREATE UNIQUE INDEX `idx2` ON `test` (colA)";
  const idx3 = "CREATE INDEX `idx3` ON `test` (colB)";

  checkIndexes(c.indexes, [idx1, idx2, idx3]);

  c.removeIndex("iDx2"); // case-insensitive
  c.removeIndex("missing"); // noop

  checkIndexes(c.indexes, [idx1, idx3]);

  const expectedIndexes: Record<string, string> = {
    missing: "",
    idx1: idx1,
    // the name is case insensitive
    iDX3: idx3,
  };
  for (const [key, expectedIdx] of Object.entries(expectedIndexes)) {
    expect({ key, idx: c.getIndex(key) }).toEqual({ key, idx: expectedIdx });
  }
});

// -------------------------------------------------------------------
// Not upstream tests: the model on every `_collections` row of the
// vendored fixture (the reference test compares the bytes with upstream's)

describe("fixture _collections rows", () => {
  test("every row scans, marshals to JSON and exports its columns back", () => {
    const rows = app.concurrentDB().select("*").from("_collections").all<Record<string, unknown>>();
    expect(rows.length).toBeGreaterThan(10);

    for (const row of rows) {
      const c = new Collection();
      c.dbScan(row);
      c.postScan();

      expect(c.isNew()).toBe(false);
      const json = unmarshal(c.string(), anyType) as Record<string, unknown>;
      expect({ name: json.name, type: json.type, id: json.id }).toEqual({
        name: row.name,
        type: row.type,
        id: row.id,
      });

      const exported = c.dbExport();
      expect(exported.id).toBe(row.id);
      expect(exported.name).toBe(row.name);
      expect(exported.listRule).toBe(row.listRule);
      expect((exported.created as DateTime).value()).toBe(row.created as string);
      if (c.type === CollectionTypeBase) {
        expect(exported.options).toBe("{}");
      } else {
        // the options read back as the stored JSON; the fixture rows were
        // written by json v1, which escaped HTML and wrote nil maps and
        // slices as null (json v2, and so the model, writes {} and [])
        expect(unmarshal((exported.options as JSONRaw).bytes(), anyType)).toEqual(
          unmarshal(
            (row.options as string)
              .replaceAll(`"extra":null`, `"extra":{}`)
              .replaceAll(`"providers":null`, `"providers":[]`),
            anyType,
          ),
        );
      }
    }
  });
});

// Not upstream tests: the json v2 rules Collection.unmarshalJSON follows
// (go-json-struct.ts)
describe("CollectionUnmarshalJSON json v2 rules", () => {
  test("nested structs merge, null zeroes, unknown and differently cased names are ignored", () => {
    const c = newAuthCollection("test");
    c.unmarshalJSON(
      `{"mfa":{"rule":"x"},"authAlert":null,"Name":"other","unknown":{"a":[1e400]},"otp":{"length":9007199254740993}}`,
    );
    expect(marshal(c.mfa)).toBe(`{"enabled":false,"duration":600,"rule":"x"}`);
    expect(marshal(c.authAlert)).toBe(`{"enabled":false,"emailTemplate":{"subject":"","body":""}}`);
    expect(c.name).toBe("test");
    expect(c.otp.length).toBe(9007199254740993n);
    expect(c.otp.duration).toBe(180);
  });

  test("a member of the wrong Go type fails", () => {
    for (const raw of [
      `{"mfa":{"duration":1.5}}`,
      `{"otp":{"length":9223372036854775808}}`,
      `{"name":1}`,
      `{"listRule":true}`,
      `{"oauth2":{"providers":[{"pkce":"yes"}]}}`,
      `{"fields":{}}`,
      `{"indexes":[1]}`,
      `{"name":"a","name":"b"}`,
      `[]`,
    ]) {
      expect(() => newAuthCollection("test").unmarshalJSON(raw)).toThrow();
    }
  });

  test("submitted OAuth2 providers merge into the existing ones with the same name", () => {
    const c = newAuthCollection("test");
    c.unmarshalJSON(
      `{"oauth2":{"providers":[{"name":"google","clientId":"a","clientSecret":"s","extra":{"x":1}}]}}`,
    );
    c.unmarshalJSON(`{"oauth2":{"providers":[{"name":"google","extra":{"y":2}}]}}`);
    const providers = c.oauth2.providers ?? [];
    expect(providers.length).toBe(1);
    expect(marshal(providers[0])).toBe(
      `{"pkce":null,"name":"google","clientId":"a","clientSecret":"s","authURL":"","tokenURL":"","userInfoURL":"","displayName":"","extra":{"x":1,"y":2}}`,
    );
  });

  // upstream's *bool: a merged provider shares its original's PKCE value
  // (cases confirmed by test/differential/collections)
  test("merged OAuth2 providers share the original's PKCE value", () => {
    for (const c of oauth2UpdateCases) {
      const collection = newAuthCollection(c.name);
      collection.unmarshalJSON(oauth2UpdateCreateBody(c));
      collection.unmarshalJSON(oauth2UpdatePatchBody(c));
      expect({
        name: c.name,
        pkce: (collection.oauth2.providers ?? []).map((p) => p.pkce),
      }).toEqual({ name: c.name, pkce: c.pkce });
    }
  });

  test("the PKCE regression: a later provider without pkce follows the earlier write", () => {
    const c = newAuthCollection("test");
    c.unmarshalJSON(
      `{"oauth2":{"enabled":false,"providers":[{"name":"google","clientId":"client","clientSecret":"secret","pkce":true}]}}`,
    );
    c.unmarshalJSON(`{"oauth2":{"providers":[{"name":"google","pkce":false},{"name":"google"}]}}`);
    expect(marshal(c.oauth2.providers)).toBe(
      `[{"pkce":false,"name":"google","clientId":"client","clientSecret":"secret","authURL":"","tokenURL":"","userInfoURL":"","displayName":"","extra":{}},{"pkce":false,"name":"google","clientId":"client","clientSecret":"secret","authURL":"","tokenURL":"","userInfoURL":"","displayName":"","extra":{}}]`,
    );
  });

  test("the generated index names are cut at 64 bytes", () => {
    const c = newAuthCollection("x", "a".repeat(70));
    expect(c.indexes).toEqual([
      "CREATE UNIQUE INDEX `idx_tokenKey_" + "a".repeat(51) + "` ON `x` (`tokenKey`)",
      "CREATE UNIQUE INDEX `idx_email_" + "a".repeat(54) + "` ON `x` (`email`) WHERE `email` != ''",
    ]);
  });
});

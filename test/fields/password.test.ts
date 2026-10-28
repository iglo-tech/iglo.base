// Upstream: core/field_password_test.go, and golang.org/x/crypto v0.58.0
// bcrypt/bcrypt_test.go (the hash format and checks the field relies on)

import { describe, expect, test } from "bun:test";

import {
  InterceptorActionAfterCreate,
  InterceptorActionAfterUpdate,
  InterceptorActionCreate,
  type Field,
} from "@/fields/field";
import {
  DefaultCost,
  ErrHashTooShort,
  ErrMismatchedHashAndPassword,
  ErrPasswordTooLong,
  FieldTypePassword,
  HashVersionTooNewError,
  InvalidCostError,
  InvalidHashPrefixError,
  MaxCost,
  MinCost,
  PasswordField,
  PasswordFieldValue,
  compareHashAndPassword,
  Cost,
  generateFromPassword,
} from "@/fields/password";
import { marshal, textToBytes } from "@/tools/types/go-json";
import { NewError } from "@/validation/error";

import {
  TestRecord,
  expectValidationErrors,
  newBaseCollection,
  noDBApp,
} from "@test/support/fields";
import {
  testDefaultFieldHelpValidation,
  testDefaultFieldIdValidation,
  testDefaultFieldNameValidation,
  testFieldBaseMethods,
} from "@test/fields/shared";

const bytes = (s: string) => textToBytes(s);

describe("TestPasswordFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypePassword);
});

test("TestPasswordFieldColumnType", () => {
  expect(new PasswordField().columnType(noDBApp())).toBe("TEXT DEFAULT '' NOT NULL");
});

describe("TestPasswordFieldPrepareValue", () => {
  const f = new PasswordField();
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: { raw: unknown; expected: string }[] = [
    { raw: "", expected: "" },
    { raw: "test", expected: "test" },
    { raw: false, expected: "false" },
    { raw: true, expected: "true" },
    { raw: 123.456, expected: "123.456" },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${String(s.raw)}`, () => {
      const [v, err] = f.prepareValue(record, s.raw);
      expect(err).toBeNull();
      expect(v).toBeInstanceOf(PasswordFieldValue);
      expect((v as PasswordFieldValue).hash).toBe(s.expected);
    });
  }
});

describe("TestPasswordFieldDriverValue", () => {
  const f = new PasswordField({ name: "test" });

  const err = new Error("example_err");

  const scenarios: { raw: unknown; expected: PasswordFieldValue }[] = [
    { raw: 123, expected: new PasswordFieldValue() },
    { raw: "abc", expected: new PasswordFieldValue() },
    { raw: "$2abc", expected: new PasswordFieldValue({ hash: "$2abc" }) },
    {
      raw: new PasswordFieldValue({ hash: "test", lastError: err }),
      expected: new PasswordFieldValue({ hash: "test", lastError: err }),
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${String(s.raw)}`, () => {
      const record = new TestRecord(newBaseCollection("test"));
      record.setRaw(f.getName(), s.raw);

      const [v, vErr] = f.driverValue(record);

      expect(typeof v).toBe("string");
      expect(vErr?.message ?? "").toBe(s.expected.lastError?.message ?? "");
      expect(v).toBe(s.expected.hash);
    });
  }
});

describe("TestPasswordFieldValidateValue", () => {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: PasswordField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new PasswordField({ name: "test" }),
      record: withValue("123"),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      field: new PasswordField({ name: "test" }),
      record: withValue(new PasswordFieldValue()),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new PasswordField({ name: "test", required: true }),
      record: withValue(new PasswordFieldValue()),
      expectError: true,
    },
    {
      name: "empty hash but non-empty plain password (required)",
      field: new PasswordField({ name: "test", required: true }),
      record: withValue(new PasswordFieldValue({ plain: "test" })),
      expectError: true,
    },
    {
      name: "non-empty hash (required)",
      field: new PasswordField({ name: "test", required: true }),
      record: withValue(new PasswordFieldValue({ hash: "test" })),
      expectError: false,
    },
    {
      name: "with LastError",
      field: new PasswordField({ name: "test" }),
      record: withValue(new PasswordFieldValue({ lastError: new Error("test") })),
      expectError: true,
    },
    {
      name: "< Min",
      field: new PasswordField({ name: "test", min: 3 }),
      record: withValue(new PasswordFieldValue({ plain: "аб" })), // multi-byte chars test
      expectError: true,
    },
    {
      name: ">= Min",
      field: new PasswordField({ name: "test", min: 3 }),
      record: withValue(new PasswordFieldValue({ plain: "абв" })), // multi-byte chars test
      expectError: false,
    },
    {
      name: "> default Max",
      field: new PasswordField({ name: "test" }),
      record: withValue(new PasswordFieldValue({ plain: "a".repeat(72) })),
      expectError: true,
    },
    {
      name: "<= default Max",
      field: new PasswordField({ name: "test" }),
      record: withValue(new PasswordFieldValue({ plain: "a".repeat(71) })),
      expectError: false,
    },
    {
      name: "> Max",
      field: new PasswordField({ name: "test", max: 2 }),
      record: withValue(new PasswordFieldValue({ plain: "абв" })), // multi-byte chars test
      expectError: true,
    },
    {
      name: "<= Max",
      field: new PasswordField({ name: "test", max: 2 }),
      record: withValue(new PasswordFieldValue({ plain: "аб" })), // multi-byte chars test
      expectError: false,
    },
    {
      name: "non-matching pattern",
      field: new PasswordField({ name: "test", pattern: String.raw`\d+` }),
      record: withValue(new PasswordFieldValue({ plain: "abc" })),
      expectError: true,
    },
    {
      name: "matching pattern",
      field: new PasswordField({ name: "test", pattern: String.raw`\d+` }),
      record: withValue(new PasswordFieldValue({ plain: "123" })),
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const err = s.field.validateValue(app, s.record());
      expect({ hasErr: err !== null, err: String(err) }).toMatchObject({ hasErr: s.expectError });
    });
  }
});

// the exact errors of the cases above (codes, messages, params), from
// field_password.go
describe("PasswordField.validateValue errors", () => {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: { field: PasswordField; value: unknown; expected: Error }[] = [
    {
      field: new PasswordField({ name: "test" }),
      value: "123",
      expected: NewError("validation_unsupported_value_type", "Invalid or unsupported value type."),
    },
    {
      field: new PasswordField({ name: "test", required: true }),
      value: new PasswordFieldValue({ plain: "test" }),
      expected: NewError("validation_required", "Cannot be blank."),
    },
    {
      field: new PasswordField({ name: "test", min: 3 }),
      value: new PasswordFieldValue({ plain: "аб" }),
      expected: NewError("validation_min_text_constraint", "Must be at least 3 character(s)"),
    },
    {
      field: new PasswordField({ name: "test" }),
      value: new PasswordFieldValue({ plain: "a".repeat(72) }),
      expected: NewError("validation_max_text_constraint", "Must be less than 71 character(s)"),
    },
    {
      field: new PasswordField({ name: "test", max: 2 }),
      value: new PasswordFieldValue({ plain: "абв" }),
      expected: NewError("validation_max_text_constraint", "Must be less than 2 character(s)"),
    },
    {
      field: new PasswordField({ name: "test", pattern: String.raw`\d+` }),
      value: new PasswordFieldValue({ plain: "abc" }),
      expected: NewError("validation_invalid_format", "Invalid value format"),
    },
    {
      // an invalid pattern never matches (regexp.MatchString's error)
      field: new PasswordField({ name: "test", pattern: "(invalid" }),
      value: new PasswordFieldValue({ plain: "abc" }),
      expected: NewError("validation_invalid_format", "Invalid value format"),
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i} ${s.expected.message}`, () => {
      const record = new TestRecord(collection);
      record.setRaw("test", s.value);
      expect(marshal(s.field.validateValue(app, record))).toBe(marshal(s.expected));
    });
  }

  test("a set password over 72 bytes keeps bcrypt's error", () => {
    const field = new PasswordField({ name: "test", cost: MinCost });
    const record = new TestRecord(newBaseCollection("test_collection"));
    record.setRaw("test", new PasswordFieldValue());
    field.findSetter("test")?.(record, "ж".repeat(40)); // 40 runes, 80 bytes
    expect(field.validateValue(app, record)).toBe(ErrPasswordTooLong);
    expect(field.driverValue(record)).toEqual(["", ErrPasswordTooLong]);
  });
});

describe("TestPasswordFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypePassword);
  testDefaultFieldNameValidation(FieldTypePassword);
  testDefaultFieldHelpValidation(FieldTypePassword);

  const app = noDBApp();

  const scenarios: { name: string; field: () => PasswordField; expectErrors: string[] }[] = [
    {
      name: "zero minimal",
      field: () => new PasswordField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "invalid pattern",
      field: () => new PasswordField({ id: "test", name: "test", pattern: "(invalid" }),
      expectErrors: ["pattern"],
    },
    {
      name: "valid pattern",
      field: () => new PasswordField({ id: "test", name: "test", pattern: String.raw`\d+` }),
      expectErrors: [],
    },
    {
      name: "Min < 0",
      field: () => new PasswordField({ id: "test", name: "test", min: -1 }),
      expectErrors: ["min"],
    },
    {
      name: "Min > 71",
      field: () => new PasswordField({ id: "test", name: "test", min: 72 }),
      expectErrors: ["min"],
    },
    {
      name: "valid Min",
      field: () => new PasswordField({ id: "test", name: "test", min: 5 }),
      expectErrors: [],
    },
    {
      name: "Max < Min",
      field: () => new PasswordField({ id: "test", name: "test", min: 2, max: 1 }),
      expectErrors: ["max"],
    },
    {
      name: "Min > Min",
      field: () => new PasswordField({ id: "test", name: "test", min: 2, max: 3 }),
      expectErrors: [],
    },
    {
      name: "Max > 71",
      field: () => new PasswordField({ id: "test", name: "test", max: 72 }),
      expectErrors: ["max"],
    },
    {
      name: "cost < bcrypt.MinCost",
      field: () => new PasswordField({ id: "test", name: "test", cost: MinCost - 1 }),
      expectErrors: ["cost"],
    },
    {
      name: "cost > bcrypt.MaxCost",
      field: () => new PasswordField({ id: "test", name: "test", cost: MaxCost + 1 }),
      expectErrors: ["cost"],
    },
    {
      name: "valid cost",
      field: () => new PasswordField({ id: "test", name: "test", cost: 12 }),
      expectErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = newBaseCollection("test_collection");
      (collection.fields.getByName("id") as Field).setId("test"); // set a dummy known id so that it can be replaced

      const field = s.field();

      collection.fields.add(field);

      expectValidationErrors(field.validateSettings(app, collection), s.expectErrors);
    });
  }
});

describe("TestPasswordFieldFindSetter", () => {
  const scenarios: {
    name: string;
    key: string;
    value: unknown;
    field: PasswordField;
    hasSetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      value: "abc",
      field: new PasswordField({ name: "test" }),
      hasSetter: false,
      expected: "",
    },
    {
      name: "exact match",
      key: "test",
      value: "abc",
      field: new PasswordField({ name: "test" }),
      hasSetter: true,
      expected: `"abc"`,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = newBaseCollection("test_collection");
      collection.fields.add(s.field);

      const setter = s.field.findSetter(s.key);

      expect(setter !== null).toBe(s.hasSetter);
      if (setter === null) {
        return;
      }

      const record = new TestRecord(collection);
      record.setRaw(s.field.getName(), ["c", "d"]);

      setter(record, s.value);

      expect(marshal(record.get(s.field.getName()))).toBe(s.expected);
    });
  }
});

describe("TestPasswordFieldFindGetter", () => {
  const scenarios: {
    name: string;
    key: string;
    field: PasswordField;
    hasGetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      field: new PasswordField({ name: "test" }),
      hasGetter: false,
      expected: "",
    },
    {
      name: "field name match",
      key: "test",
      field: new PasswordField({ name: "test" }),
      hasGetter: true,
      expected: "test_plain",
    },
    {
      name: "field name hash modifier",
      key: "test:hash",
      field: new PasswordField({ name: "test" }),
      hasGetter: true,
      expected: "test_hash",
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = newBaseCollection("test_collection");
      collection.fields.add(s.field);

      const getter = s.field.findGetter(s.key);

      expect(getter !== null).toBe(s.hasGetter);
      if (getter === null) {
        return;
      }

      const record = new TestRecord(collection);
      record.setRaw(
        s.field.getName(),
        new PasswordFieldValue({ hash: "test_hash", plain: "test_plain" }),
      );

      expect(getter(record)).toBe(s.expected);
    });
  }
});

// not in upstream's tests: the setter's hash, the interceptor and
// PasswordFieldValue.Validate

describe("PasswordField setter", () => {
  test("hashes in Go's $2a$ form with the field's cost", () => {
    for (const [fieldCost, expected] of [
      [0, DefaultCost],
      [MinCost, MinCost],
      [5, 5],
    ] as const) {
      const field = new PasswordField({ name: "test", cost: fieldCost });
      const collection = newBaseCollection("test_collection");
      collection.fields.add(field);
      const record = new TestRecord(collection);
      record.set("test", "secret");
      const hash = record.getString("test:hash");
      expect(hash).toMatch(/^\$2a\$\d\d\$[./A-Za-z0-9]{53}$/);
      expect(Cost(bytes(hash))).toBe(expected);
      expect(record.getString("test")).toBe("secret");
      expect((record.getRaw("test") as PasswordFieldValue).validate("secret")).toBe(true);
    }
  });

  test("an empty value is not hashed", () => {
    const field = new PasswordField({ name: "test" });
    const record = new TestRecord(newBaseCollection("test_collection"));
    field.findSetter("test")?.(record, "");
    expect(record.getRaw("test")).toEqual(new PasswordFieldValue());
  });

  test("an out of range cost keeps bcrypt's error", () => {
    const field = new PasswordField({ name: "test", cost: MaxCost + 1 });
    const record = new TestRecord(newBaseCollection("test_collection"));
    field.findSetter("test")?.(record, "secret");
    const fv = record.getRaw("test") as PasswordFieldValue;
    expect(fv.hash).toBe("");
    expect(fv.lastError?.message).toBe(
      "crypto/bcrypt: cost 32 is outside allowed inclusive range 4..31",
    );
  });
});

describe("PasswordField.intercept", () => {
  for (const action of [InterceptorActionAfterCreate, InterceptorActionAfterUpdate]) {
    test(`${action} unsets the plain value`, async () => {
      const field = new PasswordField({ name: "test" });
      const record = new TestRecord(newBaseCollection("test_collection"));
      const fv = new PasswordFieldValue({ hash: "h", plain: "p" });
      record.setRaw("test", fv);
      let called = 0;
      await field.intercept(noDBApp(), record, action, async () => {
        called++;
      });
      expect(called).toBe(1);
      expect(fv).toEqual(new PasswordFieldValue({ hash: "h" }));
    });
  }

  test("other actions keep it and the action's error", async () => {
    const field = new PasswordField({ name: "test" });
    const record = new TestRecord(newBaseCollection("test_collection"));
    const fv = new PasswordFieldValue({ hash: "h", plain: "p" });
    record.setRaw("test", fv);
    const err = new Error("action");
    expect(
      field.intercept(noDBApp(), record, InterceptorActionCreate, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(fv.plain).toBe("p");
  });
});

describe("PasswordFieldValue.validate", () => {
  const hash = "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga"; // "allmine"

  test("matching and not", () => {
    expect(new PasswordFieldValue({ hash }).validate("allmine")).toBe(true);
    expect(new PasswordFieldValue({ hash }).validate("allmine2")).toBe(false);
    expect(new PasswordFieldValue({ hash }).validate("")).toBe(false);
  });

  test("no hash or a LastError", () => {
    expect(new PasswordFieldValue().validate("")).toBe(false);
    expect(new PasswordFieldValue({ hash, lastError: new Error("x") }).validate("allmine")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------
// golang.org/x/crypto/bcrypt/bcrypt_test.go

describe("bcrypt", () => {
  test("TestBcryptingIsEasy", () => {
    const pass = bytes("mypassword");
    const hp = generateFromPassword(pass, MinCost); // upstream: 0 (DefaultCost)

    expect(compareHashAndPassword(bytes(hp), pass)).toBeNull();

    expect(compareHashAndPassword(bytes(hp), bytes("notthepass"))).toBe(
      ErrMismatchedHashAndPassword,
    );
  });

  test("TestBcryptingIsCorrect", () => {
    const expectedHash = "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga";
    expect(compareHashAndPassword(bytes(expectedHash), bytes("allmine"))).toBeNull();
    expect(Cost(bytes(expectedHash))).toBe(10);
  });

  test("TestTooLongPasswordsWork", () => {
    // One byte over the usual 56 byte limit that blowfish has
    const tooLongPass = bytes("012345678901234567890123456789012345678901234567890123456");
    const tooLongExpected = "$2a$10$XajjQvNhvvRt5GSeFk1xFe5l47dONXg781AmZtd869sO8zfsHuw7C";
    expect(compareHashAndPassword(bytes(tooLongExpected), tooLongPass)).toBeNull();
  });

  test("TestInvalidHashErrors", () => {
    const invalidTests: [Error, string][] = [
      [ErrHashTooShort, "$2a$10$fooo"],
      [ErrHashTooShort, "$2a"],
      [
        new HashVersionTooNewError(0x33),
        "$3a$10$sssssssssssssssssssssshhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
      ],
      [
        new InvalidHashPrefixError(0x25),
        "%2a$10$sssssssssssssssssssssshhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
      ],
      [new InvalidCostError(32), "$2a$32$sssssssssssssssssssssshhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"],
    ];
    for (const [expected, hash] of invalidTests) {
      expect(() => Cost(bytes(hash))).toThrow(expected);
      const err = compareHashAndPassword(bytes(hash), bytes("anything"));
      expect(err).toEqual(expected);
      expect(err?.message).toBe(expected.message);
    }
    expect(new HashVersionTooNewError(0x33).message).toBe(
      "crypto/bcrypt: bcrypt algorithm version '3' requested is newer than current version '2'",
    );
    expect(new InvalidHashPrefixError(0x25).message).toBe(
      "crypto/bcrypt: bcrypt hashes must start with '$', but hashedSecret started with '%'",
    );
  });

  test("TestCost", () => {
    const suffix = "XajjQvNhvvRt5GSeFk1xFe5l47dONXg781AmZtd869sO8zfsHuw7C";
    for (const vers of ["2a", "2"]) {
      for (const c of [4, 10]) {
        expect(Cost(bytes(`$${vers}$${String(c).padStart(2, "0")}$${suffix}`))).toBe(c);
      }
    }
    expect(() => Cost(bytes("$a$a$" + suffix))).toThrow(ErrHashTooShort);
  });

  test("TestCostValidationInHash", () => {
    const pass = bytes("mypassword");

    for (let c = 0; c < MinCost; c++) {
      expect(Cost(bytes(generateFromPassword(pass, c)))).toBe(DefaultCost);
    }

    expect(() => generateFromPassword(pass, 32)).toThrow(new InvalidCostError(32));
  });

  test("TestCostReturnsWithLeadingZeroes", () => {
    const hp = generateFromPassword(bytes("abcdefgh"), 7);
    expect(hp.slice(4, 7)).toBe("07$");
  });

  test("TestMinorNotRequired", () => {
    const noMinorHash = "$2$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga";
    expect(Cost(bytes(noMinorHash))).toBe(10);
    expect(compareHashAndPassword(bytes(noMinorHash), bytes("allmine"))).toBeNull();
  });

  test("TestPasswordTooLong", () => {
    expect(() => generateFromPassword(new Uint8Array(73), 1)).toThrow(ErrPasswordTooLong);
  });
});

// Go's CompareHashAndPassword on hashes Go does not write: the version
// and the cost are parsed loosely, bytes after the 31 hash characters are
// ignored, and the password is cut at 72 bytes.
describe("bcrypt: Go's parsing", () => {
  const salt = "XajjQvNhvvRt5GSeFk1xFe";
  const hash = "yqRrsxkhBkUiQeg0dt.wU1qD4aFDcga"; // "allmine" at cost 10

  const scenarios: [string, string, Error | null][] = [
    ["$2a$10$" + salt + hash, "allmine", null],
    ["$2b$10$" + salt + hash, "allmine", null],
    ["$2y$10$" + salt + hash, "allmine", null],
    ["$2x$10$" + salt + hash, "allmine", null],
    ["$1a$10$" + salt + hash, "allmine", null],
    // "+9" is cost 9 (strconv.Atoi), parsed and computed
    ["$2a$+9$" + salt + hash, "allmine", ErrMismatchedHashAndPassword],
    ["$2a!10!" + salt + hash, "allmine", null],
    ["$2a$10$" + salt + hash + "trailing", "allmine", null],
    ["$2a$10$" + salt + hash.slice(0, 30) + "b", "allmine", ErrMismatchedHashAndPassword],
    ["$2a$10$" + salt.slice(0, 21) + "f" + hash, "allmine", null], // the same salt bytes
    ["$2a$10$" + salt.slice(0, 21) + "=" + hash, "allmine", new Error("")],
    // 59 bytes: parsed, the hash is zero padded
    ["$2a$10$" + salt + hash.slice(0, 30), "allmine", ErrMismatchedHashAndPassword],
    ["$2$10$" + salt + hash.slice(0, 30), "allmine", ErrHashTooShort],
    ["$2a$10$" + salt + hash, "allmine2", ErrMismatchedHashAndPassword],
    ["$2a$1x$" + salt + hash, "allmine", new Error(`strconv.Atoi: parsing "1x": invalid syntax`)],
    ["$2a$-4$" + salt + hash, "allmine", new InvalidCostError(-4)],
  ];

  for (const [i, [h, pass, expected]] of scenarios.entries()) {
    test(`${i} ${h}`, () => {
      const err = compareHashAndPassword(bytes(h), bytes(pass));
      if (expected === null) {
        expect(err).toBeNull();
      } else if (expected.message === "") {
        expect(err).not.toBeNull();
      } else {
        expect(err?.message).toBe(expected.message);
      }
    });
  }

  test("passwords are cut at 72 bytes, the empty one is a NUL byte", () => {
    // crypt_blowfish's test vectors (Openwall)
    const p72 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const h72 = "$2a$05$abcdefghijklmnopqrstuu5s2v8.iXieOjg/.AySBTTZIIVFJeBui";
    expect(compareHashAndPassword(bytes(h72), bytes(p72))).toBeNull();
    expect(
      compareHashAndPassword(bytes(h72), bytes(p72 + "chars after 72 are ignored")),
    ).toBeNull();

    const hEmpty = "$2a$05$CCCCCCCCCCCCCCCCCCCCC.7uG0VCzI2bS7j6ymqJi9CdcdxiRTWNy";
    expect(compareHashAndPassword(bytes(hEmpty), new Uint8Array(0))).toBeNull();
    expect(compareHashAndPassword(bytes(hEmpty), Uint8Array.of(0))).toBeNull();
    expect(compareHashAndPassword(bytes(hEmpty), bytes("x"))).toBe(ErrMismatchedHashAndPassword);

    const h8bit = "$2a$05$/OK.fbVrR/bpIqNJ5ianF.Sa7shbm4.OzKpvFnX1pQLmQW96oUlCq";
    expect(compareHashAndPassword(bytes(h8bit), Uint8Array.of(0xa3))).toBeNull();
  });
});

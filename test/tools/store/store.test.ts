// Upstream: tools/store/store_test.go

import { describe, expect, test } from "bun:test";

import { ShrinkThreshold, Store } from "@/tools/store/store";
import { stringType } from "@/tools/types/go-json";

describe("New", () => {
  test("shallow copy of the data and later changes", () => {
    const data = new Map(Object.entries({ test1: 1, test2: 2 }));
    const originalEntries = [...data];

    const s = new Store(data);
    s.set("test3", 3); // add 1 item
    s.remove("test1"); // remove 1 item

    // check if data was shallow copied
    expect([...data]).toEqual(originalEntries);

    expect(s.has("test1")).toBe(false);
    expect(s.get("test2")).toBe(2);
    expect(s.get("test3")).toBe(3);
  });
});

describe("Reset", () => {
  test("shallow copy of the data and later changes", () => {
    const s = new Store(new Map(Object.entries({ test1: 1 })));

    const data = new Map(Object.entries({ test2: 2 }));
    const originalEntries = [...data];

    s.reset(data);
    s.set("test3", 3);

    // check if data was shallow copied
    expect([...data]).toEqual(originalEntries);

    expect(s.has("test1")).toBe(false);
    expect(s.get("test2")).toBe(2);
    expect(s.get("test3")).toBe(3);
  });
});

describe("Length", () => {
  test("counts the entries", () => {
    const s = new Store(new Map(Object.entries({ test1: 1 })));
    s.set("test2", 2);

    expect(s.length()).toBe(2);
  });
});

describe("RemoveAll", () => {
  test("removes every key", () => {
    const s = new Store(new Map(Object.entries({ test1: true, test2: true })));

    const keys = ["test1", "test2"];

    s.removeAll();

    for (const key of keys) {
      expect(s.has(key)).toBe(false);
    }
  });
});

describe("Remove", () => {
  const s = new Store(new Map(Object.entries({ test: true })));

  const scenarios: string[] = ["test", "missing"];

  for (const [i, key] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(key)}`, () => {
      s.remove(key);
      expect(s.has(key)).toBe(false);
    });
  }
});

describe("Has", () => {
  const s = new Store(new Map(Object.entries({ test1: 0, test2: 1 })));

  const scenarios: [string, boolean][] = [
    ["test1", true],
    ["test2", true],
    ["missing", false],
  ];

  for (const [i, [key, exist]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(key)}`, () => {
      expect(s.has(key)).toBe(exist);
    });
  }
});

describe("Get", () => {
  const s = new Store(new Map(Object.entries({ test1: 0, test2: 1 })));

  const scenarios: [string, number | undefined][] = [
    ["test1", 0],
    ["test2", 1],
    // Go returns the zero value (0) for a missing key; here it is undefined
    ["missing", undefined],
  ];

  for (const [i, [key, expectValue]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(key)}`, () => {
      expect(s.get(key)).toBe(expectValue);
    });
  }
});

describe("GetOk", () => {
  const s = new Store(new Map(Object.entries({ test1: 0, test2: 1 })));

  const scenarios: [string, number | undefined, boolean][] = [
    ["test1", 0, true],
    ["test2", 1, true],
    // Go returns the zero value (0) for a missing key; here it is undefined
    ["missing", undefined, false],
  ];

  for (const [i, [key, expectValue, expectOk]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(key)}`, () => {
      const [value, ok] = s.getOk(key);

      expect(ok).toBe(expectOk);
      expect(value).toBe(expectValue);
    });
  }
});

describe("GetAll", () => {
  test("returns a shallow copy", () => {
    const data = new Map(Object.entries({ a: 1, b: 2 }));

    const s = new Store(data);

    // fetch and delete each key to make sure that it was shallow copied
    const result = s.getAll();
    for (const k of result.keys()) {
      result.delete(k);
    }

    // refetch again
    const refetched = s.getAll();

    expect(refetched.size).toBe(data.size);

    for (const [k, v] of data) {
      expect(refetched.get(k)).toBe(v);
    }
  });
});

describe("Keys", () => {
  test("returns all the keys", () => {
    const data = new Map(Object.entries({ a: 1, b: 2 }));

    const keys = new Store(data).keys();

    const expected = ["a", "b"];

    expect(keys).toHaveLength(expected.length);

    for (const k of expected) {
      expect(keys).toContain(k);
    }
  });
});

describe("Values", () => {
  test("returns all the values", () => {
    const data = new Map(Object.entries({ a: 1, b: 2 }));

    const values = new Store(data).values();

    const expected = [1, 2];

    expect(values).toHaveLength(expected.length);

    for (const v of expected) {
      expect(values).toContain(v);
    }
  });
});

describe("Set", () => {
  test("sets every value", () => {
    const s = new Store<string, number>();

    const data = new Map(Object.entries({ test1: 0, test2: 1, test3: 3 }));

    // set values
    for (const [k, v] of data) {
      s.set(k, v);
    }

    // verify that the values are set
    for (const [k, v] of data) {
      expect(s.has(k)).toBe(true);
      expect(s.get(k)).toBe(v);
    }
  });
});

describe("SetFunc", () => {
  test("receives the old value and stores the result", () => {
    const s = new Store<string, number>();

    // non existing value
    s.setFunc("test", (old) => {
      expect(old).toBeUndefined();
      return (old ?? 0) + 2;
    });
    expect(s.get("test")).toBe(2);

    // increment existing value
    s.setFunc("test", (old) => {
      expect(old).toBe(2);
      return (old ?? 0) + 1;
    });
    expect(s.get("test")).toBe(3);
  });
});

describe("GetOrSet", () => {
  const s = new Store(
    new Map(
      Object.entries({
        test1: 0,
        test2: 1,
        test3: 3,
      }),
    ),
  );

  const scenarios: [string, number, number][] = [
    ["test2", 20, 1],
    ["test3", 2, 3],
    ["test_new", 20, 20],
    ["test_new", 50, 20], // should return the previously inserted value
  ];

  for (const [i, [key, value, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(key)}`, () => {
      const result = s.getOrSet(key, () => value);

      expect(result).toBe(expected);
    });
  }
});

describe("SetIfLessThanLimit", () => {
  const s = new Store<string, number>();

  const limit = 2;

  const scenarios: [string, number, boolean][] = [
    ["test1", 1, true],
    ["test2", 2, true],
    ["test3", 3, false],
    ["test2", 4, true], // overwrite
  ];

  for (const [i, [key, value, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(key)}`, () => {
      const result = s.setIfLessThanLimit(key, value, limit);

      expect(result).toBe(expected);

      if (!expected) {
        expect(s.has(key)).toBe(false);
      } else {
        expect(s.get(key)).toBe(value);
      }
    });
  }
});

describe("UnmarshalJSON", () => {
  test("overwrites matching keys and keeps the others", () => {
    const s = new Store<string, string>();
    s.set("b", "old"); // should be overwritten
    s.set("c", "test3"); // ensures that the old values are not removed

    const raw = `{"a":"test1", "b":"test2"}`;
    s.unmarshalJSON(raw, stringType);

    expect(s.get("a")).toBe("test1");
    expect(s.get("b")).toBe("test2");
    expect(s.get("c")).toBe("test3");
  });
});

describe("MarshalJSON", () => {
  test("exports the data as a JSON object", () => {
    const s = new Store<string, string>();
    s.set("a", "test1");
    s.set("b", "test2");

    const expected = `{"a":"test1", "b":"test2"}`;

    const result = s.marshalJSON();

    expect(result).not.toBe(expected);
    expect(result).toBe(`{"a":"test1","b":"test2"}`);
  });
});

describe("Shrink", () => {
  test("keeps the remaining entries after the map is copied", () => {
    const s = new Store<string, number>();

    const total = 1000;

    for (let i = 0; i < total; i++) {
      s.set(String(i), i);
    }

    expect(s.length()).toBe(total);

    // trigger map "shrink"
    for (let i = 0; i < ShrinkThreshold; i++) {
      s.remove(String(i));
    }

    // ensure that after the deletion, the new map was copied properly
    expect(s.length()).toBe(total - ShrinkThreshold);

    for (const k of s.getAll().keys()) {
      const kInt = Number(k);
      expect(Number.isInteger(kInt)).toBe(true);
      // Key should have been deleted
      expect(kInt).toBeGreaterThanOrEqual(ShrinkThreshold);
    }
  });
});

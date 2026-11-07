// Replaces vitest's chai `assert` (bun:test has none) with the subset the upstream tests use.
// js-sdk v0.28.1 tests use only these methods; their semantics follow chai's.
import nodeAssert from "node:assert";

export const assert = {
  equal(actual: unknown, expected: unknown, msg?: string): void {
    // chai's assert.equal is non-strict (==)
    // oxlint-disable-next-line eqeqeq
    nodeAssert(
      actual == expected,
      msg ?? `expected ${String(actual)} to equal ${String(expected)}`,
    );
  },
  notEqual(actual: unknown, expected: unknown, msg?: string): void {
    // oxlint-disable-next-line eqeqeq
    nodeAssert(
      actual != expected,
      msg ?? `expected ${String(actual)} to not equal ${String(expected)}`,
    );
  },
  deepEqual(actual: unknown, expected: unknown, msg?: string): void {
    nodeAssert.deepStrictEqual(actual, expected, msg as string);
  },
  isTrue(value: unknown, msg?: string): void {
    nodeAssert.strictEqual(value, true, msg as string);
  },
  isFalse(value: unknown, msg?: string): void {
    nodeAssert.strictEqual(value, false, msg as string);
  },
  isNull(value: unknown, msg?: string): void {
    nodeAssert.strictEqual(value, null, msg as string);
  },
  isNotNull(value: unknown, msg?: string): void {
    nodeAssert.notStrictEqual(value, null, msg as string);
  },
  instanceOf(value: unknown, ctor: abstract new (...args: never[]) => unknown, msg?: string): void {
    nodeAssert(value instanceof ctor, msg ?? `expected value to be an instance of ${ctor.name}`);
  },
  isEmpty(value: unknown, msg?: string): void {
    nodeAssert(sizeOf(value) === 0, msg ?? "expected value to be empty");
  },
  isNotEmpty(value: unknown, msg?: string): void {
    nodeAssert(sizeOf(value) !== 0, msg ?? "expected value not to be empty");
  },
  include(haystack: string | readonly unknown[], needle: unknown, msg?: string): void {
    const ok =
      typeof haystack === "string" ? haystack.includes(String(needle)) : haystack.includes(needle);
    nodeAssert(ok, msg ?? `expected ${String(haystack)} to include ${String(needle)}`);
  },
};

function sizeOf(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  if (value !== null && typeof value === "object") return Object.keys(value).length;
  throw new TypeError("expected a string, array, Map, Set or object");
}

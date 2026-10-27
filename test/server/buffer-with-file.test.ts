// Upstream: tools/router/buffer_with_file_test.go

import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { BufferWithFile, DefaultMaxMemory } from "@/server/buffer-with-file";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("NewBufferWithFile", () => {
  const scenarios: [string, number, number][] = [
    ["negative limit", -1, DefaultMaxMemory],
    ["zero limit", 0, DefaultMaxMemory],
    ["> 0", 1, 1],
  ];

  for (const [name, limit, expected] of scenarios) {
    test(name, () => {
      const b = new BufferWithFile(limit);

      expect(b.fileName()).toBeUndefined();
      expect(b.isClosed()).toBe(false);
      expect(b.memoryLimit).toBe(expected);
    });
  }
});

// The steps share one buffer and run in order, like the upstream subtests.
describe("BufferWithFile write, read and close", () => {
  const b = new BufferWithFile(4);

  test("write under limit", () => {
    expect(b.write(encode("ab"))).toBe(2);

    expect(b.memoryLength()).toBe(2);
    expect(b.fileName()).toBeUndefined();
  });

  test("write under limit (again)", () => {
    expect(b.write(encode("c"))).toBe(1);

    expect(b.memoryLength()).toBe(3);
    expect(b.fileName()).toBeUndefined();
  });

  test("write beyond limit (aka. skip memory buf and write into file)", () => {
    expect(b.write(encode("de"))).toBe(2);

    expect(b.memoryLength()).toBe(3);
    expect(b.fileName()).toBeDefined();
  });

  test("read 0 bytes from non-empty buffer", () => {
    const temp = new Uint8Array(0);

    expect(b.read(temp)).toEqual({ n: 0, eof: false });
  });

  test("read under limit", () => {
    const temp = new Uint8Array(2);

    const { n, eof } = b.read(temp);
    expect(eof).toBe(false);
    expect(n).toBe(temp.length);
    expect(decode(temp)).toBe("ab");
  });

  test("read beyond limit", () => {
    const temp = new Uint8Array(3);

    const { n, eof } = b.read(temp);
    expect(eof).toBe(false);
    expect(n).toBe(temp.length);
    expect(decode(temp)).toBe("cde");
  });

  test("read from empty buffers", () => {
    const temp = new Uint8Array(3);

    expect(b.read(temp)).toEqual({ n: 0, eof: true });
  });

  test("close cleanup", () => {
    const filename = b.fileName();
    expect(filename).toBeDefined();
    expect(existsSync(filename as string)).toBe(true);

    b.close();

    expect(existsSync(filename as string)).toBe(false);
    expect(b.isClosed()).toBe(true);
    expect(b.fileName()).toBeUndefined();
  });
});

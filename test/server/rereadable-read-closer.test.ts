// Upstream: tools/router/rereadable_read_closer_test.go

import { existsSync } from "node:fs";
import { expect, test } from "bun:test";

import { BufferWithFile } from "@/server/buffer-with-file";
import { bytesReader, readAll, RereadableReadCloser } from "@/server/rereadable-read-closer";

test("RereadableReadCloser", async () => {
  const content = "test";

  const rereadable = new RereadableReadCloser(bytesReader(content), 2); // should store the rest 2 bytes in temp file

  const totalRereads = 5;

  const tempFilenames: string[] = [];

  // reread multiple times
  for (let i = 0; i < totalRereads; i++) {
    // test also with manual reread calls to ensure that the copy is reset
    // and written to only when there are n>0 bytes
    if (i > 3) {
      rereadable.reread();
    }

    const result = await readAll(rereadable);
    expect(new TextDecoder().decode(result)).toBe(content);

    const current = rereadable.current();
    expect(current).toBeInstanceOf(BufferWithFile);
    if (current instanceof BufferWithFile) {
      const name = current.fileName();
      if (name !== undefined) {
        tempFilenames.push(name);
      }
    }
  }

  expect(tempFilenames).toHaveLength(totalRereads);

  expect(() => rereadable.close()).not.toThrow();

  // ensure that no lingering temp files are left after close
  for (const name of tempFilenames) {
    expect(existsSync(name)).toBe(false);
  }
});

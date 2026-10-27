// test/fixtures/pocketbase is upstream's tests/data at the pinned commit,
// byte for byte (plus its README).

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { fixtureDir, vendoredOnlyFile } from "@test/scenarios/fixture";
import { defaultLayout } from "@test/support/reference-tools";

const upstreamDir = join(defaultLayout.sourceDir, "tests", "data");

// relative path -> contents ("" for a directory)
function tree(dir: string): Map<string, Buffer | ""> {
  const entries = new Map<string, Buffer | "">();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    entries.set(relative(dir, path), entry.isDirectory() ? "" : readFileSync(path));
  }
  return entries;
}

test("the vendored fixture matches upstream's tests/data", () => {
  const vendored = tree(fixtureDir);
  const upstream = tree(upstreamDir);
  for (const name of vendored.keys()) {
    if (vendoredOnlyFile(name)) {
      vendored.delete(name);
    }
  }
  expect([...vendored.keys()].toSorted()).toEqual([...upstream.keys()].toSorted());
  for (const [name, contents] of upstream) {
    expect({
      name,
      same: contents === "" || contents.equals(vendored.get(name) as Buffer),
    }).toEqual({
      name,
      same: true,
    });
  }
});

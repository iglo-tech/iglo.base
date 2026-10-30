// Cuts a failing case down to a smaller one that still differs, greedily:
// the request around the filter first, then the filter's tree, then its
// operands, then (for text that is not a tree) pieces of the text.

import type { FilterNode } from "@test/differential/fuzz/filter-ast";
import { printFilter } from "@test/differential/fuzz/filter-ast";
import type { FuzzCase } from "@test/differential/fuzz/generate";

const maxAttempts = 300;

function* simplerNodes(node: FilterNode): Generator<FilterNode> {
  switch (node.k) {
    case "paren":
      yield node.inner;
      for (const inner of simplerNodes(node.inner)) {
        yield { ...node, inner };
      }
      return;
    case "join":
      yield* node.items;
      if (node.items.length > 2) {
        for (let i = 0; i < node.items.length; i++) {
          yield { ...node, items: node.items.filter((_, j) => j !== i) };
        }
      }
      for (let i = 0; i < node.items.length; i++) {
        for (const item of simplerNodes(node.items[i] as FilterNode)) {
          yield { ...node, items: node.items.map((old, j) => (j === i ? item : old)) };
        }
      }
      return;
    case "cond": {
      if (node.gap !== " ") {
        yield { ...node, gap: " " };
      }
      const parts = node.left.split(".");
      if (parts.length > 1 && !node.left.includes("(")) {
        yield { ...node, left: parts.slice(1).join(".") };
        yield { ...node, left: parts.slice(0, -1).join(".") };
      }
      for (const right of [`""`, "1", "null"]) {
        if (node.right !== right) {
          yield { ...node, right };
        }
      }
      return;
    }
    case "raw":
      for (let cut = Math.ceil(node.text.length / 2); cut >= 1; cut = Math.floor(cut / 2)) {
        for (let at = 0; at + cut <= node.text.length; at += cut) {
          yield { k: "raw", text: node.text.slice(0, at) + node.text.slice(at + cut) };
        }
      }
      return;
  }
}

function* simplerCases(c: FuzzCase): Generator<FuzzCase> {
  for (const name of Object.keys(c.params)) {
    const { [name]: _, ...params } = c.params;
    yield { ...c, params };
  }
  for (const name of Object.keys(c.headers)) {
    const { [name]: _, ...headers } = c.headers;
    yield { ...c, headers };
  }
  if (c.rawSort !== null) {
    yield { ...c, rawSort: null };
  }
  if (c.sort !== null) {
    yield { ...c, sort: null };
    if (c.sort.length > 1) {
      for (let i = 0; i < c.sort.length; i++) {
        yield { ...c, sort: c.sort.filter((_, j) => j !== i) };
      }
    }
  }
  if (c.filter !== null) {
    yield { ...c, filter: null };
    for (const filter of simplerNodes(c.filter)) {
      yield { ...c, filter };
    }
  }
}

function size(c: FuzzCase): number {
  return (
    (c.filter === null ? 0 : printFilter(c.filter).length) +
    (c.rawSort?.length ?? 0) +
    (c.sort ?? []).reduce((sum, term) => sum + term.length + 1, 0) +
    Object.keys(c.params).length +
    Object.keys(c.headers).length
  );
}

export async function shrinkCase(
  start: FuzzCase,
  stillDiffers: (c: FuzzCase) => Promise<boolean>,
): Promise<FuzzCase> {
  let best = start;
  let attempts = 0;
  for (let progress = true; progress && attempts < maxAttempts;) {
    progress = false;
    for (const candidate of simplerCases(best)) {
      if (size(candidate) >= size(best)) {
        continue;
      }
      if (attempts++ >= maxAttempts) {
        break;
      }
      if (await stillDiffers(candidate)) {
        best = candidate;
        progress = true;
        break;
      }
    }
  }
  return best;
}

// M7.1c: cleanSlashPath answers a clean rooted path without splitting it; the
// answer is path.Clean's for any input (compared with a reference
// implementation over generated paths).

import { expect, test } from "bun:test";

import { cleanSlashPath } from "@/server/mux";

function reference(p: string): string {
  if (p === "") {
    return ".";
  }
  const rooted = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!rooted) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (rooted) {
    return `/${joined}`;
  }
  return joined === "" ? "." : joined;
}

test("cleanSlashPath equals path.Clean", () => {
  const parts = ["", ".", "..", "a", "api", ".a", "a.", "..a", "b..", "é", "%2e", "x y"];
  let seed = 12345;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  for (const p of [
    "",
    "/",
    "//",
    "/.",
    "/..",
    "./a",
    "a",
    "a/",
    "/a/",
    "/a//b",
    "/a/./b",
    "/a/../b",
  ]) {
    expect(cleanSlashPath(p)).toBe(reference(p));
  }
  for (let i = 0; i < 20000; i++) {
    const n = next(6);
    let p = next(4) === 0 ? "" : "/";
    for (let j = 0; j < n; j++) {
      p += parts[next(parts.length)] + (next(5) === 0 ? "/" : j < n - 1 ? "/" : "");
    }
    expect(cleanSlashPath(p)).toBe(reference(p));
  }
});

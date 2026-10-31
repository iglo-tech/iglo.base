// Upstream: tools/cron/cron_test.go (TestCronAdd, TestCronRemove), the job
// registry; the ticker is M5.6.

import { expect, test } from "bun:test";

import { Cron } from "@/tools/cron/cron";

test("add registers a job, and an existing id replaces the old one", () => {
  const c = new Cron();
  const ran: string[] = [];
  c.add("test", "* * * * *", () => ran.push("old"));
  c.add("other", "0 * * * *", () => ran.push("other"));
  c.add("test", "2 * * * *", () => ran.push("new"));

  expect(c.jobs().map((j) => [j.id, j.schedule.rawExpr])).toEqual([
    ["other", "0 * * * *"],
    ["test", "2 * * * *"],
  ]);

  for (const job of c.jobs()) {
    job.run();
  }
  expect(ran).toEqual(["other", "new"]);
});

test("an invalid expression is an error and keeps the old job", () => {
  const c = new Cron();
  c.add("test", "* * * * *", () => {});
  expect(() => c.add("test", "invalid", () => {})).toThrow();
  expect(c.jobs().length).toBe(1);
});

test("remove removes one job, and a missing id is a no-op", () => {
  const c = new Cron();
  c.add("a", "* * * * *", () => {});
  c.add("b", "* * * * *", () => {});
  c.remove("missing");
  c.remove("a");
  expect(c.jobs().map((j) => j.id)).toEqual(["b"]);
});

test("jobs returns a copy", () => {
  const c = new Cron();
  c.add("a", "* * * * *", () => {});
  c.jobs().pop();
  expect(c.jobs().length).toBe(1);
});

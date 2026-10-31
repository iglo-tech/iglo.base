// Upstream: tools/cron/cron_test.go, tools/cron/job_test.go
//
// Upstream's ticker tests run in a fake-time bubble (testing/synctest); here
// the cron gets a clock and timers that only move when a test moves them.
// Add's nil function error has no counterpart: the types rule it out.

import { describe, expect, test } from "bun:test";

import { Cron, type CronConfig } from "@/tools/cron/cron";

const minute = 60_000;

// a clock and timers that only move on advance()
function fakeTime(start: string): {
  config: Required<Pick<CronConfig, "clock" | "timers">>;
  advance(ms: number): void;
  pending(): number;
} {
  let now = new Date(start).getTime();
  let lastId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    config: {
      clock: { now: () => new Date(now) },
      timers: {
        setTimeout: (fn, ms) => {
          timers.set(++lastId, { at: now + ms, fn });
          return lastId;
        },
        clearTimeout: (id) => {
          timers.delete(id as number);
        },
      },
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, t]) => t.at <= end)
          .toSorted((a, b) => a[1].at - b[1].at);
        if (due.length === 0) {
          break;
        }
        const [id, timer] = due[0]!;
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function counting(time: ReturnType<typeof fakeTime>): { c: Cron; calls: () => number } {
  const c = new Cron(time.config);
  let calls = 0;
  c.add("test", "* * * * *", () => {
    calls++;
  });
  return { c, calls: () => calls };
}

test("the defaults: no jobs, not started, ticks in UTC", async () => {
  const c = new Cron();
  expect(c.total()).toBe(0);
  expect(c.jobs()).toEqual([]);
  expect(c.hasStarted()).toBe(false);

  let calls = 0;
  c.add("test", "30 9 * * *", () => {
    calls++;
  });
  c.runDue(new Date("2030-06-15T09:30:59Z"));
  c.runDue(new Date("2030-06-15T10:30:00Z"));
  await c.waitForRunning(1000);
  expect(calls).toBe(1);
});

test("setInterval changes the tick interval of a started ticker", async () => {
  const time = fakeTime("2030-01-01T00:00:00Z");
  const c = new Cron(time.config);
  let calls = 0;
  c.add("test", "* * * * *", () => {
    calls++;
  });

  c.start();
  time.advance(minute);
  expect(c.hasStarted()).toBe(true);
  await c.waitForRunning(0);
  expect(calls).toBe(1);

  // restarted at 00:01: the next multiple of 2 minutes, then every 2 minutes
  c.setInterval(2 * minute);
  time.advance(minute);
  await c.waitForRunning(0);
  expect(calls).toBe(2);
  time.advance(minute);
  await c.waitForRunning(0);
  expect(calls).toBe(2);
  time.advance(minute);
  await c.waitForRunning(0);
  expect(calls).toBe(3);
  c.stop();
});

test("setTimezone moves the moments", async () => {
  const c = new Cron();
  c.setTimezone("Asia/Tokyo");
  const ran: string[] = [];
  c.add("tokyo", "30 9 15 6 6", () => {
    ran.push("due");
  });

  // 09:30 on Saturday the 15th in Tokyo, the 15th at 00:30 in UTC
  c.runDue(new Date("2030-06-15T00:30:00Z"));
  c.runDue(new Date("2030-06-15T09:30:00Z"));
  await c.waitForRunning(1000);
  expect(ran).toEqual(["due"]);
});

test("add and remove", () => {
  const c = new Cron();

  expect(() => c.add("test1", "invalid", () => {})).toThrow(/^failed to add new cron job: /);

  c.add("test2", "* * * * *", () => {});
  c.add("test3", "* * * * *", () => {});
  c.add("test4", "* * * * *", () => {});
  // overwrite test2
  c.add("test2", "1 2 3 4 5", () => {});
  c.add("test5", "1 2 3 4 5", () => {});

  // mock job deletion
  c.remove("test4");
  // try to remove non-existing (should be no-op)
  c.remove("missing");

  expect(c.jobs().map((j) => [j.id, j.expression])).toEqual([
    ["test3", "* * * * *"],
    ["test2", "1 2 3 4 5"],
    ["test5", "1 2 3 4 5"],
  ]);
});

test("an invalid expression keeps the old job", () => {
  const c = new Cron();
  c.add("test", "* * * * *", () => {});
  expect(() => c.add("test", "invalid", () => {})).toThrow();
  expect(c.jobs().map((j) => j.expression)).toEqual(["* * * * *"]);
});

test("removeAll", () => {
  const c = new Cron();
  c.add("test1", "* * * * *", () => {});
  c.add("test2", "* * * * *", () => {});
  c.removeAll();
  expect(c.total()).toBe(0);
});

test("total", () => {
  const c = new Cron();
  c.add("test1", "* * * * *", () => {});
  c.add("test2", "* * * * *", () => {});
  // overwrite
  c.add("test1", "* * * * *", () => {});
  expect(c.total()).toBe(2);
});

test("jobs returns a copy", () => {
  const c = new Cron();
  let calls = "";
  c.add("a", "1 * * * *", () => {
    calls += "a";
  });
  c.add("b", "2 * * * *", () => {
    calls += "b";
  });
  // overwrite
  c.add("b", "3 * * * *", () => {
    calls += "c";
  });

  const jobs = c.jobs();
  expect(jobs.length).toBe(2);
  for (const j of jobs) {
    void j.run();
  }
  expect(calls).toBe("ac");

  jobs.pop();
  expect(c.total()).toBe(2);
});

test("a job's JSON is its id and expression", () => {
  const c = new Cron();
  c.add("test_id", "1 2 3 4 5", () => {});
  expect(JSON.stringify(c.jobs()[0])).toBe(`{"id":"test_id","expression":"1 2 3 4 5"}`);
});

describe("the ticker", () => {
  test("start and stop, as TestCronStartStop", async () => {
    const time = fakeTime("2000-01-01T00:00:00Z");
    const c = new Cron({ ...time.config });
    let test1 = 0;
    let test2 = 0;
    c.setInterval(250);
    c.add("test1", "* * * * *", () => {
      test1++;
    });
    c.add("test2", "* * * * *", () => {
      test2++;
    });

    // call twice Start to check if the previous ticker will be reseted
    c.start();
    c.start();
    time.advance(500);
    // call twice Stop to ensure that the second stop is no-op
    c.stop();
    c.stop();
    await c.waitForRunning(0);
    expect([test1, test2]).toEqual([2, 2]);

    // resume for 2 seconds
    c.start();
    time.advance(2000);
    c.stop();
    await c.waitForRunning(0);
    expect([test1, test2]).toEqual([10, 10]);

    // nothing ticks after the stop
    time.advance(2000);
    await c.waitForRunning(0);
    expect(test1).toBe(10);
    expect(time.pending()).toBe(0);
  });

  test("the first tick waits for the next minute boundary and runs at once", async () => {
    const time = fakeTime("2030-01-01T10:15:42.500Z");
    const { c, calls } = counting(time);

    c.start();
    time.advance(17_499);
    await c.waitForRunning(0);
    expect(c.hasStarted()).toBe(false);
    expect(calls()).toBe(0);

    time.advance(1);
    await c.waitForRunning(0);
    expect(c.hasStarted()).toBe(true);
    expect(calls()).toBe(1);

    time.advance(minute - 1);
    await c.waitForRunning(0);
    expect(calls()).toBe(1);
    time.advance(1);
    await c.waitForRunning(0);
    expect(calls()).toBe(2);
    c.stop();
  });

  test("on a boundary, start waits a whole interval", async () => {
    const time = fakeTime("2030-01-01T10:15:00Z");
    const { c, calls } = counting(time);

    c.start();
    time.advance(minute - 1);
    await c.waitForRunning(0);
    expect(calls()).toBe(0);
    time.advance(1);
    await c.waitForRunning(0);
    expect(calls()).toBe(1);
    c.stop();
  });

  test("each tick runs the jobs due in its minute, in UTC", async () => {
    const time = fakeTime("2030-01-01T09:59:30Z");
    const c = new Cron(time.config);
    const ran: string[] = [];
    c.add("hourly", "0 * * * *", () => {
      ran.push("hourly");
    });
    c.add("offset", "2 * * * *", () => {
      ran.push("offset");
    });

    c.start();
    time.advance(30_000);
    await c.waitForRunning(0);
    expect(ran).toEqual(["hourly"]);
    time.advance(2 * minute);
    await c.waitForRunning(0);
    expect(ran).toEqual(["hourly", "offset"]);
    c.stop();
  });

  test("stop during the first delay cancels it, and stop before start is safe", async () => {
    const time = fakeTime("2030-01-01T00:00:30Z");
    const { c, calls } = counting(time);

    c.stop();
    expect(c.hasStarted()).toBe(false);

    c.start();
    c.stop();
    expect(time.pending()).toBe(0);
    time.advance(5 * minute);
    await c.waitForRunning(0);
    expect(calls()).toBe(0);
  });

  test("start restarts from the next boundary", async () => {
    const time = fakeTime("2030-01-01T00:00:30Z");
    const { c, calls } = counting(time);

    c.start();
    time.advance(minute);
    await c.waitForRunning(0);
    expect(calls()).toBe(1);

    c.start();
    expect(c.hasStarted()).toBe(false);
    expect(time.pending()).toBe(1);
    time.advance(30_000);
    await c.waitForRunning(0);
    expect(calls()).toBe(2);
    c.stop();
  });

  test("a tick that fires late keeps to the minute boundaries", async () => {
    const time = fakeTime("2030-01-01T00:00:00Z");
    const c = new Cron({
      ...time.config,
      // every timer fires 40 seconds late
      timers: {
        ...time.config.timers,
        setTimeout: (fn, ms) => time.config.timers.setTimeout(fn, ms + 40_000),
      },
    });
    let calls = 0;
    c.add("test", "* * * * *", () => {
      calls++;
    });

    // 00:01:40, then the boundary after it plus the delay: 00:02:40, 00:03:40
    c.start();
    for (const [ms, expected] of [
      [100_000, 1],
      [59_999, 1],
      [1, 2],
      [60_000, 3],
    ] as const) {
      time.advance(ms);
      await c.waitForRunning(0);
      expect(calls).toBe(expected);
    }
    c.stop();
  });

  test("a late tick runs the jobs of its own time, and drops the ticks it missed", async () => {
    const time = fakeTime("2030-01-01T00:58:30Z");
    let timers = 0;
    const c = new Cron({
      ...time.config,
      // the second tick, for 01:00, fires at 01:01:10
      timers: {
        ...time.config.timers,
        setTimeout: (fn, ms) =>
          time.config.timers.setTimeout(fn, ++timers === 2 ? ms + 70_000 : ms),
      },
    });
    let hourly = 0;
    let everyMinute = 0;
    c.add("hourly", "0 * * * *", () => {
      hourly++;
    });
    c.add("minute", "* * * * *", () => {
      everyMinute++;
    });

    c.start();
    for (const [ms, expectedHourly, expectedMinute] of [
      [30_000, 0, 1], // 00:59:00
      [129_999, 0, 1],
      [1, 1, 2], // 01:01:10, for 01:00
      [50_000, 1, 3], // 01:02:00: 01:01 is dropped
    ] as const) {
      time.advance(ms);
      await c.waitForRunning(0);
      expect([hourly, everyMinute]).toEqual([expectedHourly, expectedMinute]);
    }
    c.stop();
  });

  test("a tick that fires early still belongs to the boundary it was set for", async () => {
    const time = fakeTime("2030-01-01T09:59:30Z");
    const c = new Cron({
      ...time.config,
      timers: {
        ...time.config.timers,
        // one millisecond before its time on the wall clock
        setTimeout: (fn, ms) => time.config.timers.setTimeout(fn, ms - 1),
      },
    });
    let calls = 0;
    c.add("hourly", "0 * * * *", () => {
      calls++;
    });

    c.start();
    time.advance(30_000 - 1);
    await c.waitForRunning(0);
    expect(calls).toBe(1);
    c.stop();
  });

  test("a job that throws or rejects never stops later ticks", async () => {
    const time = fakeTime("2030-01-01T00:00:00Z");
    const panics: unknown[] = [];
    const c = new Cron({ ...time.config, logPanic: (cause) => panics.push(cause) });
    let calls = 0;
    c.add("sync", "* * * * *", () => {
      calls++;
      throw new Error("sync failure");
    });
    c.add("async", "* * * * *", async () => {
      calls++;
      await Promise.resolve();
      throw new Error("async failure");
    });

    c.start();
    time.advance(minute);
    await c.waitForRunning(0);
    time.advance(minute);
    await c.waitForRunning(0);
    c.stop();

    expect(calls).toBe(4);
    expect(panics.map((p) => (p as Error).message).toSorted()).toEqual([
      "async failure",
      "async failure",
      "sync failure",
      "sync failure",
    ]);
  });

  test("a job starts off the tick and may overlap itself", async () => {
    const time = fakeTime("2030-01-01T00:00:00Z");
    const c = new Cron(time.config);
    let started = 0;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    c.add("slow", "* * * * *", async () => {
      started++;
      await released;
    });

    c.start();
    time.advance(minute);
    // the tick has returned before the job ran
    expect(started).toBe(0);
    await Bun.sleep(0);
    expect(started).toBe(1);

    time.advance(minute);
    await Bun.sleep(0);
    expect(started).toBe(2);

    c.stop();
    release();
    await c.waitForRunning(0);
  });
});

describe("waitForRunning", () => {
  test("waits for a running job", async () => {
    const c = new Cron();
    let finished = false;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    c.add("slow", "* * * * *", async () => {
      await released;
      finished = true;
    });
    c.fireAndForget(c.jobs()[0]!);

    const waited = c.waitForRunning(60_000).then(() => finished);
    release();
    expect(await waited).toBe(true);
  });

  test("gives up on a job that never ends", async () => {
    const time = fakeTime("2030-01-01T00:00:00Z");
    const c = new Cron(time.config);
    c.add("stuck", "* * * * *", () => new Promise<void>(() => {}));
    c.fireAndForget(c.jobs()[0]!);

    let done = false;
    const waited = c.waitForRunning(5000).then(() => {
      done = true;
    });
    await Bun.sleep(0);
    expect(done).toBe(false);
    time.advance(5000);
    await waited;
    expect(done).toBe(true);
  });
});

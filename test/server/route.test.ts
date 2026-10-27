// Upstream: tools/router/route_test.go

import { describe, expect, test } from "bun:test";

import { Event } from "@/server/event";
import { Route } from "@/server/route";

// the handlers under test ignore their event argument, as the Go tests pass nil
const nilEvent = undefined as unknown as Event;

describe("Route", () => {
  test("bindFunc", async () => {
    const r = new Route<Event>("", "", () => undefined);

    let calls = "";

    // append one function
    r.bindFunc(() => {
      calls += "a";
      return undefined;
    });

    // append multiple functions
    r.bindFunc(
      () => {
        calls += "b";
        return undefined;
      },
      () => {
        calls += "c";
        return undefined;
      },
    );

    expect(r.middlewares.length).toBe(3);

    for (const h of r.middlewares) {
      await h.func(nilEvent);
    }

    expect(calls).toBe("abc");
  });

  test("bind", async () => {
    const r = new Route<Event>("", "", () => undefined);
    // mock excluded middlewares to check whether the entry will be deleted
    r.excludedMiddlewares = new Set(["test2"]);

    let calls = "";

    // append one handler
    r.bind({
      func: () => {
        calls += "a";
        return undefined;
      },
    });

    // append multiple handlers
    r.bind(
      {
        id: "test1",
        func: () => {
          calls += "b";
          return undefined;
        },
      },
      {
        id: "test2",
        func: () => {
          calls += "c";
          return undefined;
        },
      },
    );

    expect(r.middlewares.length).toBe(3);

    for (const h of r.middlewares) {
      await h.func(nilEvent);
    }

    expect(calls).toBe("abc");

    // ensures that the previously excluded middleware was removed
    expect(r.excludedMiddlewares.size).toBe(0);
  });

  test("unbind", async () => {
    const r = new Route<Event>("", "", () => undefined);

    let calls = "";

    // anonymous middlewares
    r.bind({
      func: () => {
        calls += "a";
        return undefined; // unused value
      },
    });

    // middlewares with id
    r.bind({
      id: "test1",
      func: () => {
        calls += "b";
        return undefined; // unused value
      },
    });
    r.bind({
      id: "test2",
      func: () => {
        calls += "c";
        return undefined; // unused value
      },
    });
    r.bind({
      id: "test3",
      func: () => {
        calls += "d";
        return undefined; // unused value
      },
    });

    // remove
    r.unbind(""); // should be no-op
    r.unbind("test1", "test3");

    expect(r.middlewares.length).toBe(2);

    for (const h of r.middlewares) {
      await h.func(nilEvent);
    }

    expect(calls).toBe("ac");

    // ensure that the id was added in the exclude list
    const excluded = ["test1", "test3"];
    expect(r.excludedMiddlewares?.size).toBe(excluded.length);
    for (const id of r.excludedMiddlewares ?? []) {
      expect(excluded).toContain(id);
    }
  });
});

// Upstream: tools/router/group_test.go

import { describe, expect, test } from "bun:test";

import { Event } from "@/server/event";
import { RouterGroup } from "@/server/group";
import { Route } from "@/server/route";

// the handlers under test ignore their event argument, as the Go tests pass nil
const nilEvent = undefined as unknown as Event;
const noop = () => undefined;

describe("RouterGroup", () => {
  test("group", () => {
    const g0 = new RouterGroup<Event>();

    const g1 = g0.group("test1");
    const g2 = g0.group("test2");

    expect(g0.children.length).toBe(2);

    expect(g1.prefix).toBe("test1");
    expect(g2.prefix).toBe("test2");
  });

  test("bindFunc", async () => {
    const g = new RouterGroup<Event>();

    let calls = "";

    // append one function
    g.bindFunc(() => {
      calls += "a";
      return undefined;
    });

    // append multiple functions
    g.bindFunc(
      () => {
        calls += "b";
        return undefined;
      },
      () => {
        calls += "c";
        return undefined;
      },
    );

    expect(g.middlewares.length).toBe(3);

    for (const h of g.middlewares) {
      await h.func(nilEvent);
    }

    expect(calls).toBe("abc");
  });

  test("bind", async () => {
    const g = new RouterGroup<Event>();
    // mock excluded middlewares to check whether the entry will be deleted
    g.excludedMiddlewares = new Set(["test2"]);

    let calls = "";

    // append one handler
    g.bind({
      func: () => {
        calls += "a";
        return undefined;
      },
    });

    // append multiple handlers
    g.bind(
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

    expect(g.middlewares.length).toBe(3);

    for (const h of g.middlewares) {
      await h.func(nilEvent);
    }

    expect(calls).toBe("abc");

    // ensures that the previously excluded middleware was removed
    expect(g.excludedMiddlewares.size).toBe(0);
  });

  test("unbind", async () => {
    const g = new RouterGroup<Event>();

    let calls = "";

    // anonymous middlewares
    g.bind({
      func: () => {
        calls += "a";
        return undefined; // unused value
      },
    });

    // middlewares with id
    g.bind({
      id: "test1",
      func: () => {
        calls += "b";
        return undefined; // unused value
      },
    });
    g.bind({
      id: "test2",
      func: () => {
        calls += "c";
        return undefined; // unused value
      },
    });
    g.bind({
      id: "test3",
      func: () => {
        calls += "d";
        return undefined; // unused value
      },
    });

    // remove
    g.unbind(""); // should be no-op
    g.unbind("test1", "test3");

    expect(g.middlewares.length).toBe(2);

    for (const h of g.middlewares) {
      await h.func(nilEvent);
    }

    expect(calls).toBe("ac");

    // ensure that the ids were added in the exclude list
    const excluded = ["test1", "test3"];
    expect(g.excludedMiddlewares?.size).toBe(excluded.length);
    for (const id of g.excludedMiddlewares ?? []) {
      expect(excluded).toContain(id);
    }
  });

  test("route", async () => {
    const group = new RouterGroup<Event>();

    const sub = group.group("sub");

    let called = false;
    const route = group.route("POST", "/test", () => {
      called = true;
      return undefined;
    });

    // ensure that the route was registered only to the main one
    // ---
    expect(sub.children.length).toBe(0);

    expect(group.children.length).toBe(2);
    // ---

    // check the registered route
    // ---
    expect(group.children[1]).toBe(route);

    expect(route.method).toBe("POST");

    expect(route.path).toBe("/test");

    await route.action(nilEvent);
    expect(called).toBe(true);
  });

  describe("route aliases", () => {
    const group = new RouterGroup<Event>();

    const testErr = new Error("test");

    const testAction = () => testErr;

    const scenarios: { route: Route<Event>; expectMethod: string; expectPath: string }[] = [
      {
        route: group.any("/test", testAction),
        expectMethod: "",
        expectPath: "/test",
      },
      {
        route: group.GET("/test", testAction),
        expectMethod: "GET",
        expectPath: "/test",
      },
      {
        route: group.SEARCH("/test", testAction),
        expectMethod: "SEARCH",
        expectPath: "/test",
      },
      {
        route: group.POST("/test", testAction),
        expectMethod: "POST",
        expectPath: "/test",
      },
      {
        route: group.DELETE("/test", testAction),
        expectMethod: "DELETE",
        expectPath: "/test",
      },
      {
        route: group.PATCH("/test", testAction),
        expectMethod: "PATCH",
        expectPath: "/test",
      },
      {
        route: group.PUT("/test", testAction),
        expectMethod: "PUT",
        expectPath: "/test",
      },
      {
        route: group.HEAD("/test", testAction),
        expectMethod: "HEAD",
        expectPath: "/test",
      },
      {
        route: group.OPTIONS("/test", testAction),
        expectMethod: "OPTIONS",
        expectPath: "/test",
      },
    ];

    scenarios.forEach((s, i) => {
      test(`${i}_${s.expectMethod}_${s.expectPath}`, async () => {
        expect(s.route.method).toBe(s.expectMethod);

        expect(s.route.path).toBe(s.expectPath);

        expect(await s.route.action(nilEvent)).toBe(testErr);
      });
    });
  });

  describe("hasRoute", () => {
    const group = new RouterGroup<Event>();

    group.any("/any", noop);

    group.GET("/base", noop);
    group.DELETE("/base", noop);

    const sub = group.group("/sub1");
    sub.GET("/a", noop);
    sub.POST("/a", noop);

    const sub2 = sub.group("/sub2");
    sub2.GET("/b", noop);
    sub2.GET("/b/{test}", noop);

    // special cases to test the normalizations
    group.GET("/c/", noop); // the same as /c/{test...}
    group.GET("/d/{test...}", noop); // the same as /d/

    const scenarios: { method: string; path: string; expected: boolean }[] = [
      {
        method: "GET",
        path: "",
        expected: false,
      },
      {
        method: "",
        path: "/any",
        expected: true,
      },
      {
        method: "POST",
        path: "/base",
        expected: false,
      },
      {
        method: "GET",
        path: "/base",
        expected: true,
      },
      {
        method: "DELETE",
        path: "/base",
        expected: true,
      },
      {
        method: "GET",
        path: "/sub1",
        expected: false,
      },
      {
        method: "GET",
        path: "/sub1/a",
        expected: true,
      },
      {
        method: "POST",
        path: "/sub1/a",
        expected: true,
      },
      {
        method: "DELETE",
        path: "/sub1/a",
        expected: false,
      },
      {
        method: "GET",
        path: "/sub2/b",
        expected: false,
      },
      {
        method: "GET",
        path: "/sub1/sub2/b",
        expected: true,
      },
      {
        method: "GET",
        path: "/sub1/sub2/b/{test}",
        expected: true,
      },
      {
        method: "GET",
        path: "/sub1/sub2/b/{test2}",
        expected: false,
      },
      {
        method: "GET",
        path: "/c/{test...}",
        expected: true,
      },
      {
        method: "GET",
        path: "/d/",
        expected: true,
      },
    ];

    for (const s of scenarios) {
      test(`${s.method}_${s.path}`, () => {
        const has = group.hasRoute(s.method, s.path);

        expect(has).toBe(s.expected);
      });
    }
  });
});

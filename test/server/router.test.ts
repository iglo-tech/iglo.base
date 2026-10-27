// Upstream: tools/router/router_test.go

import { describe, expect, test } from "bun:test";

import { Event } from "@/server/event";
import { Router } from "@/server/router";
import { serveTest } from "@test/support/router";

describe("Router", () => {
  describe("routes and middlewares", () => {
    let calls = "";

    const r = new Router<Event>((w, req) => [
      new Event(w, req),
      () => {
        calls += ":cleanup";
      },
    ]);

    r.bindFunc(async (e) => {
      calls += "root_m:";

      const err = await e.next();

      if (err) {
        calls += "/error";
      }

      return err;
    });

    r.any("/any", () => {
      calls += "/any";
      return undefined;
    });

    r.GET("/a", () => {
      calls += "/a";
      return undefined;
    });

    const g1 = r.group("/a/b").bindFunc(async (e) => {
      calls += "a_b_group_m:";
      return e.next();
    });
    g1.GET("/1", () => {
      calls += "/1_get";
      return undefined;
    }).bindFunc(async (e) => {
      calls += "1_get_m:";
      return e.next();
    });
    g1.POST("/1", () => {
      calls += "/1_post";
      return undefined;
    });
    g1.GET("/{param}", (e) => {
      calls += "/" + e.request.pathValue("param");
      return new Error("test"); // should be normalized to an ApiError
    });

    const mux = r.buildMux();

    const scenarios: { method: string; path: string; calls: string }[] = [
      { method: "GET", path: "/any", calls: "root_m:/any:cleanup" },
      { method: "OPTIONS", path: "/any", calls: "root_m:/any:cleanup" },
      { method: "PATCH", path: "/any", calls: "root_m:/any:cleanup" },
      { method: "PUT", path: "/any", calls: "root_m:/any:cleanup" },
      { method: "POST", path: "/any", calls: "root_m:/any:cleanup" },
      { method: "DELETE", path: "/any", calls: "root_m:/any:cleanup" },
      // ---
      { method: "POST", path: "/a", calls: "root_m:/error:cleanup" }, // missing
      { method: "GET", path: "/a", calls: "root_m:/a:cleanup" },
      { method: "HEAD", path: "/a", calls: "root_m:/a:cleanup" }, // auto registered with the GET
      { method: "GET", path: "/a/b/1", calls: "root_m:a_b_group_m:1_get_m:/1_get:cleanup" },
      { method: "HEAD", path: "/a/b/1", calls: "root_m:a_b_group_m:1_get_m:/1_get:cleanup" },
      { method: "POST", path: "/a/b/1", calls: "root_m:a_b_group_m:/1_post:cleanup" },
      { method: "GET", path: "/a/b/456", calls: "root_m:a_b_group_m:/456/error:cleanup" },
    ];

    for (const s of scenarios) {
      test(`${s.method}_${s.path}`, async () => {
        calls = ""; // reset

        await serveTest(mux, { method: s.method, target: s.path });

        expect(calls).toBe(s.calls);
      });
    }
  });

  describe("unbind", () => {
    let calls = "";

    const r = new Router<Event>((w, req) => [
      new Event(w, req),
      () => {
        calls += ":cleanup";
      },
    ]);
    r.bind({
      id: "root_1",
      func: async (e) => {
        calls += "root_1:";
        return e.next();
      },
    });
    r.bind({
      id: "root_2",
      func: async (e) => {
        calls += "root_2:";
        return e.next();
      },
    });
    r.bind({
      id: "root_3",
      func: async (e) => {
        calls += "root_3:";
        return e.next();
      },
    });
    r.GET("/action", () => {
      calls += "root_action";
      return undefined;
    }).unbind("root_1");

    const ga = r.group("/group_a");
    ga.unbind("root_1");
    ga.bind({
      id: "group_a_1",
      func: async (e) => {
        calls += "group_a_1:";
        return e.next();
      },
    });
    ga.bind({
      id: "group_a_2",
      func: async (e) => {
        calls += "group_a_2:";
        return e.next();
      },
    });
    ga.bind({
      id: "group_a_3",
      func: async (e) => {
        calls += "group_a_3:";
        return e.next();
      },
    });
    ga.GET("/action", () => {
      calls += "group_a_action";
      return undefined;
    }).unbind("root_2", "group_b_1", "group_a_1");

    const gb = r.group("/group_b");
    gb.unbind("root_2");
    gb.bind({
      id: "group_b_1",
      func: async (e) => {
        calls += "group_b_1:";
        return e.next();
      },
    });
    gb.bind({
      id: "group_b_2",
      func: async (e) => {
        calls += "group_b_2:";
        return e.next();
      },
    });
    gb.bind({
      id: "group_b_3",
      func: async (e) => {
        calls += "group_b_3:";
        return e.next();
      },
    });
    gb.GET("/action", () => {
      calls += "group_b_action";
      return undefined;
    }).unbind("group_b_3", "group_a_3", "root_3");

    const mux = r.buildMux();

    const scenarios: { method: string; path: string; calls: string }[] = [
      { method: "GET", path: "/action", calls: "root_2:root_3:root_action:cleanup" },
      {
        method: "GET",
        path: "/group_a/action",
        calls: "root_3:group_a_2:group_a_3:group_a_action:cleanup",
      },
      {
        method: "GET",
        path: "/group_b/action",
        calls: "root_1:group_b_1:group_b_2:group_b_action:cleanup",
      },
    ];

    for (const s of scenarios) {
      test(`${s.method}_${s.path}`, async () => {
        calls = ""; // reset

        await serveTest(mux, { method: s.method, target: s.path });

        expect(calls).toBe(s.calls);
      });
    }
  });
});

// Upstream: tools/subscriptions/client_test.go

import { expect, test } from "bun:test";

import { Client, type ClientReceiver } from "@/tools/subscriptions/client";
import { Message } from "@/tools/subscriptions/message";

// a receiver that records what it gets
function recorder(): ClientReceiver & { names: string[]; discards: number } {
  const r = {
    names: [] as string[],
    discards: 0,
    message(m: Message) {
      r.names.push(m.name);
    },
    discarded() {
      r.discards++;
    },
  };
  return r;
}

test("TestNewDefaultClient", () => {
  const c = new Client();

  expect(c.subscriptions().size).toBe(0);
  expect(c.id()).not.toBe("");
});

test("TestId", () => {
  const clients = [new Client(), new Client(), new Client(), new Client()];

  const ids = new Set<string>();
  for (const c of clients) {
    // check uniqueness
    expect(ids.has(c.id())).toBe(false);
    ids.add(c.id());

    // check length
    expect(c.id().length).toBe(40);
  }
});

// Go's Channel() does not exist; the receiver set by listen() takes its place
test("TestChannel", () => {
  const c = new Client();

  const r = recorder();
  c.listen(r);

  c.send(new Message("m1", new Uint8Array()));
  expect(r.names).toEqual(["m1"]);
});

test("TestSubscriptions", () => {
  const c = new Client();

  expect(c.subscriptions().size).toBe(0);

  c.subscribe("sub1", "sub11", "sub2");

  const scenarios: { prefixes: string[]; expected: string[] | null }[] = [
    { prefixes: [], expected: ["sub1", "sub11", "sub2"] },
    { prefixes: ["missing"], expected: null },
    { prefixes: ["sub1"], expected: ["sub1", "sub11"] },
    { prefixes: ["sub2"], expected: ["sub2"] }, // with extra query start char
  ];

  for (const s of scenarios) {
    const subs = c.subscriptions(...s.prefixes);
    const expected = s.expected ?? [];

    expect(subs.size).toBe(expected.length);
    for (const name of expected) {
      expect(subs.has(name)).toBe(true);
    }
  }
});

test("TestSubscribe", () => {
  const c = new Client();

  const subs = ["", "sub1", "sub2", "sub3"];
  const expected = ["sub1", "sub2", "sub3"];

  c.subscribe(...subs); // empty string should be skipped

  expect(c.subscriptions().size).toBe(3);

  for (const s of expected) {
    expect(c.hasSubscription(s)).toBe(true);
  }
});

test("TestSubscribeOptions", () => {
  const c = new Client();

  const sub1 = "test1";
  const sub2 = `test2?options={"query":{"name":123},"headers":{"X-Token":456}}`;

  c.subscribe(sub1, sub2);

  const subs = c.subscriptions();

  const scenarios = [
    { name: sub1, expectedOptions: `{"query":{},"headers":{}}` },
    {
      name: sub2,
      expectedOptions: `{"query":{"name":"123"},"headers":{"x_token":"456"}}`,
    },
  ];

  for (const s of scenarios) {
    const options = subs.get(s.name);
    expect(options).toBeDefined();

    // compared as serialized text, like upstream, so the key order is checked too
    expect(JSON.stringify(options)).toBe(s.expectedOptions);
  }
});

test("TestUnsubscribe", () => {
  const c = new Client();

  c.subscribe("sub1", "sub2", "sub3");

  c.unsubscribe("sub1");

  expect(c.hasSubscription("sub1")).toBe(false);

  c.unsubscribe(/* all */);
  expect(c.subscriptions().size).toBe(0);
});

test("TestHasSubscription", () => {
  const c = new Client();

  expect(c.hasSubscription("missing")).toBe(false);

  c.subscribe("sub");

  expect(c.hasSubscription("sub")).toBe(true);
});

test("TestSetAndGet", () => {
  const c = new Client();

  c.set("demo", 1);

  expect(c.get("demo")).toBe(1);
});

test("TestDiscard", () => {
  const c = new Client();

  expect(c.isDiscarded()).toBe(false);

  c.discard();

  expect(c.isDiscarded()).toBe(true);
});

// Go's TestSend reads a Channel() from a goroutine; here messages sent before
// listen() are held and delivered when the receiver is set, and discard()
// notifies the receiver.
test("TestSend", () => {
  const c = new Client();

  c.send(new Message("m1", new Uint8Array()));
  c.send(new Message("m2", new Uint8Array()));

  const r = recorder();
  c.listen(r);
  expect(r.names).toEqual(["m1", "m2"]);

  c.discard();
  expect(r.discards).toBe(1);

  c.send(new Message("m3", new Uint8Array()));
  c.send(new Message("m4", new Uint8Array()));
  expect(r.names).toEqual(["m1", "m2"]);
});

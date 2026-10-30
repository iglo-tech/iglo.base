// Upstream: tools/subscriptions/broker_test.go

import { describe, expect, test } from "bun:test";

import { Broker } from "@/tools/subscriptions/broker";
import { Client } from "@/tools/subscriptions/client";

describe("subscriptions broker", () => {
  test("TestNewBroker", () => {
    const b = new Broker();

    expect(b.clients()).toBeInstanceOf(Map);
  });

  test("TestClients", () => {
    const b = new Broker();

    expect(b.clients().size).toBe(0);

    b.register(new Client());
    b.register(new Client());

    // check if it is a shallow copy
    const clients = b.clients();
    for (const k of clients.keys()) {
      clients.delete(k);
    }

    // should return a new copy
    expect(b.clients().size).toBe(2);
  });

  test("TestChunkedClients", () => {
    const b = new Broker();

    let chunks = b.chunkedClients(2);
    expect(chunks.length).toBe(0);

    b.register(new Client());
    b.register(new Client());
    b.register(new Client());

    chunks = b.chunkedClients(2);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(2);
    expect(chunks[1]!.length).toBe(1);
  });

  test("TestTotalClients", () => {
    const b = new Broker();

    expect(b.totalClients()).toBe(0);

    b.register(new Client());
    b.register(new Client());

    expect(b.totalClients()).toBe(2);
  });

  test("TestClientById", () => {
    const b = new Broker();

    const clientA = new Client();
    const clientB = new Client();
    b.register(clientA);
    b.register(clientB);

    const resultClient = b.clientById(clientA.id());
    expect(resultClient.id()).toBe(clientA.id());

    // Go returns an error here; the port throws
    expect(() => b.clientById("missing")).toThrow();
  });

  test("TestRegister", () => {
    const b = new Broker();

    const client = new Client();
    b.register(client);

    expect(b.clientById(client.id())).toBe(client);
  });

  test("TestUnregister", () => {
    const b = new Broker();

    const clientA = new Client();
    const clientB = new Client();
    b.register(clientA);
    b.register(clientB);

    expect(b.clientById(clientA.id())).toBe(clientA);

    b.unregister(clientA.id());

    expect(() => b.clientById(clientA.id())).toThrow();

    // clientB shouldn't have been removed
    expect(b.clientById(clientB.id())).toBe(clientB);
  });
});

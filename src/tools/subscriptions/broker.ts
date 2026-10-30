// Upstream: tools/subscriptions/broker.go
//
// The clients are kept in registration order (Go's store map has a random
// order).

import type { Client } from "@/tools/subscriptions/client";
import { toChunks } from "@/tools/list/list";

// Broker defines a struct for managing subscriptions clients.
export class Broker {
  readonly #store = new Map<string, Client>();

  // Clients returns a shallow copy of all registered clients indexed
  // with their connection id.
  clients(): Map<string, Client> {
    return new Map(this.#store);
  }

  // ChunkedClients splits the current clients into a chunked slice.
  chunkedClients(chunkSize: number): Client[][] {
    return toChunks([...this.#store.values()], chunkSize);
  }

  // TotalClients returns the total number of registered clients.
  totalClients(): number {
    return this.#store.size;
  }

  // ClientById finds a registered client by its id.
  //
  // Throws when client with clientId is not registered.
  clientById(clientId: string): Client {
    const client = this.#store.get(clientId);
    if (client === undefined) {
      // (%q of an id is its JSON string for the ids the broker issues)
      throw new Error(`no client associated with connection ID ${JSON.stringify(clientId)}`);
    }

    return client;
  }

  // Register adds a new client to the broker instance.
  register(client: Client): void {
    this.#store.set(client.id(), client);
  }

  // Unregister removes a single client by its id and marks it as discarded.
  //
  // If client with clientId doesn't exist, this method does nothing.
  unregister(clientId: string): void {
    const client = this.#store.get(clientId);
    if (client === undefined) {
      return;
    }
    client.discard();
    this.#store.delete(clientId);
  }
}

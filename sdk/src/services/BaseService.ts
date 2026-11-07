// js-sdk v0.28.1 src/services/BaseService.ts
import Client from "@sdk/Client";

/**
 * BaseService class that should be inherited from all API services.
 */
export abstract class BaseService {
  readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }
}

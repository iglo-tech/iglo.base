// js-sdk v0.28.1 src/services/HealthService.ts
import type { LooseObject } from "@sdk/tools/loose";
import { BaseService } from "@sdk/services/BaseService";
import { type CommonOptions } from "@sdk/tools/options";

export interface HealthCheckResponse {
  code: number;
  message: string;
  data: LooseObject;
}

export class HealthService extends BaseService {
  /**
   * Checks the health status of the api.
   *
   * @throws {ClientResponseError}
   */
  async check(options?: CommonOptions): Promise<HealthCheckResponse> {
    options = Object.assign(
      {
        method: "GET",
      },
      options,
    );

    return this.client.send("/api/health", options);
  }
}

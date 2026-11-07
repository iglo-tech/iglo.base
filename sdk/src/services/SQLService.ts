// js-sdk v0.28.1 src/services/SQLService.ts
import { BaseService } from "@sdk/services/BaseService";
import { type CommonOptions } from "@sdk/tools/options";

export interface SQLResult {
  execTime: number;
  affectedRows: number;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
  rows: Array<Array<string | null>>;
}

export class SQLService extends BaseService {
  /**
   * Executes the specified raw SQL query.
   * This operation is allowed only for superusers.
   *
   * @throws {ClientResponseError}
   */
  async run(query: string, options?: CommonOptions): Promise<SQLResult> {
    options = Object.assign(
      {
        method: "POST",
        body: { query },
      },
      options,
    );

    return this.client.send("/api/sql", options);
  }
}

// Upstream: core/log_query.go (DeleteOldLogs)

import type { App } from "@/app/app";
import { newExp } from "@/db/dbx/expression";
import type { DateTime } from "@/tools/types/datetime";

// DeleteOldLogs delete all logs that are created before createdBefore.
export function deleteOldLogs(app: Pick<App, "databases">, createdBefore: DateTime): void {
  const formattedDate = createdBefore.toString();
  const expr = newExp("[[created]] <= {:date}", { date: formattedDate });

  app.databases.auxNonconcurrentDB().delete("_logs", expr).execute();
}

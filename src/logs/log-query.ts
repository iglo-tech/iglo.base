// Upstream: core/log_query.go

import type { App } from "@/app/app";
import { auxModelQuery } from "@/db/db";
import type { Expression } from "@/db/dbx/expression";
import { HashExp, newExp } from "@/db/dbx/expression";
import type { SelectQuery } from "@/db/dbx/select";
import { Log, LogsTableName } from "@/logs/log-model";
import { parseDateTime, type DateTime } from "@/tools/types/datetime";

// LogQuery returns a new Log select query.
export function logQuery(app: Pick<App, "databases">): SelectQuery {
  return auxModelQuery(app.databases, new Log());
}

// FindLogById finds a single Log entry by its id.
export async function findLogById(app: Pick<App, "databases">, id: string): Promise<Log> {
  return logQuery(app).andWhere(new HashExp({ id })).limit(1).oneAsync(new Log());
}

// LogsStatsItem defines the total number of logs for a specific time period.
export interface LogsStatsItem {
  date: string;
  total: number;
}

// LogsStats returns hourly grouped logs statistics.
export async function logsStats(
  app: Pick<App, "databases">,
  expr: Expression | null,
): Promise<LogsStatsItem[]> {
  const query = logQuery(app)
    .select("count(id) as total", "strftime('%Y-%m-%d %H:00:00', created) as date")
    .groupBy("date");

  if (expr !== null) {
    query.andWhere(expr);
  }

  const rows = await query.allAsync();

  return rows.map((row) => ({
    date: parseDateTime(row.date).toString(),
    total: Number(row.total),
  }));
}

// DeleteOldLogs delete all logs that are created before createdBefore.
export function deleteOldLogs(app: Pick<App, "databases">, createdBefore: DateTime): void {
  const formattedDate = createdBefore.toString();
  const expr = newExp("[[created]] <= {:date}", { date: formattedDate });

  app.databases.auxNonconcurrentDB().delete(LogsTableName, expr).execute();
}

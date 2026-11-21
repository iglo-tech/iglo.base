// Upstream: apis/logs.go

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { auxVacuum } from "@/db/table";
import { Log, LogsTableName } from "@/logs/log-model";
import { findLogById, logQuery, logsStats } from "@/logs/log-query";
import type { Expression } from "@/db/dbx/expression";
import { skipSuccessActivityLog } from "@/middlewares/activity-logger";
import { requireSuperuserAuth } from "@/middlewares/require-auth";
import { filterBuildExpr } from "@/search/filter";
import { newProvider } from "@/search/provider";
import { newSimpleFieldResolver } from "@/search/simple-field-resolver";
import { encodeValues } from "@/server/request";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";

// bindLogsApi registers the request logs api endpoints.
export function bindLogsApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const sub = rg.group("/logs").bind(requireSuperuserAuth(), skipSuccessActivityLog());

  sub.GET("", logsList);
  sub.DELETE("", logsTruncate);
  sub.GET("/stats", logsStatsHandler);
  sub.GET("/{id}", logsView);
}

const logFilterFields = [
  "id",
  "created",
  "level",
  "message",
  "data",
  String.raw`^data\.[\w\.\:]*\w+$`,
];

async function logsList(e: RequestEvent): Promise<HandlerResult> {
  const fieldResolver = newSimpleFieldResolver(...logFilterFields);

  let result;
  try {
    result = await newProvider(fieldResolver, { clock: e.app.clock })
      .query(logQuery(e.app))
      .parseAndExec<Log>(encodeValues(e.request.query()), () => new Log());
  } catch (error) {
    return e.badRequestError("", error);
  }

  return e.json(200, result);
}

async function logsStatsHandler(e: RequestEvent): Promise<HandlerResult> {
  const fieldResolver = newSimpleFieldResolver(...logFilterFields);

  const filter = e.request.query().get("filter")?.[0] ?? "";

  let expr: Expression | null = null;
  if (filter !== "") {
    try {
      expr = filterBuildExpr(filter, fieldResolver, { clock: e.app.clock });
    } catch (error) {
      return e.badRequestError("Invalid filter format.", error);
    }
  }

  let stats;
  try {
    stats = await logsStats(e.app, expr);
  } catch (error) {
    return e.badRequestError("Failed to generate logs stats.", error);
  }

  return e.json(200, stats);
}

async function logsView(e: RequestEvent): Promise<HandlerResult> {
  const id = e.request.pathValue("id");
  if (id === "") {
    return e.notFoundError("", undefined);
  }

  let log: Log;
  try {
    log = await findLogById(e.app, id);
  } catch (error) {
    return e.notFoundError("", error);
  }

  return e.json(200, log);
}

function logsTruncate(e: RequestEvent): HandlerResult {
  // delete all rows directly (aka. no model hooks will be fired)
  try {
    e.app.databases.auxNonconcurrentDB().delete(LogsTableName, null).execute();
  } catch (error) {
    return e.internalServerError("Failed to truncate all logs.", error);
  }

  // try to free the unused disk space
  try {
    auxVacuum(e.app.databases);
  } catch (error) {
    e.app.logger.warn("Failed to VACUUM aux database", { error: error });
  }

  return e.noContent(204);
}

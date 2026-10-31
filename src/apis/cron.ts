// Upstream: apis/cron.go

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { requireSuperuserAuth } from "@/middlewares/require-auth";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import type { Job } from "@/tools/cron/cron";

// bindCronApi registers the crons api endpoint.
export function bindCronApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const subGroup = rg.group("/crons").bind(requireSuperuserAuth());
  subGroup.GET("", cronsList);
  subGroup.POST("/{id}", cronRun);
}

function compareJobs(a: Job, b: Job): number {
  if (a.id.startsWith("__pb")) {
    return 1;
  }
  if (b.id.startsWith("__pb")) {
    return -1;
  }
  return Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
}

// slices.SortStableFunc for its below 20 items: insertionSortCmpFunc.
// compareJobs is not a consistent ordering, so the result is this algorithm's
// and not any stable sort's; the app registers fewer than 20 jobs.
function sortJobs(jobs: Job[]): void {
  for (let i = 1; i < jobs.length; i++) {
    for (let j = i; j > 0 && compareJobs(jobs[j]!, jobs[j - 1]!) < 0; j--) {
      [jobs[j], jobs[j - 1]] = [jobs[j - 1]!, jobs[j]!];
    }
  }
}

function cronsList(e: RequestEvent): HandlerResult {
  const jobs = e.app.cron.jobs();

  sortJobs(jobs);

  return e.json(200, jobs);
}

function cronRun(e: RequestEvent): HandlerResult {
  const cronId = e.request.pathValue("id");

  const foundJob = e.app.cron.jobs().find((j) => j.id === cronId);
  if (foundJob === undefined) {
    return e.notFoundError("Missing or invalid cron job", null);
  }

  e.app.cron.fireAndForget(foundJob);

  return e.noContent(204);
}

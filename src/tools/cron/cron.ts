// Upstream: tools/cron/cron.go, tools/cron/job.go
//
// The job registry of Cron: Add, Remove and Jobs. The ticker (Start, Stop,
// runDue), the timezone and the rest of the jobs API are M5.6, which runs
// what is registered here.

import { newSchedule, type Schedule } from "@/tools/cron/schedule";

// Job defines a single registered cron job.
export class Job {
  constructor(
    readonly id: string,
    readonly schedule: Schedule,
    private readonly fn: () => void,
  ) {}

  // Run runs the cron job function.
  run(): void {
    this.fn();
  }
}

// Cron is a crontab-like struct for tasks/jobs scheduling.
export class Cron {
  #jobs: Job[] = [];

  // Add registers a single cron job.
  //
  // If there is already a job with the provided id, then the old job
  // will be replaced with the new one.
  //
  // cronExpr is a regular cron expression, eg. "0 */3 * * *" (aka. at minute 0 past every 3rd hour).
  // Throws the expression's parse error.
  add(jobId: string, cronExpr: string, fn: () => void): void {
    const schedule = newSchedule(cronExpr);

    // remove previous (if any)
    this.remove(jobId);

    // add new
    this.#jobs.push(new Job(jobId, schedule, fn));
  }

  // Remove removes a single cron job by its id.
  remove(jobId: string): void {
    this.#jobs = this.#jobs.filter((j) => j.id !== jobId);
  }

  // Jobs returns a shallow copy of the currently registered cron jobs.
  jobs(): Job[] {
    return [...this.#jobs];
  }
}

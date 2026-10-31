// Upstream: tools/cron/cron.go, tools/cron/job.go, the FireAndForget of
// tools/routine/routine.go
//
// Package cron implements a crontab-like service to execute and schedule
// repeative tasks/jobs.
//
// The ticker re-arms one timer on the app clock instead of Go's time.Ticker:
// JS intervals drift, and a tick that slips past a minute skips that minute's
// jobs. As Go's, it keeps to whole intervals from the first tick and drops
// the ticks it missed. A job is a function that may return a promise.
// fireAndForget keeps the running jobs so that clearBootstrap can wait for
// them before the databases close (upstream's process just exits); the
// locks have no counterpart, JS runs each of these calls to its end.

import { type Clock, systemClock } from "@/app/clock";
import { newMoment, newSchedule, type Schedule } from "@/tools/cron/schedule";

export type JobFunc = () => void | Promise<void>;

// Job defines a single registered cron job.
export class Job {
  constructor(
    readonly id: string,
    readonly schedule: Schedule,
    private readonly fn: JobFunc,
  ) {}

  // Expression returns the plain cron job schedule expression.
  get expression(): string {
    return this.schedule.rawExpr;
  }

  // Run runs the cron job function.
  run(): void | Promise<void> {
    return this.fn();
  }

  // MarshalJSON: exports the current jobs data into valid JSON.
  toJSON(): { id: string; expression: string } {
    return { id: this.id, expression: this.expression };
  }
}

// the timers of the ticker; the global ones unless a test sets its own
export interface CronTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CronConfig {
  clock?: Clock;
  // receives what a job threw or rejected with (FireAndForget's recover)
  logPanic?: (cause: unknown) => void;
  timers?: CronTimers;
}

const globalTimers: CronTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Cron is a crontab-like struct for tasks/jobs scheduling.
//
// The default tick interval is 1 minute and the default timezone is UTC.
export class Cron {
  readonly #clock: Clock;
  readonly #logPanic: (cause: unknown) => void;
  readonly #timers: CronTimers;
  #timezone = "UTC";
  #interval = 60_000;
  #jobs: Job[] = [];
  // Go's startTimer: the delay until the first tick
  #startTimer: unknown;
  // Go's ticker: set from the first tick until Stop
  #tickTimer: unknown;
  // the jobs started by fireAndForget that have not finished
  readonly #running = new Set<Promise<void>>();

  constructor(config: CronConfig = {}) {
    this.#clock = config.clock ?? systemClock();
    this.#logPanic = config.logPanic ?? (() => {});
    this.#timers = config.timers ?? globalTimers;
  }

  // SetInterval changes the current cron tick interval, in milliseconds
  // (it usually should be >= 1 minute).
  setInterval(ms: number): void {
    // update interval
    const wasStarted = this.hasStarted();
    this.#interval = ms;

    // restart the ticker
    if (wasStarted) {
      this.start();
    }
  }

  // SetTimezone changes the current cron tick timezone (an IANA name).
  setTimezone(timezone: string): void {
    this.#timezone = timezone;
  }

  // Add registers a single cron job.
  //
  // If there is already a job with the provided id, then the old job
  // will be replaced with the new one.
  //
  // cronExpr is a regular cron expression, eg. "0 */3 * * *" (aka. at minute 0 past every 3rd hour).
  // Check newSchedule for the supported tokens. Throws the expression's
  // parse error.
  add(jobId: string, cronExpr: string, fn: JobFunc): void {
    let schedule: Schedule;
    try {
      schedule = newSchedule(cronExpr);
    } catch (err) {
      throw new Error(`failed to add new cron job: ${(err as Error).message}`, { cause: err });
    }

    // remove previous (if any)
    this.remove(jobId);

    // add new
    this.#jobs.push(new Job(jobId, schedule, fn));
  }

  // Remove removes a single cron job by its id.
  remove(jobId: string): void {
    this.#jobs = this.#jobs.filter((j) => j.id !== jobId);
  }

  // RemoveAll removes all registered cron jobs.
  removeAll(): void {
    this.#jobs = [];
  }

  // Total returns the current total number of registered cron jobs.
  total(): number {
    return this.#jobs.length;
  }

  // Jobs returns a shallow copy of the currently registered cron jobs.
  jobs(): Job[] {
    return [...this.#jobs];
  }

  // Stop stops the current cron ticker (if not already).
  //
  // You can resume the ticker by calling Start().
  stop(): void {
    if (this.#startTimer !== undefined) {
      this.#timers.clearTimeout(this.#startTimer);
      this.#startTimer = undefined;
    }

    if (this.#tickTimer !== undefined) {
      this.#timers.clearTimeout(this.#tickTimer);
      this.#tickTimer = undefined;
    }
  }

  // Start starts the cron ticker.
  //
  // Calling Start() on already started cron will restart the ticker.
  start(): void {
    this.stop();

    // delay the ticker to start at 00 of 1 c.interval duration
    const now = this.#clock.now().getTime();
    const next = this.#nextTick(now);

    this.#startTimer = this.#timers.setTimeout(() => {
      this.#startTimer = undefined;
      this.#tick(next);
    }, next - now);
  }

  // HasStarted checks whether the current Cron ticker has been started.
  hasStarted(): boolean {
    return this.#tickTimer !== undefined;
  }

  // now.Add(interval).Truncate(interval) (Go truncates from year 1, which
  // gives the same instants for whole minutes)
  #nextTick(now: number): number {
    const next = now + this.#interval;
    return next - (next % this.#interval);
  }

  #tick(scheduled: number): void {
    // a timer can fire just before its time on the wall clock; the tick
    // still belongs to the time it was set for
    const now = this.#clock.now().getTime();
    const t = Math.max(now, scheduled);
    const next = this.#nextTick(t);

    this.#tickTimer = this.#timers.setTimeout(() => this.#tick(next), next - now);

    this.runDue(new Date(t));
  }

  // runDue runs all registered jobs that are scheduled for the provided time.
  runDue(t: Date): void {
    const moment = newMoment(t, this.#timezone);

    for (const j of this.#jobs) {
      if (j.schedule.isDue(moment)) {
        this.fireAndForget(j);
      }
    }
  }

  // FireAndForget runs the job off the caller's tick or request. What it
  // throws or rejects with goes to logPanic. The same job may overlap itself.
  fireAndForget(job: Job): void {
    const running = new Promise<void>((resolve) => {
      setImmediate(resolve);
    })
      .then(() => job.run())
      .catch((err: unknown) => {
        this.#logPanic(err);
      })
      .finally(() => {
        this.#running.delete(running);
      });
    this.#running.add(running);
  }

  // Resolves once the jobs running now have finished, or after timeoutMs
  // with the ones that have not: they then fail on their own, into the log.
  async waitForRunning(timeoutMs: number): Promise<void> {
    if (this.#running.size === 0) {
      return;
    }

    let timer: unknown;
    const timeout = new Promise<void>((resolve) => {
      timer = this.#timers.setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.all(this.#running), timeout]);
    this.#timers.clearTimeout(timer);
  }
}

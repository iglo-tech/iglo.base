// Upstream: apis/middlewares_rate_limit.go (rateLimit, checkRateLimit,
// rateLimiter, rateClient)
//
// rateLimit is a placeholder: it holds the middleware's id and priority in
// the default chain and only calls the next handler. The middleware, the
// settings rules (checkCollectionRateLimit, skipRateLimit), the hourly
// cleanup cron of the limiters and their reset on settings reload are
// ported in M4.8 (rate limiter, after M1.3's settings).
//
// checkRateLimit and the fixed window limiters are here already, because
// recordsList's timing throttle (apis/record_crud.go) uses them with a
// built-in rule. The windows read the app clock where upstream reads
// time.Now().

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import type { ApiError } from "@/server/error";
import type { Handler } from "@/server/handler";
import { Store } from "@/tools/store/store";
import {
  DefaultRateLimitMiddlewareId,
  DefaultRateLimitMiddlewarePriority,
} from "@/middlewares/middlewares";

const rateLimitersStoreKey = "__pbRateLimiters__";

// core.RateLimitRuleAudience* (core/settings_model.go)
export const RateLimitRuleAudienceAll = "";
export const RateLimitRuleAudienceGuest = "@guest";
export const RateLimitRuleAudienceAuth = "@auth";

// the fields of core.RateLimitRule that checkRateLimit reads (the
// settings model comes with M1.3)
export interface RateLimitRule {
  label: string;
  audience: string;
  // in seconds
  duration: number;
  maxRequests: number;
}

export function rateLimit(): Handler<RequestEvent> {
  return {
    id: DefaultRateLimitMiddlewareId,
    priority: DefaultRateLimitMiddlewarePriority,
    func: (e) => e.next(),
  };
}

// checkRateLimit consumes one request of the rtId limiter for the client's
// real IP and returns a 429 error once the rule's allowance is exhausted.
export function checkRateLimit(
  e: RequestEvent,
  rtId: string,
  rule: RateLimitRule,
): ApiError | undefined {
  switch (rule.audience) {
    case RateLimitRuleAudienceAll:
      // valid for both guest and regular users
      break;
    case RateLimitRuleAudienceGuest:
      if (e.auth !== undefined) {
        return undefined;
      }
      break;
    case RateLimitRuleAudienceAuth:
      if (e.auth === undefined) {
        return undefined;
      }
      break;
  }

  const rateLimiters = e.app.store.getOrSet(rateLimitersStoreKey, () =>
    initRateLimitersStore(),
  ) as Store<string, RateLimiter>;

  const rt = rateLimiters.getOrSet(
    rtId,
    () => new RateLimiter(e.app, rule.maxRequests, rule.duration, 1800),
  );

  const key = e.realIP();
  if (key === "") {
    return undefined;
  }

  if (!rt.isAllowed(key)) {
    return e.tooManyRequestsError(
      "",
      new Error("triggered rate limit rule: " + JSON.stringify(rule)),
    );
  }

  return undefined;
}

function initRateLimitersStore(): Store<string, RateLimiter> {
  // the cleanup cron and the settings reload reset come with M4.8
  return new Store<string, RateLimiter>();
}

function nowUnix(app: App): number {
  return Math.floor(app.clock.now().getTime() / 1000);
}

class RateLimiter {
  readonly clients = new Map<string, RateClient>();

  constructor(
    private readonly app: App,
    readonly maxAllowed: number,
    readonly interval: number,
    readonly minDeleteInterval: number,
  ) {}

  isAllowed(key: string): boolean {
    let client = this.clients.get(key);
    if (client === undefined) {
      client = new RateClient(this.app, this.maxAllowed, this.interval);
      this.clients.set(key, client);
    }

    return client.consume();
  }
}

// rateClient implements fixed window rate limit strategy.
class RateClient {
  available = 0; // the total available tokens
  start = 0; // the start time of the current window

  constructor(
    private readonly app: App,
    readonly maxAllowed: number, // the max allowed tokens per interval
    readonly interval: number, // in seconds
  ) {}

  // consume decreases the current allowance with 1 (if not exhausted already).
  //
  // It returns false if the allowance has been already exhausted and the user
  // has to wait until it resets back to its maxAllowed value.
  consume(): boolean {
    const now = nowUnix(this.app);

    // reset
    if (now - this.start >= this.interval) {
      this.available = this.maxAllowed;
      this.start = now;
    }

    if (this.available > 0) {
      this.available--;
      return true;
    }

    return false;
  }
}

// Upstream: apis/middlewares_rate_limit.go (rateLimit, collectionPathRateLimit,
// checkCollectionRateLimit, checkRateLimit, skipRateLimit, the limiters and
// their cleanup and reset)
//
// isIPInList is in superuser-ips-whitelist.ts, with the middleware that came
// first. The windows and the cleanup read the app clock where upstream reads
// time.Now(). JS runs a request's check without interleaving, so the limiters
// have no locks.
//
// The hourly cleanup is registered on the app's cron as upstream's is. The
// settings reload does not need a hook: settingsReloaded
// (src/settings/settings-query.ts) calls destroyRateLimitersStore, which does
// nothing before the first limiter.

import type { App } from "@/app/app";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import type { RequestEvent } from "@/app/event-request";
import type { ApiError } from "@/server/error";
import type { Handler } from "@/server/handler";
import type { Collection } from "@/collections/collection-model";
import {
  DefaultRateLimitMiddlewareId,
  DefaultRateLimitMiddlewarePriority,
} from "@/middlewares/middlewares";
import { isIPInList } from "@/middlewares/superuser-ips-whitelist";
import {
  findRateLimitRule,
  marshalRateLimitRule,
  type RateLimitRule,
  RateLimitRuleAudienceAll,
  RateLimitRuleAudienceAuth,
  RateLimitRuleAudienceGuest,
} from "@/settings/settings-model";
import type { Cron } from "@/tools/cron/cron";
import { Store } from "@/tools/store/store";

const rateLimitersStoreKey = "__pbRateLimiters__";
const rateLimitersCronKey = "__pbRateLimitersCleanup__";

// The app members the limiters' store, reset and cleanup use (the cron is
// absent where a pb_data is opened without a server, test tools).
export type RateLimitersApp = Pick<App, "store"> & { readonly cron?: Cron };

// rateLimit defines the global rate limit middleware.
//
// This middleware is registered by default for all routes.
export function rateLimit(): Handler<RequestEvent> {
  return {
    id: DefaultRateLimitMiddlewareId,
    priority: DefaultRateLimitMiddlewarePriority,
    func: (e) => {
      if (skipRateLimit(e)) {
        return e.next();
      }

      const [rule, ok] = findRateLimitRule(
        e.app.settings.RateLimits,
        defaultRateLimitLabels(e),
        ...defaultRateLimitAudience(e),
      );
      if (ok) {
        const err = checkRateLimit(e, rule.Label + rule.Audience, rule);
        if (err !== undefined) {
          return err;
        }
      }

      return e.next();
    },
  };
}

// collectionPathRateLimit defines a rate limit middleware for the internal collection handlers
// (it replaces the default rate limit middleware of the route, having the same id).
export function collectionPathRateLimit(
  collectionPathParam: string,
  ...baseTags: string[]
): Handler<RequestEvent> {
  if (collectionPathParam === "") {
    collectionPathParam = "collection";
  }

  return {
    id: DefaultRateLimitMiddlewareId,
    priority: DefaultRateLimitMiddlewarePriority,
    func: (e) => {
      let collection: Collection;
      try {
        collection = findCachedCollectionByNameOrId(
          e.app,
          e.request.pathValue(collectionPathParam),
        );
      } catch (err) {
        return e.notFoundError("Missing or invalid collection context.", err);
      }

      const err = checkCollectionRateLimit(e, collection, ...baseTags);
      if (err !== undefined) {
        return err;
      }

      return e.next();
    },
  };
}

// checkCollectionRateLimit checks whether the current request satisfy the
// rate limit configuration for the specific collection.
//
// Each baseTags entry will be prefixed with the collection name and its wildcard variant.
export function checkCollectionRateLimit(
  e: RequestEvent,
  collection: Collection,
  ...baseTags: string[]
): ApiError | undefined {
  if (skipRateLimit(e)) {
    return undefined;
  }

  const labels: string[] = [];

  let rtId = collection.id + e.request.pattern;

  // add first the primary labels (aka. ["collectionName:action1", "collectionName:action2"])
  for (const baseTag of baseTags) {
    rtId += baseTag;
    labels.push(collection.name + ":" + baseTag);
  }

  // add the wildcard labels (aka. [..., "*:action1","*:action2", "*"])
  for (const baseTag of baseTags) {
    labels.push("*:" + baseTag);
  }
  labels.push(...defaultRateLimitLabels(e));

  const [rule, ok] = findRateLimitRule(
    e.app.settings.RateLimits,
    labels,
    ...defaultRateLimitAudience(e),
  );
  if (ok) {
    return checkRateLimit(e, rtId + rule.Audience, rule);
  }

  return undefined;
}

// checkRateLimit consumes one request of the rtId limiter for the client's
// real IP and returns a 429 error once the rule's allowance is exhausted.
//
// The empty key is one of upstream's Warn logs, which M5.5's logger takes.
export function checkRateLimit(
  e: RequestEvent,
  rtId: string,
  rule: RateLimitRule,
): ApiError | undefined {
  switch (rule.Audience) {
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
    initRateLimitersStore(e.app),
  ) as Store<string, RateLimiter>;

  const rt = rateLimiters.getOrSet(
    rtId,
    () => new RateLimiter(e.app, Number(rule.MaxRequests), Number(rule.Duration), 1800),
  );

  const key = e.realIP();
  if (key === "") {
    return undefined;
  }

  if (!rt.isAllowed(key)) {
    return e.tooManyRequestsError(
      "",
      new Error("triggered rate limit rule: " + marshalRateLimitRule(rule)),
    );
  }

  return undefined;
}

function skipRateLimit(e: RequestEvent): boolean {
  const { Enabled, ExcludedIPs } = e.app.settings.RateLimits;
  return !Enabled || e.hasSuperuserAuth() || isIPInList(ExcludedIPs ?? [], e.realIP());
}

const defaultAuthAudience = [RateLimitRuleAudienceAll, RateLimitRuleAudienceAuth];
const defaultGuestAudience = [RateLimitRuleAudienceAll, RateLimitRuleAudienceGuest];

function defaultRateLimitAudience(e: RequestEvent): string[] {
  if (e.auth !== undefined) {
    return defaultAuthAudience;
  }

  return defaultGuestAudience;
}

function defaultRateLimitLabels(e: RequestEvent): string[] {
  return [e.request.method + " " + e.request.path, e.request.path];
}

// destroyRateLimitersStore is what the settings reload does: the rules may
// have changed, so every limiter and its cleanup job go, until the next
// checked request creates them again.
export function destroyRateLimitersStore(app: RateLimitersApp): void {
  app.cron?.remove(rateLimitersCronKey);
  app.store.remove(rateLimitersStoreKey);
}

function initRateLimitersStore(app: App): Store<string, RateLimiter> {
  app.cron?.add(rateLimitersCronKey, "2 * * * *", () => {
    // offset a little since too many cleanup tasks execute at 00
    const limitersStore = app.store.get(rateLimitersStoreKey) as
      | Store<string, RateLimiter>
      | undefined;
    if (limitersStore === undefined) {
      return;
    }
    for (const limiter of limitersStore.getAll().values()) {
      limiter.clean();
    }
  });

  return new Store<string, RateLimiter>();
}

function nowUnix(app: App): number {
  return Math.floor(app.clock.now().getTime() / 1000);
}

class RateLimiter {
  clients = new Map<string, RateClient>();
  totalDeleted = 0;

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

  clean(): void {
    const now = nowUnix(this.app);

    for (const [k, client] of this.clients) {
      if (client.hasExpired(now, this.minDeleteInterval)) {
        this.clients.delete(k);
        this.totalDeleted++;
      }
    }

    // "shrink" the map if too may items were deleted
    if (this.totalDeleted >= 300) {
      this.clients = new Map(this.clients);
      this.totalDeleted = 0;
    }
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

  // hasExpired checks whether it has been at least minElapsed seconds after the last active window.
  // (usually used to perform periodic cleanup of staled instances).
  hasExpired(relativeNow: number, minElapsed: number): boolean {
    return relativeNow - (this.start + this.interval) > minElapsed;
  }

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

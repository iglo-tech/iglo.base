// Upstream: apis/middlewares.go, apis/middlewares_rate_limit.go and
// apis/middlewares_body_limit.go (the default middleware ids and priorities).
//
// The ids and priorities order the internal middleware chain; they are not
// an extension point.

export const DefaultRateLimitMiddlewareId = "pbRateLimit";
export const DefaultRateLimitMiddlewarePriority = -1000;

export const DefaultActivityLoggerMiddlewareId = "pbActivityLogger";
export const DefaultActivityLoggerMiddlewarePriority = DefaultRateLimitMiddlewarePriority - 40;

export const DefaultPanicRecoverMiddlewareId = "pbPanicRecover";
export const DefaultPanicRecoverMiddlewarePriority = DefaultRateLimitMiddlewarePriority - 30;

export const DefaultLoadAuthTokenMiddlewareId = "pbLoadAuthToken";
export const DefaultLoadAuthTokenMiddlewarePriority = DefaultRateLimitMiddlewarePriority - 20;

export const DefaultSuperuserIPsWhitelistMiddlewareId = "pbSuperuserIPsWhitelist";
export const DefaultSuperuserIPsWhitelistMiddlewarePriority =
  DefaultLoadAuthTokenMiddlewarePriority + 5;

export const DefaultSecurityHeadersMiddlewareId = "pbSecurityHeaders";
export const DefaultSecurityHeadersMiddlewarePriority = DefaultRateLimitMiddlewarePriority - 10;

export const DefaultBodyLimitMiddlewareId = "pbBodyLimit";
export const DefaultBodyLimitMiddlewarePriority = DefaultRateLimitMiddlewarePriority + 10;

// DefaultMaxBodySize: 32mb
export const DefaultMaxBodySize = 32 << 20;

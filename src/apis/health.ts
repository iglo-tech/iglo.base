// Upstream: apis/health.go
//
// Only the guest response is ported. The superuser response (canBackup,
// realIP, possibleProxyHeader in "data") needs auth and lands in M2.3.

// healthCheck returns a 200 OK response if the server is healthy.
export function healthCheck(): Response {
  // same key order as upstream's struct: message, code, data
  const body = JSON.stringify({ message: "API is healthy.", code: 200, data: {} });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

// docs/design/13-ssr.md ("Response headers"). A response with immutable headers, as a fetch()
// response is in Node (the runtime the SSR apps run on). Bun's fetch() and Response.redirect()
// headers are mutable, so the adapter tests build this response to reach the copy path.

class ImmutableHeaders extends Headers {
  override set(): void {
    throw new TypeError("Headers are immutable");
  }

  override append(): void {
    throw new TypeError("Headers are immutable");
  }

  override delete(): void {
    throw new TypeError("Headers are immutable");
  }
}

/** The same response, with headers that refuse every change. */
export function immutableResponse(response: Response): Response {
  Object.defineProperty(response, "headers", { value: new ImmutableHeaders(response.headers) });
  return response;
}

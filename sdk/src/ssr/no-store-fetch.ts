// docs/design/13-ssr.md ("Clients")
export type FetchFunction = (url: RequestInfo | URL, config?: RequestInit) => Promise<Response>;

/**
 * Wraps the fetch that sends a server client's requests. It runs after `beforeSend`, so an
 * app that replaces the send options cannot drop `cache: "no-store"` (Next.js would cache
 * the response in its data cache otherwise).
 */
export function noStoreFetch(
  inner: FetchFunction | undefined,
  onResponse?: (response: Response) => void,
): FetchFunction {
  return async (url, config) => {
    const response = await (inner ?? globalThis.fetch)(url, { ...config, cache: "no-store" });
    onResponse?.(response);
    return response;
  };
}

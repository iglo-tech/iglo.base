// js-sdk v0.28.1 tests/mocks.ts
import { ClientResponseError } from "@sdk/ClientResponseError";

export type RequestMock = {
  method?: string;
  url?: string;
  body?: { [key: string]: any };
  additionalMatcher?: (
    url: RequestInfo | URL,
    config: RequestInit | { [key: string]: any } | undefined,
  ) => boolean;
  delay?: number;
  replyCode?: number;
  replyHeaders?: Record<string, string> | Headers | (() => Record<string, string> | Headers);
  replyBody?: any;
};

export function dummyJWT(payload = {}) {
  const buf = Buffer.from(JSON.stringify(payload));
  return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + buf.toString("base64") + ".test";
}

export class FetchMock {
  private originalFetch?: Function;
  private mocks: Array<RequestMock> = [];

  on(request: RequestMock) {
    this.mocks.push(request);
  }

  /**
   * Initializes the mock by temporary overwriting `global.fetch`.
   */
  init() {
    this.originalFetch = global?.fetch;

    global.fetch = ((
      url: RequestInfo | URL,
      config: RequestInit | { [key: string]: any } | undefined,
    ) => {
      for (let mock of this.mocks) {
        // match url and method
        const matchUrl =
          mock.url === url ||
          (typeof mock.url === "string" &&
            typeof url === "string" &&
            url.startsWith(mock.url + "?"));
        if (!matchUrl || config?.method !== mock.method) {
          continue;
        }

        // match body params
        if (mock.body) {
          let configBody: { [key: string]: any } = {};

          // deserialize
          if (typeof config?.body === "string") {
            configBody = JSON.parse(config?.body) as { [key: string]: any };
          }

          let hasMissingBodyParam = false;
          for (const key in mock.body) {
            if (
              typeof configBody[key] === "undefined" ||
              JSON.stringify(configBody[key]) != JSON.stringify(mock.body[key])
            ) {
              hasMissingBodyParam = true;
              break;
            }
          }
          if (hasMissingBodyParam) {
            continue;
          }
        }

        if (mock.additionalMatcher && !mock.additionalMatcher(url, config)) {
          continue;
        }

        const headersInit =
          typeof mock.replyHeaders === "function" ? mock.replyHeaders() : mock.replyHeaders;
        const headers =
          headersInit instanceof Headers ? headersInit : new Headers(headersInit || {});
        if (!headers.has("date")) {
          headers.set("date", new Date().toUTCString());
        }

        const response = {
          url: url,
          status: mock.replyCode,
          statusText: "test",
          headers: headers,
          json: async () => {
            if (typeof mock.replyBody == "function") {
              return mock.replyBody();
            }

            return mock.replyBody || {};
          },
        } as Response;

        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (config?.signal?.aborted) {
              reject(new ClientResponseError());
            }
            resolve(response);
          }, mock.delay || 0);
        });
      }

      throw new Error("Request not mocked: " + url);
    }) as typeof fetch;
  }

  /**
   * Restore the original node fetch function.
   */
  restore() {
    (global.fetch as any) = this.originalFetch;
  }

  /**
   * Clears all registered mocks.
   */
  clearMocks() {
    this.mocks = [];
  }
}

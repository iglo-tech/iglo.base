// Upstream: tools/router/router.go (Router, BuildMux, ErrorHandler and the
// ResponseWriter write/status tracking), with the response side of Go's
// net/http server: buffered writes, Flush, http.Redirect and http.Error for
// the mux's own redirect, 404 and 405 responses.

import { newNotFoundError, statusText, toApiError } from "@/server/error";
import { Chain, type HandlerFunc, type Resolver } from "@/server/handler";
import { RouterGroup } from "@/server/group";
import { ServeMux, cleanSlashPath } from "@/server/mux";
import type { HttpRequest } from "@/server/request";
import { Route } from "@/server/route";

const encoder = new TextEncoder();

// statuses whose responses have no body (net/http bodyAllowedForStatus)
function bodyAllowedForStatus(status: number): boolean {
  return !((status >= 100 && status <= 199) || status === 204 || status === 304);
}

export const ErrBodyNotAllowed = new Error(
  "http: request method or response status code does not allow body",
);

// ResponseWriter collects a handler's response and tracks its write state.
//
// The status line and headers are sent with the first flush, or with the
// buffered body once the handler returns. Headers changed after
// writeHeader are not sent, as in Go.
export class ResponseWriter {
  readonly header = new Headers();

  #written = false;
  #status = 0;
  #sentHeader: Headers | undefined;
  #chunks: Uint8Array[] = [];
  // a body set by writeBody, sent as it is
  #body: Blob | ReadableStream<Uint8Array> | Promise<Blob> | null = null;
  // run once the response has been handed to the server
  #afterResponse: (() => void)[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #committed = false;
  readonly #onCommit: ((response: Response) => void) | undefined;

  // onCommit receives the streaming response at the first flush
  constructor(onCommit?: (response: Response) => void) {
    this.#onCommit = onCommit;
  }

  writeHeader(status: number): void {
    if (this.#written) {
      return;
    }
    this.#written = true;
    this.#status = status;
    this.#sentHeader = new Headers(this.header);
  }

  write(data: Uint8Array | string): Error | undefined {
    if (!this.#written) {
      this.writeHeader(200);
    }
    if (!bodyAllowedForStatus(this.#sentStatus())) {
      return ErrBodyNotAllowed;
    }
    if (this.#body !== null) {
      return new Error("write after writeBody");
    }
    const bytes = typeof data === "string" ? encoder.encode(data) : data.slice();
    if (bytes.length === 0) {
      return undefined;
    }
    if (this.#controller) {
      try {
        this.#controller.enqueue(bytes);
      } catch (err) {
        // the client went away
        return err instanceof Error ? err : new Error(String(err));
      }
    } else {
      this.#chunks.push(bytes);
    }
    return undefined;
  }

  // Sets the whole response body to a Blob (e.g. a stored file) or a
  // stream, which is sent to the client as it reads it, once the handler
  // returns, instead of being read into memory. A promised Blob is awaited
  // before the response is sent. Only valid before anything else is
  // written or flushed.
  writeBody(body: Blob | ReadableStream<Uint8Array> | Promise<Blob>): Error | undefined {
    if (!this.#written) {
      this.writeHeader(200);
    }
    if (!bodyAllowedForStatus(this.#sentStatus())) {
      return ErrBodyNotAllowed;
    }
    if (this.#committed || this.#chunks.length > 0 || this.#body !== null) {
      return new Error("writeBody after other body writes");
    }
    if (!(body instanceof Blob) || body.size > 0) {
      this.#body = body;
    }
    return undefined;
  }

  // Runs fn after the response is handed to the server (Bun opens a file
  // body then), whether or not it is sent, e.g. to remove a temporary file
  // the body reads.
  afterResponse(fn: () => void): void {
    this.#afterResponse.push(fn);
  }

  // Written reports whether the current response has been already written.
  written(): boolean {
    return this.#written;
  }

  // Status reports the written response status code (0 if not written).
  status(): number {
    return this.#status;
  }

  // Flush sends the status line, headers and buffered body to the client;
  // later writes are streamed.
  flush(): Error | undefined {
    if (!this.#onCommit) {
      return new Error("feature not supported");
    }
    if (!this.#written) {
      // the status is sent as 200 but not tracked, as in Go
      this.#written = true;
      this.#sentHeader = new Headers(this.header);
    }
    if (!this.#committed) {
      this.#committed = true;
      const chunks = this.#chunks;
      this.#chunks = [];
      const body = bodyAllowedForStatus(this.#sentStatus())
        ? new ReadableStream<Uint8Array>({
            start: (controller) => {
              this.#controller = controller;
              for (const chunk of chunks) {
                controller.enqueue(chunk);
              }
            },
          })
        : null;
      this.#onCommit(this.#response(body));
    }
    return undefined;
  }

  #sentStatus(): number {
    return this.#status === 0 ? 200 : this.#status;
  }

  #response(body: ReadableStream<Uint8Array> | Blob | null): Response {
    return new Response(body, {
      status: this.#sentStatus(),
      headers: this.#sentHeader ?? this.header,
    });
  }

  // Ends the response after the handler returned: closes a flushed stream
  // and returns undefined, or returns the buffered response (a promise when
  // the body is a promised Blob).
  finish(): Response | Promise<Response> | undefined {
    let response: Response | Promise<Response> | undefined;
    try {
      response = this.#finish();
    } finally {
      this.#runAfterResponse(response);
    }
    return response;
  }

  #finish(): Response | Promise<Response> | undefined {
    if (this.#committed) {
      try {
        this.#controller?.close();
      } catch {
        // the client went away
      }
      return undefined;
    }
    if (!this.#written) {
      this.writeHeader(200);
    }
    const allowed = bodyAllowedForStatus(this.#sentStatus());
    const body = this.#body ?? (this.#chunks.length === 0 ? null : new Blob(this.#chunks));
    if (body instanceof Promise) {
      return body.then((blob) => this.#response(allowed ? blob : null));
    }
    return this.#response(allowed ? body : null);
  }

  // the afterResponse functions, after the response (or its failure) has
  // reached the server: a timer runs after the promise jobs in which Bun
  // takes the response
  #runAfterResponse(response: Response | Promise<Response> | undefined): void {
    const run = (): void => {
      if (this.#afterResponse.length === 0) {
        return;
      }
      setTimeout(() => {
        for (const fn of this.#afterResponse.splice(0)) {
          try {
            fn();
          } catch {
            // a cleanup failure does not change the response
          }
        }
      }, 0);
    };
    Promise.resolve(response).then(run, run);
  }

  // The buffered body so far (for tests).
  bodyText(): string {
    return new TextDecoder().decode(new Uint8Array(this.#chunks.flatMap((chunk) => [...chunk])));
  }

  // The headers as sent with the status (for tests).
  sentHeader(): Headers {
    return this.#sentHeader ?? this.header;
  }
}

// ErrorHandler writes err as an ApiError JSON response unless a response was
// already written.
export function errorHandler(resp: ResponseWriter, req: HttpRequest, err: Error | undefined): void {
  if (!err) {
    return;
  }

  if (resp.written()) {
    return; // a response was already written (aka. already handled)
  }

  const header = resp.header;
  if (!header.get("Content-Type")) {
    header.set("Content-Type", "application/json");
  }

  const apiErr = toApiError(err);

  resp.writeHeader(apiErr.status);

  if (req.method !== "HEAD") {
    // note: deterministic because some logs may depend on the exact serialized error
    resp.write(JSON.stringify(apiErr));
  }
}

const htmlReplacements: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&#34;",
  "'": "&#39;",
};

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => htmlReplacements[c] as string);
}

function hexEscapeNonASCII(s: string): string {
  let out = "";
  for (const byte of encoder.encode(s)) {
    out += byte >= 0x80 ? `%${byte.toString(16).padStart(2, "0")}` : String.fromCharCode(byte);
  }
  return out;
}

// http.Redirect to a path-only url (the mux's redirects).
export function redirect(w: ResponseWriter, r: HttpRequest, url: string, code: number): void {
  let query = "";
  const q = url.indexOf("?");
  if (q !== -1) {
    query = url.slice(q);
    url = url.slice(0, q);
  }
  // clean up but preserve trailing slash
  const trailing = url.endsWith("/");
  url = cleanSlashPath(url);
  if (trailing && !url.endsWith("/")) {
    url += "/";
  }
  url += query;

  // RFC 7231 notes that a short HTML body is usually included in
  // the response because older user agents may not understand 301/307.
  // Do it only if the request didn't already have a Content-Type header.
  const hadCT = w.header.has("Content-Type");

  w.header.set("Location", hexEscapeNonASCII(url));
  if (!hadCT && (r.method === "GET" || r.method === "HEAD")) {
    w.header.set("Content-Type", "text/html; charset=utf-8");
  }
  w.writeHeader(code);

  // Shouldn't send the body for POST or HEAD; that leaves GET.
  if (!hadCT && r.method === "GET") {
    w.write(`<a href="${htmlEscape(url)}">${statusText(code)}</a>.\n\n`);
  }
}

// http.Error replies with the plain text error message and code.
export function httpError(w: ResponseWriter, error: string, code: number): void {
  w.header.delete("Content-Length");
  w.header.set("Content-Type", "text/plain; charset=utf-8");
  w.header.set("X-Content-Type-Options", "nosniff");
  w.writeHeader(code);
  w.write(`${error}\n`);
}

type RouteHandler = (resp: ResponseWriter, req: HttpRequest) => Promise<void>;

// Mux is the built request multiplexer of a Router.
export class Mux {
  readonly #mux: ServeMux<RouteHandler>;

  constructor(mux: ServeMux<RouteHandler>) {
    this.#mux = mux;
  }

  // ServeHTTP dispatches the request to the handler whose pattern most
  // closely matches the request URL.
  async serveHTTP(w: ResponseWriter, r: HttpRequest): Promise<void> {
    const found = this.#mux.findHandler({
      method: r.method,
      host: r.host,
      escapedPath: r.escapedPath,
      rawQuery: r.rawQuery,
    });
    switch (found.kind) {
      case "redirect":
        redirect(w, r, found.url, 307);
        return;
      case "methodNotAllowed":
        w.header.set("Allow", found.allow.join(", "));
        httpError(w, "Method Not Allowed", 405);
        return;
      case "notFound":
        httpError(w, "404 page not found", 404);
        return;
      case "handler": {
        r.pattern = found.pattern.str;
        const names = found.pattern.wildcardNames();
        names.forEach((name, i) => {
          r.setPathValue(name, found.matches[i] ?? "");
        });
        await found.handler(w, r);
      }
    }
  }
}

export type EventCleanupFunc = () => void;

// EventFactoryFunc creates the route event for a request. Optionally it
// returns a clean up function that is invoked right after the route execution.
export type EventFactoryFunc<T> = (
  w: ResponseWriter,
  r: HttpRequest,
) => [T, EventCleanupFunc | undefined];

// Router adds routing sub-groups and middlewares on top of the ServeMux.
export class Router<T extends Resolver> extends RouterGroup<T> {
  readonly #eventFactory: EventFactoryFunc<T>;

  constructor(eventFactory: EventFactoryFunc<T>) {
    super();
    this.#eventFactory = eventFactory;
  }

  // BuildMux constructs a new mux instance from the current router
  // configurations. It throws on invalid or conflicting patterns.
  buildMux(): Mux {
    // a custom "catch-all" route so that the group middlewares are executed
    // also for requests that match no route
    if (!this.hasRoute("", "/")) {
      this.route("", "/", () => newCatchAllNotFoundError());
    }

    const mux = new ServeMux<RouteHandler>();

    this.#loadMux(mux, this, []);

    return new Mux(mux);
  }

  #loadMux(mux: ServeMux<RouteHandler>, group: RouterGroup<T>, parents: RouterGroup<T>[]): void {
    for (const child of group.children) {
      if (child instanceof RouterGroup) {
        this.#loadMux(mux, child, [...parents, group]);
        continue;
      }
      if (!(child instanceof Route)) {
        throw new Error("invalid Group item type");
      }

      const v = child;
      const routeHook = new Chain<T>();

      let pattern = "";

      if (v.method !== "") {
        pattern = `${v.method} `;
      }

      // add parent groups middlewares
      for (const p of parents) {
        pattern += p.prefix;
        for (const h of p.middlewares) {
          const id = h.id ?? "";
          if (
            !p.excludedMiddlewares?.has(id) &&
            !group.excludedMiddlewares?.has(id) &&
            !v.excludedMiddlewares?.has(id)
          ) {
            routeHook.bind(h);
          }
        }
      }

      // add current groups middlewares
      pattern += group.prefix;
      for (const h of group.middlewares) {
        const id = h.id ?? "";
        if (!group.excludedMiddlewares?.has(id) && !v.excludedMiddlewares?.has(id)) {
          routeHook.bind(h);
        }
      }

      // add current route middlewares
      pattern += v.path;
      for (const h of v.middlewares) {
        if (!v.excludedMiddlewares?.has(h.id ?? "")) {
          routeHook.bind(h);
        }
      }

      const action: HandlerFunc<T> = v.action;
      const eventFactory = this.#eventFactory;

      mux.handle(pattern, async (resp, req) => {
        try {
          const [event, cleanupFunc] = eventFactory(resp, req);

          // trigger the handler hook chain
          const err = await routeHook.trigger(event, action);
          if (err) {
            errorHandler(resp, req, err);
          }

          if (cleanupFunc) {
            cleanupFunc();
          }
        } finally {
          // release the request body copies (memory + temp file)
          try {
            req.body.close();
          } catch {
            // close errors are ignored, as upstream's deferred Close
          }
          // remove the multipart form's temporary file (net/http's
          // finishRequest calls MultipartForm.RemoveAll)
          try {
            req.multipartForm?.removeAll();
          } catch {
            // ignored, as net/http does
          }
        }
      });
    }
  }
}

function newCatchAllNotFoundError(): Error {
  return newNotFoundError("", undefined);
}

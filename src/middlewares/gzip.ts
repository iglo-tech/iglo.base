// Upstream: apis/middlewares_gzip.go (Gzip with the default config: level
// -1, MinLength 0).
//
// Upstream binds it only on the dashboard routes (/_/...). Their handlers
// write whole responses, so the gzip writer here buffers the body and
// compresses it when the handler returns, with the results of upstream's
// streaming writer: Content-Encoding: gzip and the compressed body once any
// body is written, the response untouched (and Content-Encoding removed)
// when none is. Flushing a gzip response is not supported (no dashboard
// handler flushes). Every dashboard handler sets Content-Type, so Go's
// http.DetectContentType fallback of the writer is not needed.

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import { ResponseWriter } from "@/server/router";

const gzipScheme = "gzip";

export const DefaultGzipMiddlewareId = "pbGzip";

class GzipResponseWriter extends ResponseWriter {
  code = 0;
  wroteHeader = false;
  wroteBody = false;
  readonly chunks: Uint8Array[] = [];

  constructor(readonly inner: ResponseWriter) {
    super();
    for (const [key, value] of inner.header) {
      this.header.append(key, value);
    }
  }

  override writeHeader(code: number): void {
    this.header.delete("Content-Length"); // Issue echo#444

    this.wroteHeader = true;

    // Delay writing of the header until we know if we'll actually compress the response
    this.code = code;
  }

  override write(data: Uint8Array | string): Error | undefined {
    this.wroteBody = true;
    this.chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
    return undefined;
  }

  // the first body write sends the (delayed) status to the inner writer
  override written(): boolean {
    return this.wroteBody;
  }

  override status(): number {
    if (!this.wroteBody) {
      return 0;
    }
    return this.wroteHeader ? this.code : 200;
  }

  override flush(): Error | undefined {
    return new Error("feature not supported");
  }

  // The deferred part of upstream's middleware: writes the status, the
  // headers and the (compressed) body to the inner writer.
  close(): void {
    const inner = this.inner;
    if (!this.wroteBody) {
      if (this.header.get("Content-Encoding") === gzipScheme) {
        this.header.delete("Content-Encoding");
      }
    } else {
      this.header.set("Content-Encoding", gzipScheme);
    }

    // copied first: deleting while iterating Headers skips entries
    for (const key of Array.from(inner.header.keys())) {
      inner.header.delete(key);
    }
    for (const [key, value] of this.header) {
      inner.header.append(key, value);
    }

    if (this.wroteHeader) {
      inner.writeHeader(this.code);
    }
    if (this.wroteBody) {
      inner.write(Bun.gzipSync(new Uint8Array(Buffer.concat(this.chunks))));
    }
  }
}

// Gzip returns a middleware which compresses HTTP response using Gzip compression scheme.
export function gzip(): Handler<RequestEvent> {
  return {
    id: DefaultGzipMiddlewareId,
    func: async (e) => {
      e.response.header.append("Vary", "Accept-Encoding");
      if (!(e.request.headers.get("Accept-Encoding") ?? "").includes(gzipScheme)) {
        return e.next();
      }

      const rw = e.response;
      const grw = new GzipResponseWriter(rw);
      e.response = grw;
      try {
        return await e.next();
      } finally {
        // We have to reset response to it's pristine state when
        // nothing is written to body or error is returned.
        // See issue echo#424, echo#407.
        e.response = rw;
        grw.close();
      }
    },
  };
}

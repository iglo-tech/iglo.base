// Upstream: apis/middlewares_body_limit.go (ErrRequestEntityTooLarge,
// BodyLimit, dynamicCollectionBodyLimit, applyBodyLimit, maxBytesReader)
//
// The limit is checked first against the request Content-Length; the body
// is then wrapped in a reader that fails with ErrRequestEntityTooLarge once
// more than the limit is read (a chunked body, or a Content-Length that
// does not match). The sizes are int64 sums, wrapping around as in Go.

import type { RequestEvent } from "@/app/event-request";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import { isMaxBodySizeCalculator } from "@/fields/field";
import {
  DefaultBodyLimitMiddlewareId,
  DefaultBodyLimitMiddlewarePriority,
  DefaultMaxBodySize,
} from "@/middlewares/middlewares";
import type { ReadCloser, ReadResult } from "@/server/buffer-with-file";
import { ApiError, newApiError } from "@/server/error";
import type { Handler } from "@/server/handler";

export const ErrRequestEntityTooLarge: ApiError = newApiError(
  413,
  "Request entity too large",
  null,
);

// BodyLimit returns a middleware handler that changes the default request body size limit.
//
// If limitBytes <= 0, no limit is applied.
//
// Otherwise, if the request body size exceeds the configured limitBytes,
// it sends 413 error response.
export function bodyLimit(limitBytes: number = DefaultMaxBodySize): Handler<RequestEvent> {
  return {
    id: DefaultBodyLimitMiddlewareId,
    priority: DefaultBodyLimitMiddlewarePriority,
    func: (e) => {
      const err = applyBodyLimit(e, BigInt(limitBytes));
      if (err) {
        return err;
      }

      return e.next();
    },
  };
}

export function dynamicCollectionBodyLimit(collectionPathParam = ""): Handler<RequestEvent> {
  if (collectionPathParam === "") {
    collectionPathParam = "collection";
  }

  return {
    id: DefaultBodyLimitMiddlewareId,
    priority: DefaultBodyLimitMiddlewarePriority,
    func: (e) => {
      let collection;
      try {
        collection = findCachedCollectionByNameOrId(
          e.app,
          e.request.pathValue(collectionPathParam),
        );
      } catch (err) {
        return e.notFoundError("Missing or invalid collection context.", err);
      }

      let limitBytes = BigInt(DefaultMaxBodySize);
      if (!collection.isView()) {
        for (const f of collection.fields) {
          if (isMaxBodySizeCalculator(f)) {
            limitBytes = BigInt.asIntN(64, limitBytes + BigInt(f.calculateMaxBodySize()));
          }
        }
      }

      const err = applyBodyLimit(e, limitBytes);
      if (err) {
        return err;
      }

      return e.next();
    },
  };
}

function applyBodyLimit(e: RequestEvent, limitBytes: bigint): ApiError | undefined {
  // no limit
  if (limitBytes <= 0n) {
    return undefined;
  }

  // optimistically check the submitted request content length
  if (BigInt(e.request.contentLength) > limitBytes) {
    return ErrRequestEntityTooLarge;
  }

  // replace the request body
  e.request.body = newMaxBytesReader(e.request.body, limitBytes);

  return undefined;
}

function newMaxBytesReader(body: ReadCloser, limitBytes: bigint): MaxBytesReader {
  return new MaxBytesReader(body, limitBytes);
}

// maxBytesReader is very similar to the http.MaxBytesReader but support
// rereads and doesn't try to prematurely close the related response
// to allow consequent middlewares to operate correctly.
//
// The wrapped body rewinds at its end (RereadableReadCloser); each read
// pass from there is counted against the limit on its own.
class MaxBytesReader implements ReadCloser {
  readonly #reader: ReadCloser;
  readonly limit: bigint;
  #remaining: bigint;
  #stickyErr: unknown = undefined;

  constructor(reader: ReadCloser, limit: bigint) {
    this.#reader = reader;
    this.limit = limit;
    this.#remaining = limit;
  }

  async read(b: Uint8Array): Promise<ReadResult> {
    if (this.#stickyErr !== undefined) {
      throw this.#stickyErr;
    }

    if (b.length === 0) {
      return { n: 0, eof: false };
    }

    // if possible no need to read the entire chunk since
    // remaining+1 is enough to determine whether it exceed the limit
    if (BigInt(b.length) - 1n > this.#remaining) {
      b = b.subarray(0, Number(this.#remaining + 1n));
    }

    let result: ReadResult;
    try {
      result = await this.#reader.read(b);
    } catch (err) {
      this.#stickyErr = err;
      throw err;
    }

    if (BigInt(result.n) <= this.#remaining) {
      this.#remaining -= BigInt(result.n);
      if (result.eof) {
        // the body rewound for the next read
        this.#remaining = this.limit;
      }
      return result;
    }

    this.#remaining = 0n;
    this.#stickyErr = ErrRequestEntityTooLarge;

    throw this.#stickyErr;
  }

  close(): void {
    this.#reader.close();
  }
}

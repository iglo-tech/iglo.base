// Upstream: tools/filesystem/blob/bucket.go and blob/reader.go, for a driver
// whose calls are asynchronous (the S3 driver)
//
// AsyncBucket makes the checks and wraps the errors as Bucket does
// (blob/bucket.ts), which stays synchronous for the local storage (D8). An
// upload takes the whole payload as a Blob, in place of upstream's Writer,
// and a reader gives the body as a stream, in place of Read and Seek (a seek
// is another NewRangeReader). Each call takes the signal that stands for Go's
// context.

import {
  ErrClosed,
  type Reader as _Reader,
  checkKey,
  checkWriterOptions,
  errEOF,
  errorsIs,
  isNotFound,
  type WriterOptions,
  wrapError,
} from "@/tools/filesystem/blob/bucket";
import type {
  AsyncDriver,
  Attributes,
  AsyncDriverReader,
  ListObject,
  ListOptions,
  ListPage,
} from "@/tools/filesystem/blob/driver";

// the streaming Reader of an AsyncBucket
export interface AsyncReader extends Pick<_Reader, "contentType" | "modTime" | "size"> {
  body: ReadableStream<Uint8Array> | null;
}

// ListIterator iterates over List results.
export class AsyncListIterator {
  readonly #b: AsyncBucket;
  readonly #opts: ListOptions;
  #page: ListPage | null = null;
  #nextIdx = 0;

  constructor(b: AsyncBucket, opts: ListOptions) {
    this.#b = b;
    this.#opts = opts;
  }

  // Next returns the next object, or null at the end (Go's io.EOF, which a
  // failed list can be too: see errEOF). Throws the list error.
  async next(): Promise<ListObject | null> {
    for (;;) {
      if (this.#page !== null) {
        if (this.#nextIdx < this.#page.objects.length) {
          const dobj = this.#page.objects[this.#nextIdx] as ListObject;
          this.#nextIdx++;
          return { ...dobj };
        }
        if (this.#page.nextPageToken === null || this.#page.nextPageToken === "") {
          return null;
        }
        this.#opts.pageToken = this.#page.nextPageToken;
      }

      this.#b.checkOpen();

      try {
        this.#page = await this.#b.drv.listPaged(this.#opts, this.#b.signal);
      } catch (err) {
        if (errorsIs(err, errEOF)) {
          return null;
        }
        throw wrapError(this.#b.drv, err, "");
      }
      this.#nextIdx = 0;
    }
  }
}

export class AsyncBucket {
  readonly drv: AsyncDriver;
  // Go's context of the System's calls
  readonly signal: AbortSignal | undefined;
  #closed = false;

  constructor(drv: AsyncDriver, signal?: AbortSignal) {
    this.drv = drv;
    this.signal = signal;
  }

  checkOpen(): void {
    if (this.#closed) {
      throw ErrClosed;
    }
  }

  list(opts: { prefix?: string; delimiter?: string } = {}): AsyncListIterator {
    return new AsyncListIterator(this, {
      prefix: opts.prefix ?? "",
      delimiter: opts.delimiter ?? "",
      pageSize: 0,
      pageToken: null,
    });
  }

  // Attributes returns attributes for the blob stored at key.
  //
  // If the blob does not exist, Attributes throws an error for which
  // isNotFound returns true.
  async attributes(key: string): Promise<Attributes> {
    checkKey("Attributes", key);

    this.checkOpen();

    let a: Attributes;
    try {
      a = await this.drv.attributes(key, this.signal);
    } catch (err) {
      throw wrapError(this.drv, err, key);
    }

    let md: Map<string, string> | null = null;
    if (a.metadata !== null && a.metadata.size > 0) {
      md = new Map();
      for (const [k, v] of a.metadata) {
        md.set(k.toLowerCase(), v);
      }
    }

    return { ...a, metadata: md };
  }

  // Exists returns true if a blob exists at key, false if it does not exist.
  // Throws any other error.
  async exists(key: string): Promise<boolean> {
    try {
      await this.attributes(key);
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  // NewRangeReader returns a reader of at most length bytes (to the end of
  // the blob when negative) from offset (>= 0).
  async newRangeReader(key: string, offset: number, length: number): Promise<AsyncReader> {
    this.checkOpen();

    if (offset < 0) {
      throw new Error(`NewRangeReader offset must be non-negative (${offset})`);
    }
    checkKey("NewRangeReader", key);

    let dr: AsyncDriverReader;
    try {
      dr = await this.drv.newRangeReader(key, offset, length, this.signal);
    } catch (err) {
      throw wrapError(this.drv, err, key);
    }

    return { ...dr.attributes(), body: dr.body };
  }

  // Uploads payload to the blob at key: upstream's NewWriter, Write and
  // Close in one call.
  async upload(key: string, payload: Blob, opts: WriterOptions): Promise<void> {
    const { contentType, metadata } = checkWriterOptions(key, opts, () => this.checkOpen());

    try {
      await this.drv.upload(key, contentType, payload, { ...opts, metadata }, this.signal);
    } catch (err) {
      throw wrapError(this.drv, err, key);
    }
  }

  // Copy the blob stored at srcKey to dstKey. A nonexistent source object
  // fails with an error for which isNotFound returns true. If the
  // destination blob already exists, it is overwritten.
  async copy(dstKey: string, srcKey: string): Promise<void> {
    checkKey("Copy srcKey", srcKey);
    checkKey("Copy dstKey", dstKey);

    this.checkOpen();

    try {
      await this.drv.copy(dstKey, srcKey, this.signal);
    } catch (err) {
      throw wrapError(this.drv, err, `${srcKey} -> ${dstKey}`);
    }
  }

  // Delete deletes the blob stored at key.
  async delete(key: string): Promise<void> {
    checkKey("Delete", key);

    this.checkOpen();

    try {
      await this.drv.delete(key, this.signal);
    } catch (err) {
      throw wrapError(this.drv, err, key);
    }
  }

  // Close releases any resources used for the bucket.
  close(): void {
    const prev = this.#closed;
    this.#closed = true;
    if (prev) {
      throw ErrClosed;
    }
    this.drv.close();
  }
}

// Upstream: tools/filesystem/internal/s3blob/s3blob.go
//
// Package s3blob provides a blob.Bucket S3 driver implementation, on the
// client in s3/. The driver's calls are asynchronous (AsyncDriver,
// blob/driver.ts): they go over the network, so they never run inside a
// database write transaction.
//
// The blob abstraction supports all UTF-8 strings; to make this work with
// services lacking full UTF-8 support, strings must be escaped (during
// writes) and unescaped (during reads). The following escapes are performed
// for s3blob:
//   - Blob keys: ASCII characters 0-31 are escaped to "__0x<hex>__".
//     Additionally, the "/" in "../" is escaped in the same way.
//   - Metadata keys: Escaped using URL encoding, then additionally "@:=" are
//     escaped using "__0x<hex>__". These characters were determined by
//     experimentation.
//   - Metadata values: Escaped using URL encoding.
//
// Not ported: the streaming writer's pipe (an upload takes a Blob, which the
// Uploader reads a part at a time) and WriterOptions.BufferSize,
// MaxConcurrency and ContentMD5, which no caller sets.

import { ErrNotFound, errorsIs, joinNotFound } from "@/tools/filesystem/blob/bucket";
import type {
  AsyncDriver,
  AsyncDriverReader,
  Attributes,
  ListOptions,
  ListObject,
  ListPage,
  WriterOptions,
} from "@/tools/filesystem/blob/driver";
import { HexEscape, HexUnescape } from "@/tools/filesystem/blob/hex";
import { copyObject } from "@/tools/filesystem/internal/s3blob/s3/copy-object";
import { deleteObject } from "@/tools/filesystem/internal/s3blob/s3/delete-object";
import { getObject } from "@/tools/filesystem/internal/s3blob/s3/get-object";
import { headObject } from "@/tools/filesystem/internal/s3blob/s3/head-object";
import { type ListParams, listObjects } from "@/tools/filesystem/internal/s3blob/s3/list-objects";
import { isResponseError, type S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";
import { Uploader } from "@/tools/filesystem/internal/s3blob/s3/uploader";
import { urlPathEscape, urlUnescape } from "@/tools/filesystem/internal/s3blob/s3/url-escape";

const defaultPageSize = 1000;

// New creates a new instance of the S3 driver backed by the internal S3
// client.
export function New(s3Client: S3): AsyncDriver {
  if (s3Client.bucket === "") {
    throw new Error("s3blob.New: missing bucket name");
  }

  if (s3Client.endpoint === "") {
    throw new Error("s3blob.New: missing endpoint");
  }

  if (s3Client.region === "") {
    throw new Error("s3blob.New: missing region");
  }

  return new driver(s3Client);
}

class driver implements AsyncDriver {
  readonly #s3: S3;

  constructor(s3: S3) {
    this.#s3 = s3;
  }

  // Close implements [blob/Driver.Close].
  close(): void {
    // nothing to close
  }

  // NormalizeError implements [blob/Driver.NormalizeError].
  normalizeError(err: unknown): unknown {
    // already normalized
    if (errorsIs(err, ErrNotFound)) {
      return err;
    }

    // normalize base on its S3 error status or code
    const ae = isResponseError(err);
    if (ae !== null) {
      if (ae.status === 404) {
        return joinNotFound(err);
      }

      switch (ae.code) {
        case "NoSuchBucket":
        case "NoSuchKey":
        case "NotFound":
          return joinNotFound(err);
      }
    }

    return err;
  }

  // ListPaged implements [blob/Driver.ListPaged].
  async listPaged(opts: ListOptions, signal?: AbortSignal): Promise<ListPage> {
    const listParams: ListParams = {
      maxKeys: opts.pageSize === 0 ? defaultPageSize : opts.pageSize,
    };
    if ((opts.pageToken ?? "") !== "") {
      listParams.continuationToken = opts.pageToken as string;
    }
    if (opts.prefix !== "") {
      listParams.prefix = escapeKey(opts.prefix);
    }
    if (opts.delimiter !== "") {
      listParams.delimiter = escapeKey(opts.delimiter);
    }

    const resp = await listObjects(this.#s3, listParams, signal);

    const objects: ListObject[] = resp.contents.map((obj) => ({
      key: unescapeKey(obj.key),
      modTime: obj.lastModified,
      size: obj.size,
      md5: eTagToMD5(obj.etag),
      isDir: false,
    }));

    for (const prefix of resp.commonPrefixes) {
      objects.push({
        key: unescapeKey(prefix),
        modTime: 0n,
        size: 0,
        md5: null,
        isDir: true,
      });
    }

    if (resp.contents.length > 0 && resp.commonPrefixes.length > 0) {
      // S3 gives us blobs and "directories" in separate lists; sort them.
      objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }

    return {
      objects,
      nextPageToken: resp.nextContinuationToken === "" ? null : resp.nextContinuationToken,
    };
  }

  // Attributes implements [blob/Driver.Attributes].
  async attributes(key: string, signal?: AbortSignal): Promise<Attributes> {
    const resp = await headObject(this.#s3, escapeKey(key), signal);

    const metadata = new Map<string, string>();
    for (const [k, v] of resp.metadata) {
      // See the package comments for more details on escaping of metadata
      // keys & values.
      metadata.set(HexUnescape(urlUnescape(k)), urlUnescape(v));
    }

    return {
      cacheControl: resp.cacheControl,
      contentDisposition: resp.contentDisposition,
      contentEncoding: resp.contentEncoding,
      contentLanguage: resp.contentLanguage,
      contentType: resp.contentType,
      metadata,
      modTime: resp.lastModified,
      size: resp.contentLength,
      md5: eTagToMD5(resp.etag),
      etag: resp.etag,
    };
  }

  // NewRangeReader implements [blob/Driver.NewRangeReader].
  async newRangeReader(
    key: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<AsyncDriverReader> {
    let byteRange = "";
    if (offset > 0 && length < 0) {
      byteRange = `bytes=${offset}-`;
    } else if (length === 0) {
      // AWS doesn't support a zero-length read; we'll read 1 byte and then
      // ignore it in favor of an empty body below.
      byteRange = `bytes=${offset}-${offset}`;
    } else if (length >= 0) {
      byteRange = `bytes=${offset}-${offset + length - 1}`;
    }

    const headers = new Headers();
    if (byteRange !== "") {
      headers.set("Range", byteRange);
    }

    const resp = await getObject(this.#s3, escapeKey(key), headers, signal);

    let body = resp.body;
    if (length === 0) {
      await body?.cancel();
      body = null;
    }

    return {
      body,
      attributes: () => ({
        contentType: resp.contentType,
        modTime: resp.lastModified,
        size: getSize(resp.contentLength, resp.contentRange),
      }),
    };
  }

  // NewTypedWriter of upstream: the upload of the whole payload.
  async upload(
    key: string,
    contentType: string,
    payload: Blob,
    opts: WriterOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const metadata = new Map<string, string>();
    for (const [k, v] of opts.metadata ?? []) {
      // See the package comments for more details on escaping of metadata
      // keys & values.
      const escaped = HexEscape(urlPathEscape(k), (runes, i) => {
        const c = runes[i];
        return c === 0x40 || c === 0x3a || c === 0x3d; // "@", ":", "="
      });
      metadata.set(escaped, urlPathEscape(v));
    }

    const headers = new Headers({ "Content-Type": contentType });
    if ((opts.cacheControl ?? "") !== "") {
      headers.set("Cache-Control", opts.cacheControl as string);
    }
    if ((opts.contentDisposition ?? "") !== "") {
      headers.set("Content-Disposition", opts.contentDisposition as string);
    }
    if ((opts.contentEncoding ?? "") !== "") {
      headers.set("Content-Encoding", opts.contentEncoding as string);
    }
    if ((opts.contentLanguage ?? "") !== "") {
      headers.set("Content-Language", opts.contentLanguage as string);
    }

    await new Uploader({
      s3: this.#s3,
      key: escapeKey(key),
      payload,
      metadata,
      headers,
      signal,
    }).upload();
  }

  // Copy implements [blob/Driver.Copy].
  async copy(dstKey: string, srcKey: string, signal?: AbortSignal): Promise<void> {
    await copyObject(this.#s3, escapeKey(srcKey), escapeKey(dstKey), signal);
  }

  // Delete implements [blob/Driver.Delete].
  async delete(key: string, signal?: AbortSignal): Promise<void> {
    await deleteObject(this.#s3, escapeKey(key), signal);
  }
}

// -------------------------------------------------------------------

// etagToMD5 processes an ETag header and returns an MD5 hash if possible.
// S3's ETag header is sometimes a quoted hexstring of the MD5. Other times,
// notably when the object was uploaded in multiple parts, it is not. We do
// the best we can.
function eTagToMD5(etag: string): Uint8Array | null {
  // Strip the expected leading and trailing quotes.
  if (etag.length < 2 || !etag.startsWith('"') || !etag.endsWith('"')) {
    return null;
  }
  const unquoted = etag.slice(1, -1);

  // Un-hex; we return null on error. In particular, we'll get an error here
  // for multi-part uploaded blobs, whose ETag will contain a "-".
  if (unquoted.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(unquoted)) {
    return null;
  }

  return new Uint8Array(Buffer.from(unquoted, "hex"));
}

function getSize(contentLength: number, contentRange: string): number {
  // Default size to ContentLength, but that's incorrect for partial-length
  // reads, where ContentLength refers to the size of the returned Body, not
  // the entire size of the blob. ContentRange has the full size.
  // Sample: bytes 10-14/27 (where 27 is the full size).
  const parts = contentRange.split("/");
  if (contentRange !== "" && parts.length === 2 && /^[+-]?\d+$/.test(parts[1] as string)) {
    return Number(parts[1]);
  }
  return contentLength;
}

// escapeKey does all required escaping for UTF-8 strings to work with S3.
function escapeKey(key: string): string {
  return HexEscape(key, (r, i) => {
    const c = r[i] as number;

    // S3 doesn't handle these characters (determined via experimentation).
    if (c < 32) {
      return true;
    }

    // For "../", escape the trailing slash.
    return i > 1 && c === 0x2f && r[i - 1] === 0x2e && r[i - 2] === 0x2e;
  });
}

// unescapeKey reverses escapeKey.
function unescapeKey(key: string): string {
  return HexUnescape(key);
}

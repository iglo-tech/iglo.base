// Upstream: tools/filesystem/blob/driver.go (the parts the local driver
// implements)
//
// The driver calls are synchronous (node:fs), so that files can be stored
// and deleted from inside a write transaction, as upstream does (D8). Go's
// context.Context arguments are left out: nothing here is cancelled
// through a context; a writer is cancelled with cancel().

// ListOptions sets options for listing blobs via Bucket.List.
export interface ListOptions {
  // Prefix indicates that only blobs with a key starting with this prefix
  // should be returned.
  prefix: string;
  // Delimiter sets the delimiter used to define a hierarchical namespace,
  // like a filesystem with "directories". "" lists every blob.
  delimiter: string;
  // PageSize sets the maximum number of objects to be returned (0 for the
  // driver's default).
  pageSize: number;
  // PageToken may be filled in with the NextPageToken from a previous
  // ListPaged call.
  pageToken: string | null;
}

// ListObject represents a single blob returned from List.
export interface ListObject {
  // Key is the key for this blob.
  key: string;
  // ModTime is the time the blob was last modified (Unix nanoseconds).
  modTime: bigint;
  // Size is the size of the blob's content in bytes.
  size: number;
  // MD5 is an MD5 hash of the blob contents or null if not available.
  md5: Uint8Array | null;
  // IsDir indicates that this result represents a "directory" in the
  // hierarchical namespace, ending in ListOptions.Delimiter.
  isDir: boolean;
}

// ListPage represents a page of results return from ListPaged.
export interface ListPage {
  objects: ListObject[];
  // the key to continue listing after, or null at the end
  nextPageToken: string | null;
}

// Attributes contains attributes about a blob.
export interface Attributes {
  cacheControl: string;
  contentDisposition: string;
  contentEncoding: string;
  contentLanguage: string;
  contentType: string;
  // Metadata holds key/value pairs associated with the blob (null for
  // none).
  metadata: Map<string, string> | null;
  // ModTime is the time the blob was last modified (Unix nanoseconds).
  modTime: bigint;
  size: number;
  md5: Uint8Array | null;
  // ETag for the blob; see https://en.wikipedia.org/wiki/HTTP_ETag.
  etag: string;
}

// ReaderAttributes contains a subset of attributes about a blob that are
// accessible from Reader.
export interface ReaderAttributes {
  contentType: string;
  modTime: bigint;
  size: number;
}

// WriterOptions sets options for the driver writer (the ones the local
// driver uses).
export interface WriterOptions {
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentType?: string;
  metadata?: Map<string, string> | null;
}

export interface DriverReader {
  // reads up to p.length bytes into p; 0 at the end
  read(p: Uint8Array): number;
  close(): void;
  attributes(): ReaderAttributes;
}

export interface DriverWriter {
  write(p: Uint8Array): void;
  // completes the write (the blob appears under its key)
  close(): void;
  // abandons the write (Go's cancelled context before Close)
  cancel(): void;
}

export interface Driver {
  // NormalizeError converts driver errors (adds ErrNotFound to a
  // not-exist error).
  normalizeError(err: unknown): unknown;
  listPaged(opts: ListOptions): ListPage;
  attributes(key: string): Attributes;
  newRangeReader(key: string, offset: number, length: number): DriverReader;
  newTypedWriter(key: string, contentType: string, opts: WriterOptions): DriverWriter;
  copy(dstKey: string, srcKey: string): void;
  delete(key: string): void;
  close(): void;
}

// Upstream: tools/filesystem/internal/s3blob/s3/uploader.go
//
// Uploader handles the upload of a single S3 object.
//
// If the payload is smaller than MinPartSize it sends a single (PutObject)
// request, otherwise it performs a chunked/multipart upload. The payload is
// a Blob (a file on disk or bytes), read one part at a time, so at most
// MaxConcurrency parts are held in memory. After a part fails no further
// part starts; upstream's other workers go on to the end of the payload
// before the same abort.
//
// Go's io.Reader payload, the optional request functions and ErrUsedUploader
// are not ported: the driver makes one Uploader per upload, and passes the
// headers its functions would set.

import { joinErrors, wrapf } from "@/tools/filesystem/blob/bucket";
import { escapeText, childText, parseRoot } from "@/tools/filesystem/internal/s3blob/s3/xml";
import { metadataPrefix, type S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";

const defaultMaxConcurrency = 5;
const defaultMinPartSize = 6 << 20;

interface MpPart {
  etag: string;
  partNumber: number;
}

export interface UploaderOptions {
  s3: S3;
  // the object content to upload
  payload: Blob;
  // the destination key of the uploaded object
  key: string;
  // the optional metadata to write with the object upload
  metadata?: Map<string, string>;
  // the max number of workers of a multipart upload (defaults to 5)
  maxConcurrency?: number;
  // the min payload size required to perform a multipart upload (defaults
  // to ~6MB)
  minPartSize?: number;
  // headers for all Upload requests (single upload, multipart init, parts,
  // complete, abort)
  headers?: Headers;
  signal?: AbortSignal | undefined;
}

function encodeQuery(values: [string, string][]): string {
  return values
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replaceAll("%20", "+")}`)
    .join("&");
}

export class Uploader {
  readonly #s3: S3;
  readonly #payload: Blob;
  readonly #key: string;
  readonly #metadata: Map<string, string>;
  readonly #maxConcurrency: number;
  readonly #minPartSize: number;
  readonly #headers: Headers;
  readonly #signal: AbortSignal | undefined;

  #uploadId = "";
  readonly #uploadedParts: MpPart[] = [];
  #lastPartNumber = 0;
  #offset = 0;

  constructor(opts: UploaderOptions) {
    this.#s3 = opts.s3;
    this.#payload = opts.payload;
    this.#key = opts.key;
    this.#metadata = opts.metadata ?? new Map();
    this.#maxConcurrency = Math.max(opts.maxConcurrency ?? 0, 0) || defaultMaxConcurrency;
    this.#minPartSize = Math.max(opts.minPartSize ?? 0, 0) || defaultMinPartSize;
    this.#headers = opts.headers ?? new Headers();
    this.#signal = opts.signal;
  }

  // Upload processes the current Uploader instance.
  async upload(): Promise<void> {
    if (this.#key === "") {
      throw new Error("Uploader.Key is required");
    }

    if (this.#payload.size < this.#minPartSize) {
      this.#lastPartNumber++;
      await this.#singleUpload(await this.#payload.bytes());
      return;
    }

    try {
      await this.#multipartInit();
    } catch (err) {
      throw wrapf("multipart init error: ", err);
    }

    try {
      await this.#multipartUpload();
    } catch (err) {
      throw joinErrors(await this.#multipartAbort(), wrapf("multipart upload error: ", err));
    }

    try {
      await this.#multipartComplete();
    } catch (err) {
      throw joinErrors(await this.#multipartAbort(), wrapf("multipart complete error: ", err));
    }
  }

  #withMetadata(): Headers {
    const headers = new Headers();
    for (const [k, v] of this.#metadata) {
      headers.set(metadataPrefix + k, v);
    }
    this.#headers.forEach((value, key) => headers.set(key, value));
    return headers;
  }

  async #singleUpload(part: Uint8Array): Promise<void> {
    const resp = await this.#s3.signAndSend({
      method: "PUT",
      url: this.#s3.url(this.#key),
      headers: this.#withMetadata(),
      body: part,
      signal: this.#signal,
    });
    await resp.arrayBuffer();
  }

  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html
  async #multipartInit(): Promise<void> {
    const resp = await this.#s3.signAndSend({
      method: "POST",
      url: this.#s3.url(this.#key + "?uploads"),
      headers: this.#withMetadata(),
      signal: this.#signal,
    });

    const body = parseRoot(
      new Uint8Array(await resp.arrayBuffer()),
      "InitiateMultipartUploadResult",
    );
    this.#uploadId = childText(body, "UploadId");
  }

  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html
  //
  // Returns the abort's error, or null.
  async #multipartAbort(): Promise<unknown> {
    try {
      const query = encodeQuery([["uploadId", this.#uploadId]]);
      const resp = await this.#s3.signAndSend({
        method: "DELETE",
        url: this.#s3.url(`${this.#key}?${query}`),
        headers: this.#headers,
        // the abort always runs, also past a cancelled context
        signal: this.#signal?.aborted === true ? undefined : this.#signal,
      });
      await resp.arrayBuffer();
      return null;
    } catch (err) {
      return err;
    }
  }

  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
  async #multipartComplete(): Promise<void> {
    // the list of parts must be sorted in ascending order
    this.#uploadedParts.sort((a, b) => a.partNumber - b.partNumber);

    // build a request payload with the uploaded parts
    let xmlParts = '<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>';
    for (const part of this.#uploadedParts) {
      xmlParts += `<Part><ETag>${escapeText(part.etag)}</ETag><PartNumber>${part.partNumber}</PartNumber></Part>`;
    }
    xmlParts += "</CompleteMultipartUpload>";

    const query = encodeQuery([["uploadId", this.#uploadId]]);
    const resp = await this.#s3.signAndSend({
      method: "POST",
      url: this.#s3.url(`${this.#key}?${query}`),
      headers: this.#headers,
      body: xmlParts,
      signal: this.#signal,
    });
    await resp.arrayBuffer();
  }

  // the next part's bytes and number, or null at the end of the payload
  async #nextPart(): Promise<[Uint8Array, number] | null> {
    const start = this.#offset;
    if (start >= this.#payload.size) {
      return null;
    }
    const end = Math.min(start + this.#minPartSize, this.#payload.size);
    this.#offset = end;
    const number = ++this.#lastPartNumber;
    return [await this.#payload.slice(start, end).bytes(), number];
  }

  async #multipartUpload(): Promise<void> {
    let failed = false;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (failed) {
          return;
        }
        try {
          const next = await this.#nextPart();
          if (next === null) {
            return;
          }
          const [part, num] = next;
          this.#uploadedParts.push(await this.#uploadPart(num, part));
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };

    const results = await Promise.allSettled(
      Array.from({ length: this.#maxConcurrency }, () => worker()),
    );
    const firstFailure = results.find((r) => r.status === "rejected");
    if (firstFailure !== undefined) {
      throw firstFailure.reason;
    }
  }

  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html
  async #uploadPart(partNumber: number, partData: Uint8Array): Promise<MpPart> {
    const query = encodeQuery([
      ["partNumber", String(partNumber)],
      ["uploadId", this.#uploadId],
    ]);

    const resp = await this.#s3.signAndSend({
      method: "PUT",
      url: this.#s3.url(`${this.#key}?${query}`),
      headers: this.#headers,
      body: partData,
      signal: this.#signal,
    });
    await resp.arrayBuffer();

    return { partNumber, etag: resp.headers.get("ETag") ?? "" };
  }
}

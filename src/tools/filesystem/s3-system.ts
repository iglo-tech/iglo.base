// Upstream: tools/filesystem/filesystem.go (NewS3 and the System methods, for
// an S3 bucket)
//
// S3System is the S3 storage beside the synchronous System (filesystem.ts).
// Its methods have System's names and return promises, so code that handles
// both awaits the same calls; they go over the network, so they never run
// inside a database write transaction. The signal given to NewS3 is Go's
// SetContext.
//
// Serve answers with http.ServeContent's rules through a RemoteFile: Bun
// sends a stream without its Content-Length, so the requested bytes reach a
// temporary file first and are sent from there, once the whole range is in.
//
// M5.4b adds what file storage needs here (GetReuploadableFile, CreateThumb,
// IsEmptyDir, the copy of a stored file). Not ported: the deprecated
// GetFile, UploadMultipart (see filesystem.ts) and the hooks (D5).

import { mkdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";

import type { FileHandle } from "node:fs/promises";

import { type AsyncReader, AsyncBucket } from "@/tools/filesystem/blob/async-bucket";
import type { WriterOptions } from "@/tools/filesystem/blob/bucket";
import type { Attributes, ListObject } from "@/tools/filesystem/blob/driver";
import type { File } from "@/tools/filesystem/file";
import { setServeHeaders, uploadFileOptions } from "@/tools/filesystem/filesystem";
import { New as newS3blob } from "@/tools/filesystem/internal/s3blob/s3blob";
import { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";
import type { HttpRequest } from "@/server/request";
import type { ResponseWriter } from "@/server/router";
import { type HttpRange, serveContent } from "@/server/serve-content";
import { detect } from "@/tools/mimetype/mimetype";

export class S3System {
  readonly #bucket: AsyncBucket;
  // pb_data's temp directory, for what is spooled to disk
  readonly #tempDir: string;

  constructor(bucket: AsyncBucket, tempDir: string) {
    this.#bucket = bucket;
    this.#tempDir = tempDir;
  }

  // Close releases any resources used for the related filesystem.
  close(): void {
    this.#bucket.close();
  }

  // Exists checks if file with fileKey path exists or not.
  exists(fileKey: string): Promise<boolean> {
    return this.#bucket.exists(fileKey);
  }

  // Attributes returns the attributes for the file with fileKey path.
  //
  // If the file doesn't exist it throws an error for which isNotFound is
  // true.
  attributes(fileKey: string): Promise<Attributes> {
    return this.#bucket.attributes(fileKey);
  }

  // GetReader returns a file content reader for the given fileKey.
  //
  // NB! Read or cancel its body after you are done working with it.
  getReader(fileKey: string): Promise<AsyncReader> {
    return this.#bucket.newRangeReader(fileKey, 0, -1);
  }

  // List returns a flat list with info for all files under the specified
  // prefix.
  async list(prefix: string): Promise<ListObject[]> {
    const files: ListObject[] = [];

    const iter = this.#bucket.list({ prefix });

    for (;;) {
      const obj = await iter.next();
      if (obj === null) {
        break;
      }
      files.push(obj);
    }

    return files;
  }

  // Upload writes content into the fileKey location.
  upload(content: Uint8Array, fileKey: string): Promise<void> {
    return this.#upload(new Blob([content as Uint8Array<ArrayBuffer>]), fileKey, {
      contentType: detect(content).string(),
    });
  }

  // UploadFile uploads the provided File to the fileKey location.
  uploadFile(file: File, fileKey: string): Promise<void> {
    return this.#upload(file.reader, fileKey, uploadFileOptions(file));
  }

  #upload(payload: Blob, fileKey: string, opts: WriterOptions): Promise<void> {
    return this.#bucket.upload(fileKey, payload, opts);
  }

  // Delete deletes stored file at fileKey location.
  //
  // A missing key is not an error on S3, whose delete answers 204 for it.
  delete(fileKey: string): Promise<void> {
    return this.#bucket.delete(fileKey);
  }

  // DeletePrefix deletes everything starting with the specified prefix and
  // returns the failures.
  //
  // The prefix could be subpath (ex. "/a/b/") or filename prefix (ex.
  // "/a/b/file_").
  async deletePrefix(prefix: string): Promise<unknown[]> {
    const failed: unknown[] = [];

    if (prefix === "") {
      failed.push(new Error("prefix mustn't be empty"));
      return failed;
    }

    const dirsMap = new Set<string>();

    let isPrefixDir = false;

    // treat the prefix as directory only if it ends with trailing slash
    if (prefix.endsWith("/")) {
      isPrefixDir = true;
      dirsMap.add(prefix.replace(/\/+$/, ""));
    }

    // delete all files with the prefix
    // ---
    const iter = this.#bucket.list({ prefix });
    for (;;) {
      let obj: ListObject | null;
      try {
        obj = await iter.next();
      } catch (err) {
        failed.push(err);
        break;
      }
      if (obj === null) {
        break;
      }

      try {
        await this.delete(obj.key);
        if (isPrefixDir) {
          const slashIdx = obj.key.lastIndexOf("/");
          if (slashIdx > -1) {
            dirsMap.add(obj.key.slice(0, slashIdx));
          }
        }
      } catch (err) {
        failed.push(err);
      }
    }
    // ---

    // try to delete the empty remaining dir objects
    // (this operation usually is optional and there is no need to strictly
    // check the result)
    // ---
    // sort the child dirs first, aka. ["a/b/c", "a/b", "a"] (a stable sort)
    const dirs = [...dirsMap].toSorted((a, b) => b.split("/").length - a.split("/").length);

    // delete dirs
    for (const d of dirs) {
      if (d !== "") {
        try {
          await this.delete(d);
        } catch {
          // optional
        }
      }
    }
    // ---

    return failed;
  }

  // Writes the file at fileKey to a new file at path, in the pieces it
  // arrives in, and deletes it again if that fails.
  async download(fileKey: string, path: string): Promise<void> {
    const out = await open(path, "wx", 0o600);
    try {
      await this.#copyRange(fileKey, 0, -1, out);
    } catch (err) {
      await out.close();
      rmSync(path, { force: true });
      throw err;
    }
    await out.close();
  }

  // Serve serves the file at fileKey location to an HTTP response.
  //
  // If the `download` query parameter is used the file will be always
  // served for download no matter of its type (aka. with
  // "Content-Disposition: attachment").
  //
  // If the file doesn't exist it throws an error for which isNotFound is
  // true.
  async serve(res: ResponseWriter, req: HttpRequest, fileKey: string, name: string): Promise<void> {
    const attrs = await this.attributes(fileKey);

    setServeHeaders(res, req, fileKey, name, attrs.contentType);

    // the first byte waits for the spool
    res.disableTimeout();

    let spooled: Promise<unknown> = Promise.resolve();
    serveContent(
      res,
      req,
      name,
      {
        size: attrs.size,
        spool: (parts) => {
          const spool = this.#spool(fileKey, parts);
          spooled = spool;
          return spool;
        },
      },
      attrs.modTime,
    );

    // the caller closes the filesystem once this returns; a failure ends the
    // response (serveContent)
    await spooled.catch(() => {});
  }

  // Writes the parts of a response body (bytes, or ranges of the stored
  // file) to a file in pb_data's temp directory, which the app clears at
  // start.
  async #spool(
    fileKey: string,
    parts: (Uint8Array | HttpRange)[],
  ): Promise<{ blob: Blob; remove: () => void }> {
    mkdirSync(this.#tempDir, { recursive: true });
    const path =
      this.#tempDir +
      "/ranges_" +
      Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");
    const remove = (): void => rmSync(path, { force: true });
    const out = await open(path, "wx", 0o600);
    try {
      for (const part of parts) {
        if (part instanceof Uint8Array) {
          await out.write(part);
        } else {
          await this.#copyRange(fileKey, part.start, part.length, out);
        }
      }
    } catch (err) {
      await out.close();
      remove();
      throw err;
    }
    await out.close();
    return { blob: Bun.file(path), remove };
  }

  async #copyRange(fileKey: string, start: number, length: number, out: FileHandle): Promise<void> {
    const r = await this.#bucket.newRangeReader(fileKey, start, length);
    const expected = length < 0 ? r.size : length;
    let copied = 0;
    if (r.body !== null) {
      for await (const chunk of r.body) {
        await out.write(chunk);
        copied += chunk.length;
      }
    }
    if (copied !== expected) {
      throw new Error("unexpected EOF");
    }
  }
}

// NewS3 initializes a new S3 filesystem instance. tempDir is pb_data's temp
// directory; signal stands for Go's SetContext.
//
// NB! Make sure to call close() after you are done working with it.
export function NewS3(
  bucketName: string,
  region: string,
  endpoint: string,
  accessKey: string,
  secretKey: string,
  s3ForcePathStyle: boolean,
  tempDir: string,
  signal?: AbortSignal,
): S3System {
  const client = new S3({
    bucket: bucketName,
    region,
    endpoint,
    accessKey,
    secretKey,
    usePathStyle: s3ForcePathStyle,
  });

  return new S3System(new AsyncBucket(newS3blob(client), signal), tempDir);
}

// One write request of the records-write differential cases
// (records-write.test.ts), sent to upstream and iglo.base in the same
// order, as the identity `as`.

import type { ChunkedBody } from "@test/differential/records-write/chunked";

export interface WriteCase {
  name: string;
  // the identity sending the request (a guest sends no Authorization)
  as: string;
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  body?: string | Uint8Array;
  // a chunked body (Transfer-Encoding: chunked), sent instead of body
  chunked?: ChunkedBody;
  // more headers (a JSON content type is the default)
  headers?: Record<string, string>;
  // more records to read back as a superuser after the write, besides the
  // written one
  reads?: string[];
}

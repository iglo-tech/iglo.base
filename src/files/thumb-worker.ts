// Upstream: none. The thread of one thumb worker of the thumb pool
// (src/files/thumb-pool.ts): it makes one thumb at a time from the
// original's bytes (create-thumb.ts) and posts the encoded thumb back.
//
// `bun build --compile` needs this file as an entry point of its own
// (package.json "build").

import { createThumb } from "@/files/create-thumb";
import type { ThumbRequestMessage, ThumbResponseMessage } from "@/files/thumb-pool";

declare const self: Worker;

self.addEventListener("message", async (event: MessageEvent<ThumbRequestMessage>) => {
  const { id, input, contentType, size, maxPixels } = event.data;
  let res: ThumbResponseMessage;
  try {
    const thumb = await createThumb(new Uint8Array(input), contentType, size, maxPixels);
    res = { id, ok: true, bytes: thumb.bytes, contentType: thumb.contentType };
  } catch (err) {
    res = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // a Worker's postMessage has no target origin (that is window.postMessage)
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(res, res.ok ? [res.bytes.buffer as ArrayBuffer] : []);
});

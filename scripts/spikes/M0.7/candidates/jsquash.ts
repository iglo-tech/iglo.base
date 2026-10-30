// M0.7 candidate "jsquash": WebAssembly codecs, upstream's geometry.
//
// @jsquash/jpeg (MozJPEG), @jsquash/png (the Rust png crate) and
// @jsquash/webp (libwebp) decode and encode; omggif decodes GIF. The wasm
// files are embedded with `with { type: "file" }` so they load inside a
// compiled executable. The header check, the EXIF orientation, the resize
// and crop and the GIF encoder are the spike's ports (orient.ts, imaging.ts,
// gif.ts), as no codec here reads them.

import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import encodeJpeg, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import decodePngWasm, { init as initPngDecode } from "@jsquash/png/decode.js";
import encodePngWasm, { init as initPngEncode } from "@jsquash/png/encode.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import jpegDecWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm" with { type: "file" };
import jpegEncWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm" with { type: "file" };
// the package ships a .d.ts for this file, so the default is read by hand
import * as pngWasmFile from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" with { type: "file" };
import webpDecWasm from "@jsquash/webp/codec/dec/webp_dec.wasm" with { type: "file" };
import { GifReader } from "omggif";

import { encodeGif } from "@/../scripts/spikes/M0.7/gif";
import { parseThumbSize, thumbFormat, thumbGeometry } from "@/../scripts/spikes/M0.7/imaging";
import {
  checkJpegComplete,
  fixOrientation,
  headerSize,
  readOrientation,
} from "@/../scripts/spikes/M0.7/orient";
import type { Raw } from "@/../scripts/spikes/M0.7/png";
import { checkPixels, thumbContentType, type CreateThumb } from "@/../scripts/spikes/M0.7/thumb";

// the emscripten modules build ImageData results; Bun has no ImageData
class ImageDataShim {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
(globalThis as Record<string, unknown>).ImageData ??= ImageDataShim;

const pngWasm = (pngWasmFile as unknown as { default: string }).default;

const compile = async (path: string): Promise<WebAssembly.Module> =>
  WebAssembly.compile(await Bun.file(path).arrayBuffer());

let ready: Promise<unknown> | undefined;
const init = (): Promise<unknown> =>
  (ready ??= Promise.all([
    compile(jpegDecWasm).then(initJpegDecode),
    compile(jpegEncWasm).then(initJpegEncode),
    compile(pngWasm).then((m) => Promise.all([initPngDecode(m), initPngEncode(m)])),
    compile(webpDecWasm).then(initWebpDecode),
  ]));

const toRaw = (d: { data: Uint8ClampedArray; width: number; height: number }): Raw => ({
  width: d.width,
  height: d.height,
  pix: new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength),
});

const ab = (b: Uint8Array): ArrayBuffer => b.slice().buffer;

// image.Decode picks the decoder by the leading bytes, as here
async function decode(input: Uint8Array): Promise<Raw> {
  if (input[0] === 0xff && input[1] === 0xd8) {
    // preserveOrientation: true would apply the EXIF orientation; false
    // keeps the stored pixel order and imaging's fix is applied here
    const raw = toRaw(await decodeJpeg(ab(input), { preserveOrientation: false }));
    return fixOrientation(raw, readOrientation(input));
  }
  if (input[0] === 0x89 && input[1] === 0x50) {
    return toRaw(await decodePngWasm(ab(input)));
  }
  if (input[0] === 0x47 && input[1] === 0x49) {
    const reader = new GifReader(input);
    const pix = new Uint8Array(reader.width * reader.height * 4);
    reader.decodeAndBlitFrameRGBA(0, pix);
    return { width: reader.width, height: reader.height, pix };
  }
  if (input[0] === 0x52 && input[1] === 0x49) {
    return toRaw(await decodeWebp(ab(input)));
  }
  throw new Error("image: unknown format");
}

async function encode(raw: Raw, format: string): Promise<Uint8Array> {
  const data = {
    data: new Uint8ClampedArray(raw.pix.buffer, raw.pix.byteOffset, raw.pix.byteLength),
    width: raw.width,
    height: raw.height,
  };
  if (format === "jpeg") {
    return new Uint8Array(
      await encodeJpeg(data, { quality: 95, baseline: true, progressive: false }),
    );
  }
  if (format === "png") {
    return new Uint8Array(await encodePngWasm(data));
  }
  if (format === "gif") {
    return encodeGif(raw.pix, raw.width, raw.height);
  }
  throw new Error(`no ${format} encoder in this candidate`);
}

export const createThumb: CreateThumb = async (input, contentType, size, maxPixels) => {
  await init();
  const thumbSize = parseThumbSize(size);
  const header = headerSize(input);
  checkJpegComplete(input);
  checkPixels(header.width, header.height, maxPixels);
  const thumb = thumbGeometry(await decode(input), thumbSize);
  return {
    bytes: await encode(thumb, thumbFormat(contentType)),
    contentType: thumbContentType(contentType),
  };
};

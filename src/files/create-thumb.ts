// Upstream: tools/filesystem/filesystem.go (createThumb: the steps after
// the original is read, up to the encoded thumb)
//
// Runs in a thumb worker (thumb-worker.ts). The library choice and the
// measurements behind it are in docs/perf/M0.7-thumbnails.md (D10):
//
//  1. The header is read as Go's image.DecodeConfig reads it
//     (image-config.ts), and its size is checked against
//     PB_THUMBS_MAX_SOURCE_PIXELS with upstream's error text (checkSource,
//     which the file storage also runs before it reads the original). A JPEG that
//     ends before its EOI marker fails, as Go's decoder fails it.
//  2. The geometry is planned on the size imaging.Decode returns: a GIF's
//     first frame, a JPEG turned by imaging's EXIF orientation.
//  3. Bun.Image decodes (without its own EXIF orientation), applies
//     imaging's orientation, and hands the pixels over as an uncompressed
//     PNG. The resize and crop are the port of imaging's (imaging.ts).
//     Originals over 16 megapixels are first reduced by Bun.Image's box
//     filter to at least 4 source pixels per thumb pixel, so their full
//     pixels never reach JavaScript; the crop is still planned on the
//     original's size.
//  4. JPEG (quality 95, imaging's default) and PNG are encoded by
//     Bun.Image, GIF by the port of Go's encoder (gif-encode.ts). The thumb
//     keeps the original's content type for JPEG and GIF; everything else
//     (WebP included) becomes image/png, as createThumb's switch does.

import { encodeGif } from "@/files/gif-encode";
import {
  type ByteSource,
  checkJpegComplete,
  decodeConfig,
  gifFirstFrame,
  orientImage,
  readOrientation,
  type Size,
} from "@/files/image-config";
import {
  cropRect,
  resize,
  thumbFormat,
  thumbGeometry,
  thumbPlan,
  type ThumbSize,
} from "@/files/imaging";
import { decodePng, encodePng, type Raw } from "@/files/png-raw";

export interface Thumb {
  bytes: Uint8Array;
  contentType: string;
}

// originals up to this many pixels take the exact path (D10)
const exactMaxPixels = 16_000_000;

// the source pixels kept per thumb pixel, in both directions, by the
// pre-reduction of larger originals
const reductionMargin = 4;

interface Header {
  // the size of the image imaging.Decode returns, which the geometry plans on
  width: number;
  height: number;
  // imaging's EXIF orientation (0 when there is none)
  orientation: number;
}

// The first step of createThumb: image.DecodeConfig's size checked
// against PB_THUMBS_MAX_SOURCE_PIXELS, with upstream's errors. The file
// storage runs it on the stored original through a reader source before it
// reads the whole file, so an original over the limit is never loaded; the
// worker runs it again on the bytes it gets.
export function checkSource(src: Uint8Array | ByteSource, maxPixels: number): Size {
  let config;
  try {
    config = decodeConfig(src);
  } catch (err) {
    throw new Error(`image headers decoding failed: ${(err as Error).message}`, { cause: err });
  }
  if (config.width * config.height > maxPixels) {
    throw new Error(
      `the original image is too large (${config.width}x${config.height}) and exceeds the total max allowed ${maxPixels} pixels`,
    );
  }
  return config;
}

// What createThumb reads before the decode, read as Go reads it, not from
// Bun.Image's metadata(): image.DecodeConfig's size is checked against
// PB_THUMBS_MAX_SOURCE_PIXELS (for a GIF the logical screen, which can be
// larger than the first frame Bun.Image reports). The geometry is planned
// on what imaging.Decode returns: a GIF's first frame, and a JPEG turned by
// imaging's readOrientation, which reads only the first APP1 segment.
function readHeader(input: Uint8Array, maxPixels: number): Header {
  const config = checkSource(input, maxPixels);
  // libjpeg-turbo decodes a cut JPEG with a warning; Go's decoder fails
  checkJpegComplete(input);
  const size = input[0] === 0x47 ? gifFirstFrame(input) : config;
  const orientation = readOrientation(input);
  return orientation >= 5
    ? { width: size.height, height: size.width, orientation }
    : { width: size.width, height: size.height, orientation };
}

// The decode pipeline: Bun.Image's own EXIF orientation is turned off,
// because it also finds an Exif segment after an XMP APP1 segment, which
// imaging ignores. imaging's orientation is applied by Bun.Image's rotate,
// flip and flop, before any resize.
function openImage(input: Uint8Array, header: Header, maxPixels: number): Bun.Image {
  return orientImage(new Bun.Image(input, { maxPixels, autoOrient: false }), header.orientation);
}

async function pixels(img: Bun.Image): Promise<Raw> {
  return decodePng(await img.png({ compressionLevel: 0 }).bytes());
}

async function encode(raw: Raw, format: ReturnType<typeof thumbFormat>): Promise<Uint8Array> {
  if (format === "gif") {
    return encodeGif(raw.pix, raw.width, raw.height);
  }
  const img = new Bun.Image(encodePng(raw, 0));
  if (format === "jpeg") {
    return img.jpeg({ quality: 95 }).bytes();
  }
  if (format === "png") {
    return img.png({ compressionLevel: 6 }).bytes();
  }
  // createThumb keeps TIFF and BMP, which the file API never thumbs
  throw new Error(`imaging: unsupported image format (${format})`);
}

// createThumb for the original's bytes and stored content type. Throws
// where upstream's CreateThumb returns an error.
export async function createThumb(
  input: Uint8Array,
  contentType: string,
  size: ThumbSize,
  maxPixels: number,
): Promise<Thumb> {
  const header = readHeader(input, maxPixels);
  const { width, height } = header;
  const format = thumbFormat(contentType);
  const thumbContentType = format === "png" ? "image/png" : contentType;

  const plan = thumbPlan(width, height, size);
  // the whole original's size at the thumb's scale
  let scaledW = width;
  let scaledH = height;
  if (plan.kind === "resize") {
    scaledW = plan.width;
    scaledH = plan.height;
  } else if (plan.kind === "crop-resize") {
    scaledW = (width * plan.width) / plan.crop.width;
    scaledH = (height * plan.height) / plan.crop.height;
  }
  const factor = Math.min(
    width / (reductionMargin * scaledW),
    height / (reductionMargin * scaledH),
  );

  if (
    width * height <= exactMaxPixels ||
    plan.kind === "copy" ||
    plan.kind === "resize-crop" ||
    factor < 1.5
  ) {
    // the exact path: imaging's geometry on the full pixels
    const decoded = await pixels(openImage(input, header, maxPixels));
    return {
      bytes: await encode(thumbGeometry(decoded, size), format),
      contentType: thumbContentType,
    };
  }

  // the reduced path: Bun.Image turns the image before it resizes, so
  // rw x rh is in the turned image's orientation, as the plan is
  const rw = Math.round(width / factor);
  const rh = Math.round(height / factor);
  const reduced = await pixels(
    openImage(input, header, maxPixels).resize(rw, rh, { filter: "box" }),
  );
  let thumb: Raw;
  if (plan.kind === "resize") {
    thumb = resize(reduced, plan.width, plan.height);
  } else {
    // the crop in reduced pixels
    const sx = rw / width;
    const sy = rh / height;
    const x = Math.round(plan.crop.x * sx);
    const y = Math.round(plan.crop.y * sy);
    const crop = cropRect(reduced, {
      x,
      y,
      width: Math.min(rw - x, Math.max(1, Math.round(plan.crop.width * sx))),
      height: Math.min(rh - y, Math.max(1, Math.round(plan.crop.height * sy))),
    });
    thumb = resize(crop, plan.width, plan.height);
  }
  return { bytes: await encode(thumb, format), contentType: thumbContentType };
}

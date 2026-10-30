// M0.7 candidate "bun-imaging": Bun.Image's codecs, upstream's geometry.
//
// The header is read as Go reads it (orient.ts). Bun.Image (Bun >= 1.4:
// libjpeg-turbo, spng, libwebp, built-in GIF and BMP decoders) decodes,
// without its own EXIF orientation, turned by imaging's; the pixels leave it
// as an uncompressed PNG. The resize and crop are the port of imaging's Linear
// filter in imaging.ts, so they are upstream's arithmetic. Bun.Image encodes
// JPEG (quality 95, imaging's default) and PNG; GIF is the port in gif.ts.

import { encodeGif } from "@/../scripts/spikes/M0.7/gif";
import { parseThumbSize, thumbFormat, thumbGeometry } from "@/../scripts/spikes/M0.7/imaging";
import {
  checkJpegComplete,
  decodeConfig,
  gifFirstFrame,
  orientImage,
  readOrientation,
} from "@/../scripts/spikes/M0.7/orient";
import { decodePng, encodePng, type Raw } from "@/../scripts/spikes/M0.7/png";
import { checkPixels, thumbContentType, type CreateThumb } from "@/../scripts/spikes/M0.7/thumb";

export interface Header {
  // the size of the image imaging.Decode returns, which the geometry plans on
  width: number;
  height: number;
  // imaging's EXIF orientation (0 when there is none)
  orientation: number;
}

// What createThumb reads before the decode, read as Go reads it, not from
// Bun.Image's metadata(): image.DecodeConfig's size is checked against
// PB_THUMBS_MAX_SOURCE_PIXELS (for a GIF the logical screen, which can be
// larger than the first frame Bun.Image reports). The geometry is planned
// on what imaging.Decode returns: a GIF's first frame, and a JPEG turned by
// imaging's readOrientation, which reads only the first APP1 segment.
export function bunHeader(input: Uint8Array, maxPixels: number): Header {
  const config = decodeConfig(input);
  checkPixels(config.width, config.height, maxPixels);
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
export function bunImage(input: Uint8Array, header: Header, maxPixels: number): Bun.Image {
  return orientImage(new Bun.Image(input, { maxPixels, autoOrient: false }), header.orientation);
}

export async function bunEncode(raw: Raw, format: string): Promise<Uint8Array> {
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
  throw new Error(`no ${format} encoder in this candidate`);
}

export const createThumb: CreateThumb = async (input, contentType, size, maxPixels) => {
  const thumbSize = parseThumbSize(size);
  const header = bunHeader(input, maxPixels);
  const decoded = decodePng(
    await bunImage(input, header, maxPixels).png({ compressionLevel: 0 }).bytes(),
  );
  const thumb = thumbGeometry(decoded, thumbSize);
  return {
    bytes: await bunEncode(thumb, thumbFormat(contentType)),
    contentType: thumbContentType(contentType),
  };
};

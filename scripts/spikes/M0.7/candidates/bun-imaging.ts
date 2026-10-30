// M0.7 candidate "bun-imaging": Bun.Image's codecs, upstream's geometry.
//
// Bun.Image (Bun >= 1.4: libjpeg-turbo, spng, libwebp, built-in GIF and BMP
// decoders) reads the header and decodes; the pixels leave it as an
// uncompressed PNG. The resize and crop are the port of imaging's Linear
// filter in imaging.ts, so they are upstream's arithmetic. Bun.Image encodes
// JPEG (quality 95, imaging's default) and PNG; GIF is the port in gif.ts.

import { encodeGif } from "@/../scripts/spikes/M0.7/gif";
import { checkJpegComplete } from "@/../scripts/spikes/M0.7/orient";
import { parseThumbSize, thumbFormat, thumbGeometry } from "@/../scripts/spikes/M0.7/imaging";
import { decodePng, encodePng, type Raw } from "@/../scripts/spikes/M0.7/png";
import { checkPixels, thumbContentType, type CreateThumb } from "@/../scripts/spikes/M0.7/thumb";

// the header only: Bun.Image refuses an image over maxPixels before it
// allocates the pixels, and the spike repeats upstream's check and message
export async function bunHeader(
  input: Uint8Array,
  maxPixels: number,
): Promise<{ width: number; height: number }> {
  const meta = await new Bun.Image(input, { maxPixels }).metadata().catch((err: unknown) => {
    const code = (err as { code?: string }).code;
    if (code === "ERR_IMAGE_TOO_MANY_PIXELS") {
      throw new Error(
        `the original image is too large and exceeds the total max allowed ${maxPixels} pixels`,
      );
    }
    throw err;
  });
  checkPixels(meta.width, meta.height, maxPixels);
  // libjpeg-turbo decodes a cut JPEG with a warning; Go's decoder fails
  checkJpegComplete(input);
  return meta;
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
  await bunHeader(input, maxPixels);
  const decoded = decodePng(
    await new Bun.Image(input, { maxPixels }).png({ compressionLevel: 0 }).bytes(),
  );
  const thumb = thumbGeometry(decoded, thumbSize);
  return {
    bytes: await bunEncode(thumb, thumbFormat(contentType)),
    contentType: thumbContentType(contentType),
  };
};

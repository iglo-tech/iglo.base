// M0.7 candidate "bun-native": Bun.Image decodes and resizes.
//
// Bun.Image's own "linear" resize runs on its worker thread, and a JPEG
// reduced to half or less is decoded at a 1/2, 1/4 or 1/8 DCT scale, so the
// full-size pixels never exist. Bun.Image cannot crop, so a fill crop is
// taken after the resize, from Bun.Image's resize of the whole image to the
// size the crop would scale to (imaging crops first). Encoding as in
// bun-imaging.

import { bunEncode, bunHeader } from "@/../scripts/spikes/M0.7/candidates/bun-imaging";
import { cropRect, parseThumbSize, thumbFormat, thumbPlan } from "@/../scripts/spikes/M0.7/imaging";
import { decodePng } from "@/../scripts/spikes/M0.7/png";
import { thumbContentType, type CreateThumb } from "@/../scripts/spikes/M0.7/thumb";

export const createThumb: CreateThumb = async (input, contentType, size, maxPixels) => {
  const thumbSize = parseThumbSize(size);
  // metadata() reports the size after the JPEG EXIF orientation
  const { width, height } = await bunHeader(input, maxPixels);
  const format = thumbFormat(contentType);
  const plan = thumbPlan(width, height, thumbSize);
  const pipeline = new Bun.Image(input, { maxPixels });
  if (plan.kind !== "copy") {
    let w = plan.width;
    let h = plan.height;
    if (plan.kind === "crop-resize") {
      // the whole image at the scale that maps the crop onto width x height
      w = Math.round((width * plan.width) / plan.crop.width);
      h = Math.round((height * plan.height) / plan.crop.height);
    }
    pipeline.resize(w, h, { filter: "linear" });
  }
  if (plan.kind === "copy" || plan.kind === "resize") {
    if (format === "jpeg") {
      return { bytes: await pipeline.jpeg({ quality: 95 }).bytes(), contentType };
    }
    if (format === "png") {
      return {
        bytes: await pipeline.png({ compressionLevel: 6 }).bytes(),
        contentType: thumbContentType(contentType),
      };
    }
  }
  const raw = decodePng(await pipeline.png({ compressionLevel: 0 }).bytes());
  let out = raw;
  if (plan.kind === "crop-resize") {
    const sx = plan.width / plan.crop.width;
    const sy = plan.height / plan.crop.height;
    const x = Math.min(raw.width - plan.width, Math.max(0, Math.round(plan.crop.x * sx)));
    const y = Math.min(raw.height - plan.height, Math.max(0, Math.round(plan.crop.y * sy)));
    out = cropRect(raw, { x, y, width: plan.width, height: plan.height });
  } else if (plan.kind === "resize-crop") {
    out = cropRect(raw, plan.crop);
  }
  return { bytes: await bunEncode(out, format), contentType: thumbContentType(contentType) };
};

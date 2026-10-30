// M0.7 baseline "sharp": libvips through a native addon. Measured for speed
// only; a native addon is never the choice (D10).

import sharp from "sharp";

import { parseThumbSize, thumbFormat, thumbPlan } from "@/../scripts/spikes/M0.7/imaging";
import { readOrientation } from "@/../scripts/spikes/M0.7/orient";
import { checkPixels, thumbContentType, type CreateThumb } from "@/../scripts/spikes/M0.7/thumb";

export const createThumb: CreateThumb = async (input, contentType, size, maxPixels) => {
  const thumbSize = parseThumbSize(size);
  const meta = await sharp(input, { limitInputPixels: false }).metadata();
  const sw = meta.width ?? 0;
  const sh = meta.height ?? 0;
  checkPixels(sw, sh, maxPixels);
  const swap = input[0] === 0xff && readOrientation(input) >= 5;
  const [width, height] = swap ? [sh, sw] : [sw, sh];
  const plan = thumbPlan(width, height, thumbSize);
  // the EXIF orientation of JPEG only, as imaging
  let p = sharp(input, { limitInputPixels: false, failOn: "warning" });
  if (input[0] === 0xff) {
    p = p.rotate();
  }
  if (plan.kind === "resize") {
    p = p.resize(plan.width, plan.height, { fit: "fill", kernel: "linear" });
  } else if (plan.kind === "crop-resize") {
    const { x, y, width: w, height: h } = plan.crop;
    p = p
      .extract({ left: x, top: y, width: w, height: h })
      .resize(plan.width, plan.height, { fit: "fill", kernel: "linear" });
  } else if (plan.kind === "resize-crop") {
    const { x, y, width: w, height: h } = plan.crop;
    p = p
      .resize(plan.width, plan.height, { fit: "fill", kernel: "linear" })
      .extract({ left: x, top: y, width: w, height: h });
  }
  const format = thumbFormat(contentType);
  const out =
    format === "jpeg"
      ? p.jpeg({ quality: 95 })
      : format === "gif"
        ? p.gif()
        : p.png({ compressionLevel: 6 });
  return {
    bytes: new Uint8Array(await out.toBuffer()),
    contentType: thumbContentType(contentType),
  };
};

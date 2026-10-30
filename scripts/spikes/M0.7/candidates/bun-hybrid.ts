// M0.7 candidate "bun-hybrid": bun-imaging with a native pre-reduction.
//
// bun-imaging decodes every original at full size and moves the pixels into
// JavaScript, which costs about 1 GiB for a 50-megapixel JPEG. Here a large
// original is first reduced by Bun.Image with its "box" filter, by an
// integer factor that keeps at least `margin` source pixels per thumb pixel
// in both directions (a JPEG reduced to half or less is decoded at a DCT
// scale, so its full-size pixels never exist). Originals less than 1.5 times
// that size are not reduced. bun-hybrid keeps 4 source pixels per thumb
// pixel, bun-hybrid2 keeps 2. The port of imaging's Linear
// resize and crop (imaging.ts) then runs on the reduced pixels, with the
// plan computed on the original's size, so the dimensions and the crop are
// upstream's. Small originals take the exact bun-imaging path.

import { bunEncode, bunHeader, bunImage } from "@/../scripts/spikes/M0.7/candidates/bun-imaging";
import {
  cropRect,
  parseThumbSize,
  resize,
  thumbFormat,
  thumbGeometry,
  thumbPlan,
} from "@/../scripts/spikes/M0.7/imaging";
import { decodePng, type Raw } from "@/../scripts/spikes/M0.7/png";
import { thumbContentType, type CreateThumb } from "@/../scripts/spikes/M0.7/thumb";

export const createThumbWithMargin =
  (margin: number): CreateThumb =>
  async (input, contentType, size, maxPixels) => {
    const thumbSize = parseThumbSize(size);
    // the size after imaging's EXIF orientation; for a GIF the first frame's
    const header = bunHeader(input, maxPixels);
    const { width, height } = header;
    const plan = thumbPlan(width, height, thumbSize);
    const format = thumbFormat(contentType);
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
    const factor = Math.min(width / (margin * scaledW), height / (margin * scaledH));
    if (plan.kind === "copy" || plan.kind === "resize-crop" || factor < 1.5) {
      const decoded = decodePng(
        await bunImage(input, header, maxPixels).png({ compressionLevel: 0 }).bytes(),
      );
      return {
        bytes: await bunEncode(thumbGeometry(decoded, thumbSize), format),
        contentType: thumbContentType(contentType),
      };
    }
    const rw = Math.round(width / factor);
    const rh = Math.round(height / factor);
    const reduced: Raw = decodePng(
      // Bun.Image turns the image before it resizes, so rw x rh is in the
      // turned image's orientation, as the plan is
      await bunImage(input, header, maxPixels)
        .resize(rw, rh, { filter: "box" })
        .png({ compressionLevel: 0 })
        .bytes(),
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
    return { bytes: await bunEncode(thumb, format), contentType: thumbContentType(contentType) };
  };

export const createThumb = createThumbWithMargin(4);

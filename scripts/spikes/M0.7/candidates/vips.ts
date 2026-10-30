// M0.7 candidate "wasm-vips": libvips compiled to WebAssembly.
//
// The header is read lazily by newFromBuffer, so the pixel check comes
// before the decode. vips crops before its resize, as imaging, with the
// "linear" kernel. libvips' own JPEG (quality 95), PNG and GIF savers
// encode. wasm-vips runs libvips' threads as Workers of its own script; the
// script and vips.wasm are embedded so that works in a compiled executable.

import Vips, { type VipsImage } from "wasm-vips";
import vipsScript from "@/../scripts/spikes/M0.7/node_modules/wasm-vips/lib/vips-node.mjs" with { type: "file" };
import vipsWasm from "wasm-vips/vips.wasm" with { type: "file" };

import { parseThumbSize, thumbFormat, thumbPlan } from "@/../scripts/spikes/M0.7/imaging";
import { checkPixels, thumbContentType, type CreateThumb } from "@/../scripts/spikes/M0.7/thumb";

let ready: ReturnType<typeof Vips> | undefined;
const vips = (): ReturnType<typeof Vips> =>
  (ready ??= Vips({
    // the HEIF, JPEG XL and SVG side modules are not needed (and block)
    dynamicLibraries: [],
    locateFile: (name: string) => (name.endsWith(".wasm") ? vipsWasm : name),
    mainScriptUrlOrBlob: vipsScript,
  }).then((v) => {
    v.Cache.max(0);
    return v;
  }));

export const createThumb: CreateThumb = async (input, contentType, size, maxPixels) => {
  const v = await vips();
  const thumbSize = parseThumbSize(size);
  const owned: VipsImage[] = [];
  const keep = (img: VipsImage): VipsImage => {
    owned.push(img);
    return img;
  };
  try {
    // fail on decoder warnings: a truncated file is an error upstream
    let img = keep(v.Image.newFromBuffer(input, "", { access: "sequential", fail_on: "warning" }));
    checkPixels(img.width, img.height, maxPixels);
    // imaging applies the EXIF orientation of JPEG only
    if (input[0] === 0xff) {
      img = keep(img.autorot());
    }
    const plan = thumbPlan(img.width, img.height, thumbSize);
    const linear = (w: number, h: number): VipsImage =>
      keep(img.resize(w / img.width, { vscale: h / img.height, kernel: "linear" }));
    if (plan.kind === "resize") {
      img = linear(plan.width, plan.height);
    } else if (plan.kind === "crop-resize") {
      img = keep(img.crop(plan.crop.x, plan.crop.y, plan.crop.width, plan.crop.height));
      img = linear(plan.width, plan.height);
    } else if (plan.kind === "resize-crop") {
      img = linear(plan.width, plan.height);
      img = keep(img.crop(plan.crop.x, plan.crop.y, plan.crop.width, plan.crop.height));
    }
    const format = thumbFormat(contentType);
    const bytes =
      format === "jpeg"
        ? img.jpegsaveBuffer({ Q: 95 })
        : format === "gif"
          ? img.gifsaveBuffer()
          : img.pngsaveBuffer({ compression: 6 });
    return { bytes: bytes.slice(), contentType: thumbContentType(contentType) };
  } finally {
    for (const img of owned) {
      img.delete();
    }
  }
};

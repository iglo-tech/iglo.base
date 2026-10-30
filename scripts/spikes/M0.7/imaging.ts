// M0.7 spike: the geometry of upstream's thumbs. Not shipped.
//
// Ports the parts of github.com/disintegration/imaging v1.6.2 that
// CreateThumb (tools/filesystem/filesystem.go) calls with imaging.Linear:
// resize.go (precomputeWeights, Resize, resizeHorizontal, resizeVertical,
// Fit, Fill, cropAndResize, resizeAndCrop, the Linear filter), tools.go
// (anchorPt, Crop, CropAnchor) and utils.go (clamp). Pixels are NRGBA, as
// imaging's scanner produces them. Go's float64 arithmetic is JavaScript's.
// imaging: MIT, Copyright (c) 2012 Grigory Dryapak; M5.2 adds the notice to
// LICENSE when it moves this into src/.

import type { Raw } from "@/../scripts/spikes/M0.7/png";

export type Anchor = "center" | "top" | "bottom";

const empty = (): Raw => ({ width: 0, height: 0, pix: new Uint8Array() });

// utils.go clamp: rounds half up, then clamps to 0..255
const clamp = (x: number): number => {
  const v = Math.trunc(x + 0.5);
  return v > 255 ? 255 : v > 0 ? v : 0;
};

const linearKernel = (x: number): number => {
  const ax = Math.abs(x);
  return ax < 1 ? 1 - ax : 0;
};

interface Weights {
  // per destination index: [begin, end) into index/weight
  start: Int32Array;
  index: Int32Array;
  weight: Float64Array;
}

function precomputeWeights(dstSize: number, srcSize: number): Weights {
  const du = srcSize / dstSize;
  const scale = du < 1 ? 1 : du;
  const ru = Math.ceil(scale * 1); // Linear.Support = 1
  const cap = dstSize * (ru * 2 + 2);
  const index = new Int32Array(cap);
  const weight = new Float64Array(cap);
  const start = new Int32Array(dstSize + 1);
  let n = 0;
  for (let v = 0; v < dstSize; v++) {
    const fu = (v + 0.5) * du - 0.5;
    const begin = Math.max(0, Math.ceil(fu - ru));
    const end = Math.min(srcSize - 1, Math.floor(fu + ru));
    start[v] = n;
    let sum = 0;
    for (let u = begin; u <= end; u++) {
      const w = linearKernel((u - fu) / scale);
      if (w !== 0) {
        sum += w;
        index[n] = u;
        weight[n] = w;
        n++;
      }
    }
    if (sum !== 0) {
      for (let i = start[v] as number; i < n; i++) {
        weight[i] = (weight[i] as number) / sum;
      }
    }
  }
  start[dstSize] = n;
  return { start, index, weight };
}

function resizeHorizontal(img: Raw, width: number): Raw {
  const { width: sw, height: sh, pix: src } = img;
  const dst = new Uint8Array(width * sh * 4);
  const { start, index, weight } = precomputeWeights(width, sw);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = start[x] as number, e = start[x + 1] as number; k < e; k++) {
        const i = row + (index[k] as number) * 4;
        const aw = (src[i + 3] as number) * (weight[k] as number);
        r += (src[i] as number) * aw;
        g += (src[i + 1] as number) * aw;
        b += (src[i + 2] as number) * aw;
        a += aw;
      }
      if (a !== 0) {
        const aInv = 1 / a;
        const j = (y * width + x) * 4;
        dst[j] = clamp(r * aInv);
        dst[j + 1] = clamp(g * aInv);
        dst[j + 2] = clamp(b * aInv);
        dst[j + 3] = clamp(a);
      }
    }
  }
  return { width, height: sh, pix: dst };
}

function resizeVertical(img: Raw, height: number): Raw {
  const { width: sw, height: sh, pix: src } = img;
  const dst = new Uint8Array(sw * height * 4);
  const { start, index, weight } = precomputeWeights(height, sh);
  const stride = sw * 4;
  for (let x = 0; x < sw; x++) {
    for (let y = 0; y < height; y++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = start[y] as number, e = start[y + 1] as number; k < e; k++) {
        const i = (index[k] as number) * stride + x * 4;
        const aw = (src[i + 3] as number) * (weight[k] as number);
        r += (src[i] as number) * aw;
        g += (src[i + 1] as number) * aw;
        b += (src[i + 2] as number) * aw;
        a += aw;
      }
      if (a !== 0) {
        const aInv = 1 / a;
        const j = y * stride + x * 4;
        dst[j] = clamp(r * aInv);
        dst[j + 1] = clamp(g * aInv);
        dst[j + 2] = clamp(b * aInv);
        dst[j + 3] = clamp(a);
      }
    }
  }
  return { width: sw, height, pix: dst };
}

const clone = (img: Raw): Raw => ({ width: img.width, height: img.height, pix: img.pix.slice() });

// Resize with one of width or height 0 keeps the aspect ratio (minimum 1px)
export function resize(img: Raw, width: number, height: number): Raw {
  let dstW = width;
  let dstH = height;
  if (dstW < 0 || dstH < 0 || (dstW === 0 && dstH === 0)) {
    return empty();
  }
  const srcW = img.width;
  const srcH = img.height;
  if (srcW <= 0 || srcH <= 0) {
    return empty();
  }
  if (dstW === 0) {
    dstW = Math.trunc(Math.max(1, Math.floor((dstH * srcW) / srcH + 0.5)));
  }
  if (dstH === 0) {
    dstH = Math.trunc(Math.max(1, Math.floor((dstW * srcH) / srcW + 0.5)));
  }
  if (srcW !== dstW && srcH !== dstH) {
    return resizeVertical(resizeHorizontal(img, dstW), dstH);
  }
  if (srcW !== dstW) {
    return resizeHorizontal(img, dstW);
  }
  if (srcH !== dstH) {
    return resizeVertical(img, dstH);
  }
  return clone(img);
}

export function fit(img: Raw, maxW: number, maxH: number): Raw {
  if (maxW <= 0 || maxH <= 0) {
    return empty();
  }
  const srcW = img.width;
  const srcH = img.height;
  if (srcW <= 0 || srcH <= 0) {
    return empty();
  }
  if (srcW <= maxW && srcH <= maxH) {
    return clone(img);
  }
  const srcAspectRatio = srcW / srcH;
  const maxAspectRatio = maxW / maxH;
  let newW: number;
  let newH: number;
  if (srcAspectRatio > maxAspectRatio) {
    newW = maxW;
    newH = Math.trunc(newW / srcAspectRatio);
  } else {
    newH = maxH;
    newW = Math.trunc(newH * srcAspectRatio);
  }
  return resize(img, newW, newH);
}

// tools.go anchorPt for the three anchors CreateThumb uses; Go's integer
// division truncates toward zero
function anchorPt(w: number, h: number, cw: number, ch: number, anchor: Anchor): [number, number] {
  const x = Math.trunc((w - cw) / 2);
  if (anchor === "top") {
    return [x, 0];
  }
  if (anchor === "bottom") {
    return [x, h - ch];
  }
  return [x, Math.trunc((h - ch) / 2)];
}

export function cropAnchor(img: Raw, width: number, height: number, anchor: Anchor): Raw {
  const [px, py] = anchorPt(img.width, img.height, width, height, anchor);
  // the rectangle intersected with the image bounds
  const x0 = Math.max(0, px);
  const y0 = Math.max(0, py);
  const x1 = Math.min(img.width, px + width);
  const y1 = Math.min(img.height, py + height);
  if (x1 <= x0 || y1 <= y0) {
    return empty();
  }
  const cw = x1 - x0;
  const ch = y1 - y0;
  const pix = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    pix.set(img.pix.subarray(from, from + cw * 4), y * cw * 4);
  }
  return { width: cw, height: ch, pix };
}

// The crop rectangle cropAndResize takes from the source, for backends that
// crop before a resize of their own.
export function fillCrop(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { width: number; height: number } {
  const srcAspectRatio = srcW / srcH;
  const dstAspectRatio = dstW / dstH;
  if (srcAspectRatio < dstAspectRatio) {
    const cropH = (srcW * dstH) / dstW;
    return { width: srcW, height: Math.trunc(Math.max(1, cropH) + 0.5) };
  }
  const cropW = (srcH * dstW) / dstH;
  return { width: Math.trunc(Math.max(1, cropW) + 0.5), height: srcH };
}

export function fill(img: Raw, dstW: number, dstH: number, anchor: Anchor): Raw {
  if (dstW <= 0 || dstH <= 0) {
    return empty();
  }
  const srcW = img.width;
  const srcH = img.height;
  if (srcW <= 0 || srcH <= 0) {
    return empty();
  }
  if (srcW === dstW && srcH === dstH) {
    return clone(img);
  }
  if (srcW >= 100 && srcH >= 100) {
    // cropAndResize
    const crop = fillCrop(srcW, srcH, dstW, dstH);
    return resize(cropAnchor(img, crop.width, crop.height, anchor), dstW, dstH);
  }
  // resizeAndCrop
  const tmp = srcW / srcH < dstW / dstH ? resize(img, dstW, 0) : resize(img, 0, dstH);
  return cropAnchor(tmp, dstW, dstH, anchor);
}

export interface ThumbSize {
  width: number;
  height: number;
  mode: "" | "t" | "b" | "f";
}

// filesystem.go ThumbSizeRegex and the checks before the original is read
export function parseThumbSize(size: string): ThumbSize {
  const m = /^(\d+)x(\d+)(t|b|f)?$/.exec(size);
  if (!m) {
    throw new Error("thumb size must be in WxH, WxHt, WxHb or WxHf format");
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width === 0 && height === 0) {
    throw new Error("thumb width and height cannot be zero at the same time");
  }
  return { width, height, mode: (m[3] ?? "") as ThumbSize["mode"] };
}

// The resize step of createThumb
export function thumbGeometry(img: Raw, size: ThumbSize): Raw {
  const { width, height, mode } = size;
  if (width === 0 || height === 0) {
    return resize(img, width, height);
  }
  if (mode === "f") {
    return fit(img, width, height);
  }
  return fill(img, width, height, mode === "t" ? "top" : mode === "b" ? "bottom" : "center");
}

// The output format of createThumb for the original's content type
export function thumbFormat(contentType: string): "jpeg" | "gif" | "tiff" | "bmp" | "png" {
  switch (contentType) {
    case "image/jpeg":
      return "jpeg";
    case "image/gif":
      return "gif";
    case "image/tiff":
      return "tiff";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The same steps as thumbGeometry, as a plan for backends with their own
// resize: "crop" is in source pixels and comes before the resize of
// "crop-resize" and after the resize of "resize-crop".
export type ThumbPlan =
  | { kind: "copy" }
  | { kind: "resize"; width: number; height: number }
  | { kind: "crop-resize"; crop: Rect; width: number; height: number }
  | { kind: "resize-crop"; width: number; height: number; crop: Rect };

function anchorRect(w: number, h: number, cw: number, ch: number, anchor: Anchor): Rect {
  const [px, py] = anchorPt(w, h, cw, ch, anchor);
  const x0 = Math.max(0, px);
  const y0 = Math.max(0, py);
  return {
    x: x0,
    y: y0,
    width: Math.min(w, px + cw) - x0,
    height: Math.min(h, py + ch) - y0,
  };
}

function resizedSize(srcW: number, srcH: number, width: number, height: number): [number, number] {
  let dstW = width;
  let dstH = height;
  if (dstW === 0) {
    dstW = Math.trunc(Math.max(1, Math.floor((dstH * srcW) / srcH + 0.5)));
  }
  if (dstH === 0) {
    dstH = Math.trunc(Math.max(1, Math.floor((dstW * srcH) / srcW + 0.5)));
  }
  return [dstW, dstH];
}

export function thumbPlan(srcW: number, srcH: number, size: ThumbSize): ThumbPlan {
  const { width, height, mode } = size;
  const resizeTo = (w: number, h: number): ThumbPlan => {
    const [dw, dh] = resizedSize(srcW, srcH, w, h);
    return dw === srcW && dh === srcH
      ? { kind: "copy" }
      : { kind: "resize", width: dw, height: dh };
  };
  if (width === 0 || height === 0) {
    return resizeTo(width, height);
  }
  if (mode === "f") {
    if (srcW <= width && srcH <= height) {
      return { kind: "copy" };
    }
    const srcAspectRatio = srcW / srcH;
    if (srcAspectRatio > width / height) {
      return resizeTo(width, Math.trunc(width / srcAspectRatio));
    }
    return resizeTo(Math.trunc(height * srcAspectRatio), height);
  }
  const anchor: Anchor = mode === "t" ? "top" : mode === "b" ? "bottom" : "center";
  if (srcW === width && srcH === height) {
    return { kind: "copy" };
  }
  if (srcW >= 100 && srcH >= 100) {
    const c = fillCrop(srcW, srcH, width, height);
    return {
      kind: "crop-resize",
      crop: anchorRect(srcW, srcH, c.width, c.height, anchor),
      width,
      height,
    };
  }
  const [rw, rh] =
    srcW / srcH < width / height
      ? resizedSize(srcW, srcH, width, 0)
      : resizedSize(srcW, srcH, 0, height);
  return {
    kind: "resize-crop",
    width: rw,
    height: rh,
    crop: anchorRect(rw, rh, width, height, anchor),
  };
}

export function cropRect(img: Raw, r: Rect): Raw {
  const pix = new Uint8Array(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4;
    pix.set(img.pix.subarray(from, from + r.width * 4), y * r.width * 4);
  }
  return { width: r.width, height: r.height, pix };
}

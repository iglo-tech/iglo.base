// M0.7 spike: the parts of the candidate packages the spike calls. The
// packages are installed into scripts/spikes/M0.7/node_modules only while
// the spike runs (run.ts), so the repository typechecks without them.

declare module "*.wasm" {
  const path: string;
  export default path;
}

declare module "@jsquash/jpeg/decode.js" {
  export function init(module: WebAssembly.Module): Promise<void>;
  export default function decode(
    data: ArrayBuffer,
    options?: { preserveOrientation?: boolean },
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number }>;
}

declare module "@jsquash/jpeg/encode.js" {
  export function init(module: WebAssembly.Module): Promise<void>;
  export default function encode(
    data: { data: Uint8ClampedArray; width: number; height: number },
    options?: Record<string, unknown>,
  ): Promise<ArrayBuffer>;
}

declare module "@jsquash/png/decode.js" {
  export function init(module: WebAssembly.Module): Promise<unknown>;
  export default function decode(
    data: ArrayBuffer,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number }>;
}

declare module "@jsquash/png/encode.js" {
  export function init(module: WebAssembly.Module): Promise<unknown>;
  export default function encode(
    data: { data: Uint8ClampedArray; width: number; height: number },
    options?: Record<string, unknown>,
  ): Promise<ArrayBuffer>;
}

declare module "@jsquash/webp/decode.js" {
  export function init(module: WebAssembly.Module): Promise<void>;
  export default function decode(
    data: ArrayBuffer,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number }>;
}

declare module "omggif" {
  export class GifReader {
    constructor(data: Uint8Array);
    width: number;
    height: number;
    decodeAndBlitFrameRGBA(frame: number, pixels: Uint8Array): void;
    frameInfo(frame: number): { x: number; y: number; width: number; height: number };
  }
}

declare module "wasm-vips" {
  // the pipeline methods are vips operation names; the spike calls a few
  export interface VipsImage {
    width: number;
    height: number;
    autorot(): VipsImage;
    resize(scale: number, options?: Record<string, unknown>): VipsImage;
    crop(left: number, top: number, width: number, height: number): VipsImage;
    hasAlpha(): boolean;
    jpegsaveBuffer(options?: Record<string, unknown>): Uint8Array;
    pngsaveBuffer(options?: Record<string, unknown>): Uint8Array;
    gifsaveBuffer(options?: Record<string, unknown>): Uint8Array;
    delete(): void;
  }
  export interface Vips {
    Image: {
      newFromBuffer(
        data: Uint8Array,
        strOptions?: string,
        options?: Record<string, unknown>,
      ): VipsImage;
    };
    concurrency(n?: number): number;
    version(flag: number): number | string;
    Cache: { max(n: number): void };
  }
  export default function Vips(options?: Record<string, unknown>): Promise<Vips>;
}

declare module "sharp" {
  interface Sharp {
    rotate(): Sharp;
    resize(width: number, height: number, options?: Record<string, unknown>): Sharp;
    extract(region: { left: number; top: number; width: number; height: number }): Sharp;
    jpeg(options?: Record<string, unknown>): Sharp;
    png(options?: Record<string, unknown>): Sharp;
    gif(options?: Record<string, unknown>): Sharp;
    metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
    toBuffer(): Promise<Uint8Array>;
  }
  export default function sharp(input: Uint8Array, options?: Record<string, unknown>): Sharp;
}

declare module "@/../scripts/spikes/M0.7/node_modules/wasm-vips/lib/vips-node.mjs" {
  const path: string;
  export default path;
}

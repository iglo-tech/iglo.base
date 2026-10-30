// M0.7 spike: the contract every candidate implements. Not shipped.
//
// createThumb takes the original's bytes and stored content type and returns
// the thumb's bytes and content type, or throws where upstream's
// CreateThumb (tools/filesystem/filesystem.go) returns an error, after which
// apis/file.go serves the original.

export interface Thumb {
  bytes: Uint8Array;
  contentType: string;
}

export type CreateThumb = (
  input: Uint8Array,
  contentType: string,
  size: string,
  maxPixels: number,
) => Promise<Thumb>;

// upstream's error text for an original over PB_THUMBS_MAX_SOURCE_PIXELS
export function checkPixels(width: number, height: number, maxPixels: number): void {
  if (width * height > maxPixels) {
    throw new Error(
      `the original image is too large (${width}x${height}) and exceeds the total max allowed ${maxPixels} pixels`,
    );
  }
}

// the content type createThumb stores the thumb with
export function thumbContentType(contentType: string): string {
  return ["image/jpeg", "image/gif", "image/tiff", "image/bmp"].includes(contentType)
    ? contentType
    : "image/png";
}

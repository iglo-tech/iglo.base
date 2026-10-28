// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/geo.go.

import { beUint32, hasPrefix, leUint32 } from "@/tools/mimetype/go-bytes";

const shapeTypes = [
  0, // Null shape
  1, // Point
  3, // Polyline
  5, // Polygon
  8, // MultiPoint
  11, // PointZ
  13, // PolylineZ
  15, // PolygonZ
  18, // MultiPointZ
  21, // PointM
  23, // PolylineM
  25, // PolygonM
  28, // MultiPointM
  31, // MultiPatch
];

// Shp matches a shape format file.
// https://www.esri.com/library/whitepapers/pdfs/shapefile.pdf
export function Shp(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 112) {
    return false;
  }

  if (
    beUint32(raw, 0) !== 9994 ||
    beUint32(raw, 4) !== 0 ||
    beUint32(raw, 8) !== 0 ||
    beUint32(raw, 12) !== 0 ||
    beUint32(raw, 16) !== 0 ||
    beUint32(raw, 20) !== 0 ||
    leUint32(raw, 28) !== 1000
  ) {
    return false;
  }

  return shapeTypes.includes(leUint32(raw, 108));
}

const shxSig = Uint8Array.of(0x00, 0x00, 0x27, 0x0a);
// Shx matches a shape index format file.
// https://www.esri.com/library/whitepapers/pdfs/shapefile.pdf
export function Shx(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, shxSig);
}

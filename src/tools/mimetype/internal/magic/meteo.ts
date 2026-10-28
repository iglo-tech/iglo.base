// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/meteo.go.

import { hasPrefix, lit } from "@/tools/mimetype/go-bytes";

const gribSig = lit("GRIB");
// GRIB matches a GRIdded Binary meteorological file.
// https://www.nco.ncep.noaa.gov/pmb/docs/on388/
// https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/
export function GRIB(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 7 && hasPrefix(raw, gribSig) && (raw[7] === 1 || raw[7] === 2);
}

const bufrSig = lit("BUFR");
// BUFR matches meteorological data format for storing point or time series data.
// https://confluence.ecmwf.int/download/attachments/31064617/ecCodes_BUFR_in_a_nutshell.pdf?version=1&modificationDate=1457000352419&api=v2
export function BUFR(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 7 && hasPrefix(raw, bufrSig) && (raw[7] === 0x03 || raw[7] === 0x04);
}

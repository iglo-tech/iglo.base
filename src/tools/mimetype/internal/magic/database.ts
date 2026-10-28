// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/database.go.

import { hasPrefix, lit } from "@/tools/mimetype/go-bytes";
import { offset } from "@/tools/mimetype/internal/magic/magic";

// prettier-ignore
const sqliteSig = Uint8Array.of(
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
);
// Sqlite matches an SQLite database file.
export function Sqlite(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, sqliteSig);
}

const aceSig = lit("Standard ACE DB");
// MsAccessAce matches Microsoft Access dababase file.
export function MsAccessAce(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, aceSig, 4);
}

const jetSig = lit("Standard Jet DB");
// MsAccessMdb matches legacy Microsoft Access database file (JET, 2003 and earlier).
export function MsAccessMdb(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, jetSig, 4);
}

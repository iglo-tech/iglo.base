// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/ftyp.go.

import { equal, lit } from "@/tools/mimetype/go-bytes";
import { ftyp } from "@/tools/mimetype/internal/magic/magic";

const sigs = (...s: string[]) => s.map(lit);

const avifSigs = sigs("avif", "avis");
// AVIF matches an AV1 Image File Format still or animated.
// Wikipedia page seems outdated listing image/avif-sequence for animations.
// https://github.com/AOMediaCodec/av1-avif/issues/59
export function AVIF(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...avifSigs);
}

// prettier-ignore
const threeGPSigs = sigs(
  "3gp1", "3gp2", "3gp3", "3gp4",
  "3gp5", "3gp6", "3gp7", "3gs7",
  "3ge6", "3ge7", "3gg6",
);
// ThreeGP matches a 3GPP file.
export function ThreeGP(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...threeGPSigs);
}

// prettier-ignore
const threeG2Sigs = sigs(
  "3g24", "3g25", "3g26", "3g2a",
  "3g2b", "3g2c", "KDDI",
);
// ThreeG2 matches a 3GPP2 file.
export function ThreeG2(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...threeG2Sigs);
}

const aMp4Sigs = sigs(
  // audio for Adobe Flash Player 9+
  "F4A ",
  "F4B ",
  // Apple iTunes AAC-LC (.M4A) Audio
  "M4B ",
  "M4P ",
  // MPEG-4 (.MP4) for SonyPSP
  "MSNV",
  // Nero Digital AAC Audio
  "NDAS",
);
// AMp4 matches an audio MP4 file.
export function AMp4(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...aMp4Sigs);
}

const mqvSigs = sigs("mqt ");
// Mqv matches a Sony / Mobile QuickTime  file.
export function Mqv(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...mqvSigs);
}

const m4aSigs = sigs("M4A ");
// M4a matches an audio M4A file.
export function M4a(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...m4aSigs);
}

const m4vSigs = sigs("M4V ", "M4VH", "M4VP");
// M4v matches an Appl4 M4V video file.
export function M4v(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...m4vSigs);
}

const heicSigs = sigs("heic", "heix");
// Heic matches a High Efficiency Image Coding (HEIC) file.
export function Heic(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...heicSigs);
}

const heicSequenceSigs = sigs("hevc", "hevx");
// HeicSequence matches a High Efficiency Image Coding (HEIC) file sequence.
export function HeicSequence(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...heicSequenceSigs);
}

const heifSigs = sigs("mif1", "heim", "heis", "avic");
// Heif matches a High Efficiency Image File Format (HEIF) file.
export function Heif(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...heifSigs);
}

const heifSequenceSigs = sigs("msf1", "hevm", "hevs", "avcs");
// HeifSequence matches a High Efficiency Image File Format (HEIF) file sequence.
export function HeifSequence(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...heifSequenceSigs);
}

const mj2Sigs = sigs("mj2s", "mjp2", "MFSM", "MGSV");
// Mj2 matches a Motion JPEG 2000 file: https://en.wikipedia.org/wiki/Motion_JPEG_2000.
export function Mj2(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...mj2Sigs);
}

// prettier-ignore
const dvbSigs = sigs(
  "dby1", "dsms", "dts1", "dts2",
  "dts3", "dxo ", "dmb1", "dmpf",
  "drc1", "dv1a", "dv1b", "dv2a",
  "dv2b", "dv3a", "dv3b", "dvr1",
  "dvt1", "emsg",
);
// Dvb matches a Digital Video Broadcasting file: https://dvb.org.
// https://cconcolato.github.io/mp4ra/filetype.html
// https://github.com/file/file/blob/512840337ead1076519332d24fefcaa8fac36e06/magic/Magdir/animation#L135-L154
export function Dvb(raw: Uint8Array, _limit: number): boolean {
  return ftyp(raw, ...dvbSigs);
}

// TODO: add support for remaining video formats at ftyps.com.

const ftypQt = lit("ftypqt  ");
const ftypMoov = lit("ftypmoov");
const basicAtomTypes = sigs("moov\x00", "mdat\x00", "free\x00", "skip\x00", "pnot\x00");
const wide = lit("\x00\x00\x00\x08wide");

// QuickTime matches a QuickTime File Format file.
// https://www.loc.gov/preservation/digital/formats/fdd/fdd000052.shtml
// https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap1/qtff1.html#//apple_ref/doc/uid/TP40000939-CH203-38190
// https://github.com/apache/tika/blob/0f5570691133c75ac4472c3340354a6c4080b104/tika-core/src/main/resources/org/apache/tika/mime/tika-mimetypes.xml#L7758-L7777
export function QuickTime(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 12) {
    return false;
  }
  // First 4 bytes represent the size of the atom as unsigned int.
  // Next 4 bytes are the type of the atom.
  // For `ftyp` atoms check if first byte in size is 0, otherwise, a text file
  // which happens to contain 'ftypqt  ' at index 4 will trigger a false positive.
  if (equal(raw.subarray(4, 12), ftypQt) || equal(raw.subarray(4, 12), ftypMoov)) {
    return raw[0] === 0x00;
  }
  for (const a of basicAtomTypes) {
    if (equal(raw.subarray(4, 9), a)) {
      return true;
    }
  }
  return equal(raw.subarray(0, 8), wide);
}

const ftypBox = lit("ftyp");
// Mp4 detects an .mp4 file. Mp4 detections only does a basic ftyp check.
// Mp4 has many registered and unregistered code points so it's hard to keep track
// of all. Detection will default on video/mp4 for all ftyp files.
// ISO_IEC_14496-12 is the specification for the iso container.
export function Mp4(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 12) {
    return false;
  }
  // ftyps are made out of boxes. The first 4 bytes of the box represent
  // its size in big-endian uint32. First box is the ftyp box and it is small
  // in size. Check most significant byte is 0 to filter out false positive
  // text files that happen to contain the string "ftyp" at index 4.
  if (raw[0] !== 0) {
    return false;
  }
  return equal(raw.subarray(4, 8), ftypBox);
}

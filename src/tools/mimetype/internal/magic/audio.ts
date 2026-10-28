// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/audio.go.

import { beUint16, equal, hasPrefix, lit } from "@/tools/mimetype/go-bytes";
import { extractFrame } from "@/tools/mimetype/internal/mp3/frame";

const flacSig = lit("\x66\x4C\x61\x43\x00\x00\x00\x22");
// Flac matches a Free Lossless Audio Codec file.
export function Flac(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, flacSig);
}

const midiSig = lit("\x4D\x54\x68\x64");
// Midi matches a Musical Instrument Digital Interface file.
export function Midi(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, midiSig);
}

const apeSig = lit("\x4D\x41\x43\x20\x96\x0F\x00\x00\x34\x00\x00\x00\x18\x00\x00\x00\x90\xE3");
// Ape matches a Monkey's Audio file.
export function Ape(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, apeSig);
}

const mpckSig = lit("MPCK");
// MusePack matches a Musepack file.
export function MusePack(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, mpckSig);
}

const auSig = lit("\x2E\x73\x6E\x64");
// Au matches a Sun Microsystems au file.
export function Au(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, auSig);
}

const amrSig = lit("\x23\x21\x41\x4D\x52");
// Amr matches an Adaptive Multi-Rate file.
export function Amr(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, amrSig);
}

const vocSig = lit("Creative Voice File");
// Voc matches a Creative Voice file.
export function Voc(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, vocSig);
}

const m3uLF = lit("#EXTM3U\n");
const m3uCRLF = lit("#EXTM3U\r\n");
// M3U matches a Playlist file.
export function M3U(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, m3uLF) || hasPrefix(raw, m3uCRLF);
}

// AAC matches an Advanced Audio Coding file.
export function AAC(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 1 && ((raw[0] === 0xff && raw[1] === 0xf1) || (raw[0] === 0xff && raw[1] === 0xf9))
  );
}

const mo3Sig = lit("MO3");
const swaSig = Uint8Array.of(0x00, 0x00, 0x01, 0x40, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00);

// MP3 matches a .mp3 file.
export function MP3(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 3) {
    return false;
  }

  // Any ID3v2 is reported as MP3. Not entirely correct, but the mimesniff
  // standard says so. https://mimesniff.spec.whatwg.org/#matching-an-audio-or-video-type-pattern
  // Despite the standard only checking for "ID3", we do more validations to
  // avoid false positives.
  if (id3v2(raw)) {
    return true;
  }

  // If no ID3v2 tag found, then we will look for MP3 frames, but:
  // a. Layer III files are a lot more prevalent than Layer I and II.
  // b. Layer I frame header has looser constraints than the others: many files
  // with regularly repeating 0xFFFF bytes can be misidentified as MP3.
  // c. MP3 files are composed of individual frames and those frames can have
  // leading garbage bytes: if we want to find all valid MP3s, we have to do a
  // linear search. #775, #310
  // d. There are file formats that contain MP3s inside: .mo3 and .swa
  //
  // Given a, b, c and d, this code:
  // - initially tries to match by first two bytes in header
  // - checks for .mo3 and .swa and disqualifies them
  // - does linear search for Layer III
  switch (beUint16(raw, 0) & 0xfffe) {
    case 0xfffa:
    case 0xfff2:
    case 0xffe2: // layer III: v1, v2, v2.5
    case 0xfffc:
    case 0xfff4: // layer II: v1, v2
    case 0xfff5: // layer I: v2
      return true;
  }
  // http://lclevy.free.fr/mo3/
  if (hasPrefix(raw, mo3Sig)) {
    return false;
  }

  // From PRONOM:
  // Macromedia licensed the MP3 technology in 1995 to use in their Shockwave
  // product. .swa or Shockwave Audio was originally added as a free plugin
  // (Xtras) to SoundEdit 16 to export AIFF files to .swa.
  // There is no media type assigned for .swa.
  if (hasPrefix(raw, swaSig)) {
    return false;
  }

  const [, size] = extractFrame(raw);
  return size > 0;
}

const id3Sig = lit("ID3");

// Based on https://id3.org/Developer%20Information.
function id3v2(raw: Uint8Array): boolean {
  if (raw.length < 10 || !hasPrefix(raw, id3Sig)) {
    return false;
  }
  const version = raw[3] as number;
  if (version < 2 || version > 4) {
    // Version: ID3v2.2 - ID3v2.4.
    return false;
  }
  if (raw[4] !== 0) {
    // Revision is 0 for all versions.
    return false;
  }

  // v2.2 uses 2 bits, v2.3 uses 3 bits and v2.4 uses 4.
  // For all versions least significant 4 bits should be 0
  if (((raw[5] as number) & 0b1111) !== 0) {
    return false;
  }

  const s6 = raw[6] as number;
  const s7 = raw[7] as number;
  const s8 = raw[8] as number;
  const s9 = raw[9] as number;
  // Size bytes are synchsafe: most significant bit always 0.
  if ((s6 & 0x80) !== 0 || (s7 & 0x80) !== 0 || (s8 & 0x80) !== 0 || (s9 & 0x80) !== 0) {
    return false;
  }

  const size = (s6 << 21) | (s7 << 14) | (s8 << 7) | s9;
  // Disallow too big frames, let's say 10MB.
  return size > 0 && size < 10 * 1024 * 1024;
}

const riff = lit("RIFF");
const wave = Uint8Array.of(0x57, 0x41, 0x56, 0x45);
// Wav matches a Waveform Audio File Format file.
export function Wav(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 12 && equal(raw.subarray(0, 4), riff) && equal(raw.subarray(8, 12), wave);
}

const form = Uint8Array.of(0x46, 0x4f, 0x52, 0x4d);
const aiff = Uint8Array.of(0x41, 0x49, 0x46, 0x46);
// Aiff matches Audio Interchange File Format file.
export function Aiff(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 12 && equal(raw.subarray(0, 4), form) && equal(raw.subarray(8, 12), aiff);
}

const qlcm = lit("QLCM");
// Qcp matches a Qualcomm Pure Voice file.
export function Qcp(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 12 && equal(raw.subarray(0, 4), riff) && equal(raw.subarray(8, 12), qlcm);
}

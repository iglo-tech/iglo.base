// Upstream: gabriel-vasile/mimetype v1.4.16 internal/magic/audio.go.

import { beUint16, equal, hasPrefix, lit } from "@/tools/mimetype/go-bytes";
import { extractFrame } from "@/tools/mimetype/internal/mp3/frame";

const flacSig = lit("\u0066\u004C\u0061\u0043\u0000\u0000\u0000\u0022");
// Flac matches a Free Lossless Audio Codec file.
export function Flac(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, flacSig);
}

const midiSig = lit("\u004D\u0054\u0068\u0064");
// Midi matches a Musical Instrument Digital Interface file.
export function Midi(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, midiSig);
}

const apeSig = lit(
  "\u004D\u0041\u0043\u0020\u0096\u000F\u0000\u0000\u0034\u0000\u0000\u0000\u0018\u0000\u0000\u0000\u0090\u00E3",
);
// Ape matches a Monkey's Audio file.
export function Ape(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, apeSig);
}

const mpckSig = lit("MPCK");
// MusePack matches a Musepack file.
export function MusePack(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, mpckSig);
}

const auSig = lit("\u002E\u0073\u006E\u0064");
// Au matches a Sun Microsystems au file.
export function Au(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, auSig);
}

const amrSig = lit("\u0023\u0021\u0041\u004D\u0052");
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
  return raw.length > 1 && raw[0] === 0xff && (raw[1] === 0xf1 || raw[1] === 0xf9);
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
  switch (beUint16(raw, 0) & 0xff_fe) {
    case 0xff_fa:
    case 0xff_f2:
    case 0xff_e2: // layer III: v1, v2, v2.5
    case 0xff_fc:
    case 0xff_f4: // layer II: v1, v2
    case 0xff_f5: // layer I: v2
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
  // The synchsafe integer is already bounded to 28 bits (~256MB). A 10MB
  // cap rejected legitimate files with large ID3v2 album art. #839
  return size > 0;
}

// iff checks for an Interchange File Format layout: 4-byte container tag,
// 4-byte size, 4-byte format tag. It is shared with image.go's Webp.
export function iff(raw: Uint8Array, container: Uint8Array, format: Uint8Array): boolean {
  return (
    raw.length > 12 && equal(raw.subarray(0, 4), container) && equal(raw.subarray(8, 12), format)
  );
}

const riff = lit("RIFF");
const wave = lit("WAVE");
// Wav matches a Waveform Audio File Format file.
export function Wav(raw: Uint8Array, _limit: number): boolean {
  return iff(raw, riff, wave);
}

const form = lit("FORM");
const aiff = lit("AIFF");
// Aiff matches Audio Interchange File Format file.
export function Aiff(raw: Uint8Array, _limit: number): boolean {
  return iff(raw, form, aiff);
}

const qlcm = lit("QLCM");
// Qcp matches a Qualcomm Pure Voice file.
export function Qcp(raw: Uint8Array, _limit: number): boolean {
  return iff(raw, riff, qlcm);
}

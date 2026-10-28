// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/video.go.

import { equal, hasPrefix, index, lit } from "@/tools/mimetype/go-bytes";

const flvSig = lit("\x46\x4C\x56\x01");
// Flv matches a Flash video file.
export function Flv(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, flvSig);
}

const asfSig = Uint8Array.of(
  0x30,
  0x26,
  0xb2,
  0x75,
  0x8e,
  0x66,
  0xcf,
  0x11,
  0xa6,
  0xd9,
  0x00,
  0xaa,
  0x00,
  0x62,
  0xce,
  0x6c,
);
// Asf matches an Advanced Systems Format file.
export function Asf(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, asfSig);
}

const rmvbSig = Uint8Array.of(0x2e, 0x52, 0x4d, 0x46);
// Rmvb matches a RealMedia Variable Bitrate file.
export function Rmvb(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, rmvbSig);
}

const webm = lit("webm");
// WebM matches a WebM file.
export function WebM(raw: Uint8Array, _limit: number): boolean {
  return isMatroskaFileTypeMatched(raw, webm);
}

const matroska = lit("matroska");
// Mkv matches a mkv file.
export function Mkv(raw: Uint8Array, _limit: number): boolean {
  return isMatroskaFileTypeMatched(raw, matroska);
}

const ebmlSig = lit("\x1A\x45\xDF\xA3");
// isMatroskaFileTypeMatched is used for webm and mkv file matching.
// It checks for .Eß£ sequence. If the sequence is found,
// then it means it is Matroska media container, including WebM.
// Then it verifies which of the file type it is representing by matching the
// file specific string.
function isMatroskaFileTypeMatched(input: Uint8Array, flType: Uint8Array): boolean {
  if (hasPrefix(input, ebmlSig)) {
    return isFileTypeNamePresent(input, flType);
  }
  return false;
}

const docTypeID = lit("\x42\x82");
// isFileTypeNamePresent accepts the matroska input data stream and searches
// for the given file type in the stream. Return whether a match is found.
// The logic of search is: find first instance of \x42\x82 and then
// search for given string after n bytes of above instance.
function isFileTypeNamePresent(input: Uint8Array, flType: Uint8Array): boolean {
  const lenIn = input.length;
  const maxInd = Math.min(4096, lenIn);
  let ind = index(input.subarray(0, maxInd), docTypeID);
  if (ind > 0 && lenIn > ind + 2) {
    ind += 2;

    // filetype name will be present exactly
    // n bytes after the match of the two bytes "\x42\x82"
    const n = vintWidth(input[ind] as number);
    if (lenIn > ind + n) {
      return hasPrefix(input.subarray(ind + n), flType);
    }
  }
  return false;
}

// vintWidth parses the variable-integer width in matroska containers
function vintWidth(v: number): number {
  let mask = 128;
  const nTimes = 8;
  let num = 1;
  while (num < nTimes && (v & mask) === 0) {
    mask >>= 1;
    num++;
  }
  return num;
}

const mpegSig = Uint8Array.of(0x00, 0x00, 0x01);
// Mpeg matches a Moving Picture Experts Group file.
export function Mpeg(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 3 &&
    hasPrefix(raw, mpegSig) &&
    (raw[3] as number) >= 0xb0 &&
    (raw[3] as number) <= 0xbf
  );
}

const riff = lit("RIFF");
const aviList = lit("AVI LIST");
// Avi matches an Audio Video Interleaved file.
export function Avi(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 16 && equal(raw.subarray(0, 4), riff) && equal(raw.subarray(8, 16), aviList);
}

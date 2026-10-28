// Upstream: gabriel-vasile/mimetype v1.4.15 internal/mp3/frame.go.

// minTruncatedSyncMatches is the minimum number of confirmed successive
// header matches required to accept a candidate frame when the buffer ends
// before maxFrameSyncMatches confirmations can be performed.
const minTruncatedSyncMatches = 2;

export function extractFrame(b: Uint8Array): [start: number, size: number] {
  const limit = Math.min(b.length, 2048 + headerSize);
  for (let i = 0; i < limit - headerSize; i++) {
    // bytes.IndexByte(b[i:limit-headerSize], 0xFF)
    const j = b.indexOf(0xff, i);
    if (j < 0 || j >= limit - headerSize) {
      break;
    }
    i = j;
    const hdr = new header(b, i);
    if (!hdr.valid()) {
      continue;
    }
    const frameBytes = hdr.frameBytes();
    const frameAndPad = frameBytes + hdr.padding();

    const validHere = frameBytes > 0 && i + frameAndPad <= b.length && matchFrame(b.subarray(i));
    // When the buffer is exactly one frame, matchFrame cannot look ahead for
    // a subsequent header to confirm the stream. Trust the validated header.
    const exact = i === 0 && frameAndPad === b.length;
    if (validHere || exact) {
      return [i, frameAndPad];
    }
  }
  return [0, 0];
}

// matchFrame confirms a candidate header by stepping forward and checking that
// subsequent headers are consistent.
function matchFrame(buf: Uint8Array): boolean {
  // maxFrameSyncMatches limits how many valid frames we look at.
  const maxFrameSyncMatches = 10;
  const hdr = new header(buf, 0);
  let i = hdr.frameBytes() + hdr.padding();
  for (let nmatch = 0; nmatch < maxFrameSyncMatches; nmatch++) {
    if (i + headerSize > buf.length) {
      return nmatch >= minTruncatedSyncMatches;
    }
    const cmp = new header(buf, i);
    if (!hdr.compatibleWith(cmp)) {
      return false;
    }
    i += cmp.frameBytes() + cmp.padding();
  }
  return true;
}

const headerSize = 4;

// header is Go's [4]byte: the four bytes at off in b.
export class header {
  0: number;
  1: number;
  2: number;
  3: number;

  constructor(b: ArrayLike<number>, off = 0) {
    this[0] = b[off] as number;
    this[1] = b[off + 1] as number;
    this[2] = b[off + 2] as number;
    this[3] = b[off + 3] as number;
  }

  isFreeFormat(): boolean {
    return (this[2] & 0xf0) === 0;
  }
  isMPEG1(): boolean {
    return (this[1] & 0x8) !== 0;
  }
  isMPEG25(): boolean {
    return (this[1] & 0x10) === 0;
  }
  rawLayer(): number {
    return (this[1] >> 1) & 3;
  }
  rawBitrate(): number {
    return this[2] >> 4;
  }
  rawSampleRate(): number {
    return (this[2] >> 2) & 3;
  }
  rawEmphasis(): number {
    return this[3] & 0b11;
  }
  isFrame576(): boolean {
    return (this[1] & 14) === 2;
  }
  padding(): number {
    if ((this[2] & 0x2) !== 0) {
      return 1;
    }
    return 0;
  }

  // valid reports whether the four bytes form a syntactically valid MP3 header.
  valid(): boolean {
    return (
      this[0] === 0xff &&
      ((this[1] & 0xf0) === 0xf0 || (this[1] & 0xfe) === 0xe2) &&
      this.rawLayer() === 1 && // Layer III
      this.rawBitrate() !== 15 && // Not allowed by spec.
      this.rawSampleRate() !== 3 &&
      this.rawEmphasis() !== 2 &&
      // The code for extracting frame size for free-format is tedious and
      // free-format MP3s are extinct.
      !this.isFreeFormat()
    );
  }

  // compatibleWith reports whether two headers describe frames belonging to the
  // same MP3 stream — same MPEG version, layer, sample-rate index.
  compatibleWith(o: header): boolean {
    return o.valid() && ((this[1] ^ o[1]) & 0xfe) === 0 && ((this[2] ^ o[2]) & 0x0c) === 0;
  }

  // bitrateKbps returns the bitrate of the frame in kilobits per second.
  bitrateKbps(): number {
    // halfrate[mpeg1?][bitrate_idx] holds bitrate/2 in kbps.
    const halfrate = [
      [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80],
      [0, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160],
    ];
    const mpeg1 = this.isMPEG1() ? 1 : 0;
    return 2 * ((halfrate[mpeg1] as number[])[this.rawBitrate()] as number);
  }

  // sampleRateHz returns the sampling rate of the frame in Hz.
  sampleRateHz(): number {
    let base = [44100, 48000, 32000][this.rawSampleRate()] as number;
    if (!this.isMPEG1()) {
      base >>= 1;
    }
    if (this.isMPEG25()) {
      base >>= 1;
    }
    return base;
  }

  // frameSamples returns the number of audio samples per channel encoded in
  // the frame.
  frameSamples(): number {
    if (this.isFrame576()) {
      return 576;
    }
    return 1152;
  }

  // frameBytes returns the size of the frame body (header + side info + audio
  // data, excluding padding) in bytes.
  frameBytes(): number {
    const br = this.bitrateKbps();
    const sr = this.sampleRateHz();
    if (br === 0 || sr === 0) {
      return 0;
    }
    return Math.trunc((this.frameSamples() * br * 125) / sr);
  }
}

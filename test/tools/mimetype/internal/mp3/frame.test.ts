// Upstream: gabriel-vasile/mimetype v1.4.15 internal/mp3/frame_test.go

import { describe, expect, test } from "bun:test";

import { extractFrame, header } from "@/tools/mimetype/internal/mp3/frame";

// buildFrame constructs a 4-byte MP3 frame header with the given parameters.
// version: 0=MPEG2.5, 2=MPEG2, 3=MPEG1
// layer:   1=Layer3, 2=Layer2, 3=Layer1
// bitrateIdx: index into bitrates table (1-14 for valid)
// sampleRateIdx: 0-2 for valid
function buildFrame(
  version: number,
  layer: number,
  bitrateIdx: number,
  sampleRateIdx: number,
): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = 0xff;
  b[1] = 0xe0 | (version << 3) | (layer << 1) | 0x01; // crc bit set
  b[2] = (bitrateIdx << 4) | (sampleRateIdx << 2);
  b[3] = 0x00; // no emphasis, stereo, not copyrighted, not original
  return b;
}

function bytesToHeader(b: Uint8Array): header {
  return new header(b, 0);
}

// buildValidMP3Header builds a known-good MPEG2.5 Layer3 frame header.
// MPEG2.5 (version=0), Layer3, bitrate index 1 (8 kbps), sample rate index 2
// (8000 Hz). That yields 72-byte frames, which is small enough to keep tests
// fast while exercising real frame-size arithmetic.
function buildValidMP3Header(): Uint8Array {
  return buildFrame(0, 1, 1, 2);
}

// copyInto copies src into the start of dst, like Go's copy.
function copyInto(dst: Uint8Array, src: Uint8Array): void {
  dst.set(src.subarray(0, Math.min(dst.length, src.length)));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// repeatFrames builds a byte slice with `count` consecutive valid frames,
// each padded to `frameSize` bytes total. The Go helper can also fill the
// padding with ChaCha8 random bytes; the test table only uses zero padding.
function repeatFrames(hdr: Uint8Array, frameSize: number, count: number): Uint8Array {
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const frame = new Uint8Array(frameSize);
    copyInto(frame.subarray(0, 4), hdr);
    out.push(frame);
  }
  return concat(...out);
}

// zeros is Go's make([]byte, n).
const zeros = (n: number): Uint8Array => new Uint8Array(n);

// repeatBytes is Go's bytes.Repeat([]byte{c}, n).
const repeatBytes = (c: number, n: number): Uint8Array => new Uint8Array(n).fill(c);

describe("TestExtractFrame", () => {
  const validHeader = buildValidMP3Header();

  const frameSize = 72;
  // Matches how many bytes the implementation searches for.
  const mp3MaxSearch = 2048;

  const tests: { name: string; data: Uint8Array; want: boolean }[] = [
    {
      name: "four consecutive valid frames, no padding",
      data: repeatFrames(validHeader, frameSize, 4),
      want: true,
    },
    {
      name: "four valid frames with leading 0x00 padding",
      data: concat(zeros(100), repeatFrames(validHeader, frameSize, 4)),
      want: true,
    },
    {
      name: "four valid frames with leading 0xFF padding",
      data: concat(repeatBytes(0xff, 100), repeatFrames(validHeader, frameSize, 4)),
      want: true,
    },
    {
      name: "four valid frames with leading 2047 0x00 bytes padding",
      data: concat(repeatBytes(0x00, 2047), repeatFrames(validHeader, frameSize, 4)),
      want: true,
    },
    {
      name: "four valid frames with leading 2048 0x00 bytes padding",
      data: concat(repeatBytes(0x00, 2048), repeatFrames(validHeader, frameSize, 4)),
      want: false,
    },
    {
      name: "only two valid frames (below threshold)",
      data: repeatFrames(validHeader, frameSize, 2),
      want: false,
    },
    {
      name: "empty input",
      data: Uint8Array.of(),
      want: false,
    },
    {
      name: "all zeros, no sync byte",
      data: zeros(1024),
      want: false,
    },
    {
      name: "0xFF bytes but no valid frame follows",
      data: Uint8Array.of(0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00),
      want: false,
    },
    {
      name: "leading padding exceeds mp3MaxSearch before first frame",
      data: concat(zeros(mp3MaxSearch + 1), repeatFrames(validHeader, frameSize, 4)),
      want: false,
    },
    {
      // mp3MaxSearch-4 bytes of zeros, then a valid frame starting with 0xFF
      name: "leading padding exactly at mp3MaxSearch boundary",
      data: concat(zeros(mp3MaxSearch - 4), repeatFrames(validHeader, frameSize, 4)),
      want: true,
    },
    {
      name: "4 headers with padding",
      data: (() => {
        const padded = validHeader.slice();
        padded[2] = (padded[2] ?? 0) | 0x2;
        return repeatFrames(padded, frameSize + 1, 4);
      })(),
      want: true,
    },
    {
      name: "11 headers to have more than maxFrameSyncMatches",
      data: repeatFrames(validHeader, frameSize, 11),
      want: true,
    },
    {
      name: "second frame header is not valid",
      data: (() => {
        const f1 = buildFrame(3, 1, 9, 0);
        const f2 = buildFrame(0, 0, 0, 0);
        const frame1 = zeros(bytesToHeader(f1).frameBytes());
        const frame2 = zeros(frameSize);
        copyInto(frame1, f1);
        copyInto(frame2, f2);
        return concat(frame1, frame2);
      })(),
      want: false,
    },
    {
      // First frame: MPEG1 (version=3), second frame: MPEG2 (version=2)
      name: "mismatched second frame version",
      data: (() => {
        const f1 = buildFrame(3, 1, 9, 0);
        const f2 = buildFrame(2, 1, 9, 0);
        const frame1 = zeros(bytesToHeader(f1).frameBytes());
        const frame2 = zeros(bytesToHeader(f2).frameBytes());
        copyInto(frame1, f1);
        copyInto(frame2, f2);
        return concat(frame1, frame2);
      })(),
      want: false,
    },
    {
      name: "invalid emphasis byte (reserved value 2)",
      data: (() => {
        const h = zeros(4);
        copyInto(h, validHeader);
        h[3] = 0x02; // emphasis = 2 (reserved)
        return repeatFrames(h, frameSize, 4);
      })(),
      want: false,
    },
    {
      name: "invalid layer (reserved value 0)",
      data: (() => {
        const h = zeros(4);
        copyInto(h, validHeader);
        h[1] = (h[1] ?? 0) & 0xf9; // layer bits = 00 (reserved)
        return repeatFrames(h, frameSize, 4);
      })(),
      want: false,
    },
    {
      name: "invalid version (reserved value 1)",
      data: (() => {
        const h = zeros(4);
        copyInto(h, validHeader);
        h[1] = ((h[1] ?? 0) & 0xe7) | (1 << 3); // version bits = 01 (reserved)
        return repeatFrames(h, frameSize, 4);
      })(),
      want: false,
    },
    {
      name: "invalid sample rate index (0x03 = reserved)",
      data: (() => {
        const h = zeros(4);
        copyInto(h, validHeader);
        h[2] = ((h[2] ?? 0) & 0xf0) | 0x0c; // sampleRateIdx = 3
        return repeatFrames(h, frameSize, 4);
      })(),
      want: false,
    },
    {
      name: "invalid bitrate index (0x0F = bad)",
      data: (() => {
        const h = zeros(4);
        copyInto(h, validHeader);
        h[2] = ((h[2] ?? 0) & 0x0f) | 0xf0; // bitrateIdx = 15
        return repeatFrames(h, frameSize, 4);
      })(),
      want: false,
    },
    {
      name: "input shorter than one frame header",
      data: Uint8Array.of(0xff, 0xfb),
      want: false,
    },
  ];

  for (const tt of tests) {
    test(tt.name, () => {
      const [, size] = extractFrame(tt.data);
      expect(size !== 0).toBe(tt.want);
    });
  }
});

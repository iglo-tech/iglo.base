// Reads a zip's central directory as a plain zip reader sees it, for
// comparing what two writers stored. Test code only; no Zip64.

export interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  // the Unix mode
  mode: number;
  // the Unix seconds of the extended timestamp, 0 without one
  modTime: number;
}

const endSignature = 0x06054b50;

export function centralEntries(zip: Uint8Array): CentralEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.length);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== endSignature) {
    end--;
  }
  if (end < 0) {
    throw new Error("no end record");
  }

  const entries: CentralEntry[] = [];
  let p = view.getUint32(end + 16, true);
  for (let i = view.getUint16(end + 10, true); i > 0; i--) {
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));

    let modTime = 0;
    for (let q = p + 46 + nameLen; q + 4 <= p + 46 + nameLen + extraLen;) {
      const size = view.getUint16(q + 2, true);
      if (view.getUint16(q, true) === 0x5455) {
        modTime = view.getUint32(q + 5, true);
      }
      q += 4 + size;
    }

    entries.push({
      name,
      method: view.getUint16(p + 10, true),
      flags: view.getUint16(p + 8, true),
      mode: view.getUint32(p + 38, true) >>> 16,
      modTime,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Upstream: ui/embed.go (the dashboard build embedded as an fs.FS).
//
// The dashboard build (ui/dist) is embedded in the executable as one file,
// dist/ui.pack, written by scripts/ui/build.ts: a 4-byte little-endian
// index length, the JSON index ({"source": <inputs hash>, "files":
// {"<path>": [offset, size]}}, offsets after the index) and the file
// contents. readUiPack gives the read-only file system the dashboard
// routes serve (@/apis/serve-ui).

export interface StaticFS {
  // the file contents, or undefined when the path is not a file
  file(path: string): Uint8Array | undefined;
  // whether the path is a directory ("." is the root)
  isDir(path: string): boolean;
}

interface PackIndex {
  source: string;
  files: Record<string, [number, number]>;
}

export function writeUiPack(source: string, files: Map<string, Uint8Array>): Uint8Array {
  const index: PackIndex = { source, files: {} };
  let offset = 0;
  const names = [...files.keys()].toSorted();
  for (const name of names) {
    const size = files.get(name)?.length ?? 0;
    index.files[name] = [offset, size];
    offset += size;
  }
  const head = new TextEncoder().encode(JSON.stringify(index));
  const out = new Uint8Array(4 + head.length + offset);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const name of names) {
    const data = files.get(name) ?? new Uint8Array();
    out.set(data, at);
    at += data.length;
  }
  return out;
}

function readIndex(pack: Uint8Array): { index: PackIndex; dataStart: number } {
  const length = new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(pack.subarray(4, 4 + length))) as PackIndex;
  return { index, dataStart: 4 + length };
}

// The inputs hash the pack was built from (scripts/ui/build.ts skips an
// up-to-date build).
export function uiPackSource(pack: Uint8Array): string {
  return readIndex(pack).index.source;
}

export function readUiPack(pack: Uint8Array): StaticFS {
  const { index, dataStart } = readIndex(pack);
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["."]);
  for (const [name, [offset, size]] of Object.entries(index.files)) {
    files.set(name, pack.subarray(dataStart + offset, dataStart + offset + size));
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return {
    file: (path) => files.get(path),
    isDir: (path) => dirs.has(path),
  };
}

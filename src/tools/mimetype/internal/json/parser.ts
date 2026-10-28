// Upstream: gabriel-vasile/mimetype v1.4.15 internal/json/parser.go.
//
// Go takes parser states from a sync.Pool; here each parse has its own.

import { equal, lit, trimSpace } from "@/tools/mimetype/go-bytes";

export const QueryNone = "json";
export const QueryGeo = "geo";
export const QueryHAR = "har";
export const QueryGLTF = "gltf";
export const QueryCDX = "cdx";
const maxRecursion = 4096;

// query holds information about a combination of {"key": "val"} that we're trying
// to search for inside the JSON.
export interface query {
  // SearchPath represents the whole path to look for inside the JSON.
  // ex: [][]byte{[]byte("foo"), []byte("bar")} matches {"foo": {"bar": "baz"}}
  SearchPath: Uint8Array[];
  // SearchVals represents values to look for when the SearchPath is found.
  // Each SearchVal element is tried until one of them matches (logical OR.)
  SearchVals: Uint8Array[];
}

const newQuery = (path: string[], vals: string[] = []): query => ({
  SearchPath: path.map(lit),
  SearchVals: vals.map(lit),
});

export const queries: Record<string, query[]> = {
  [QueryNone]: [],
  [QueryGeo]: [
    newQuery(
      ["type"],
      [
        `"Feature"`,
        `"FeatureCollection"`,
        `"Point"`,
        `"LineString"`,
        `"Polygon"`,
        `"MultiPoint"`,
        `"MultiLineString"`,
        `"MultiPolygon"`,
        `"GeometryCollection"`,
      ],
    ),
  ],
  [QueryHAR]: [
    newQuery(["log", "version"]),
    newQuery(["log", "creator"]),
    newQuery(["log", "entries"]),
  ],
  [QueryGLTF]: [newQuery(["asset", "version"], [`"1.0"`, `"2.0"`])],
  [QueryCDX]: [newQuery(["bomFormat"], [`"CycloneDX"`])],
};

// parserState holds the state of JSON parsing. The number of inspected bytes,
// the current path inside the JSON object, etc.
export class parserState {
  // ib represents the number of inspected bytes.
  // Because mimetype limits itself to only reading the header of the file,
  // it means sometimes the input JSON can be truncated. In that case, we want
  // to still detect it as JSON, even if it's invalid/truncated.
  // When ib == len(input) it means the JSON was valid (at least the header).
  ib = 0;
  maxRecursion: number;
  // currPath keeps a track of the JSON keys parsed up.
  // It works only for JSON objects. JSON arrays are ignored
  // mainly because the functionality is not needed.
  currPath: Uint8Array[] = [];
  // firstToken stores the first JSON token encountered in input.
  firstToken = TokInvalid;
  // querySatisfied is true if both path and value of any queries passed to
  // consumeAny are satisfied.
  querySatisfied = false;

  constructor(maxRec = maxRecursion) {
    this.maxRecursion = maxRec;
  }

  reset(): void {
    this.ib = 0;
    this.currPath = [];
    this.firstToken = TokInvalid;
    this.querySatisfied = false;
  }

  consumeSpace(b: Uint8Array, at = 0): number {
    let n = 0;
    while (at + n < b.length && isSpace(b[at + n] as number)) {
      n++;
      this.ib++;
    }
    return n;
  }

  consumeConst(b: Uint8Array, cnst: Uint8Array): number {
    const lb = b.length;
    for (let i = 0; i < cnst.length; i++) {
      if (lb > i && b[i] === cnst[i]) {
        this.ib++;
      } else {
        return 0;
      }
    }
    return cnst.length;
  }

  consumeString(b: Uint8Array): number {
    let n = 0;
    while (b.length - n > 0) {
      const c = b[n] as number;
      n++;
      this.ib++;
      switch (c) {
        case 0x5c: // '\\'
          if (b.length - n === 0) {
            return 0;
          }
          switch (b[n]) {
            case 0x22: // '"'
            case 0x5c: // '\\'
            case 0x2f: // '/'
            case 0x62: // 'b'
            case 0x66: // 'f'
            case 0x6e: // 'n'
            case 0x72: // 'r'
            case 0x74: // 't'
              n++;
              this.ib++;
              continue;
            case 0x75: // 'u'
              n++;
              this.ib++;
              for (let j = 0; j < 4 && b.length - n > 0; j++) {
                if (!isXDigit(b[n] as number)) {
                  return 0;
                }
                n++;
                this.ib++;
              }
              continue;
            default:
              return 0;
          }
        case 0x22: // '"'
          return n;
        default:
          continue;
      }
    }
    return 0;
  }

  consumeNumber(b: Uint8Array): number {
    let got = false;
    let i = 0;

    out: {
      if (b.length === 0) {
        break out;
      }
      if (b[0] === 0x2d) {
        b = b.subarray(1);
        i++;
        this.ib++;
      }

      while (b.length > 0) {
        if (!isDigit(b[0] as number)) {
          break;
        }
        got = true;
        b = b.subarray(1);
        i++;
        this.ib++;
      }
      if (b.length === 0) {
        break out;
      }
      if (b[0] === 0x2e) {
        b = b.subarray(1);
        i++;
        this.ib++;
      }
      while (b.length > 0) {
        if (!isDigit(b[0] as number)) {
          break;
        }
        got = true;
        b = b.subarray(1);
        i++;
        this.ib++;
      }
      if (b.length === 0) {
        break out;
      }
      if (got && (b[0] === 0x65 || b[0] === 0x45)) {
        b = b.subarray(1);
        i++;
        this.ib++;
        got = false;
        if (b.length === 0) {
          break out;
        }
        if (b[0] === 0x2b || b[0] === 0x2d) {
          b = b.subarray(1);
          i++;
          this.ib++;
        }
        while (b.length > 0) {
          if (!isDigit(b[0] as number)) {
            break;
          }
          got = true;
          b = b.subarray(1);
          i++;
          this.ib++;
        }
      }
    }
    if (got) {
      return i;
    }
    return 0;
  }

  consumeArray(b: Uint8Array, qs: query[], lvl: number): number {
    this.appendPath(openArray, qs);
    if (b.length === 0) {
      return 0;
    }

    let n = 0;
    while (n < b.length) {
      n += this.consumeSpace(b, n);
      if (b.length - n === 0) {
        return 0;
      }
      if (b[n] === 0x5d) {
        this.ib++;
        this.popLastPath(qs);
        return n + 1;
      }
      const innerParsed = this.consumeAny(b.subarray(n), qs, lvl);
      if (innerParsed === 0) {
        return 0;
      }
      n += innerParsed;
      if (b.length - n === 0) {
        return 0;
      }
      switch (b[n]) {
        case 0x2c:
          n += 1;
          this.ib++;
          continue;
        case 0x5d:
          this.ib++;
          return n + 1;
        default:
          return 0;
      }
    }
    return 0;
  }

  // appendPath will append a path fragment if queries is not empty.
  // If we don't need query functionality (just checking if a JSON is valid),
  // then we can skip keeping track of the path we're currently in.
  appendPath(path: Uint8Array, qs: query[]): void {
    if (qs.length !== 0) {
      this.currPath.push(path);
    }
  }
  popLastPath(qs: query[]): void {
    if (qs.length !== 0) {
      this.currPath.pop();
    }
  }

  consumeObject(b: Uint8Array, qs: query[], lvl: number): number {
    let n = 0;
    while (n < b.length) {
      n += this.consumeSpace(b, n);
      if (b.length - n === 0) {
        return 0;
      }
      if (b[n] === 0x7d) {
        this.ib++;
        return n + 1;
      }
      if (b[n] !== 0x22) {
        return 0;
      } else {
        n += 1;
        this.ib++;
      }
      // queryMatched stores the index of the query satisfying the current path.
      let queryMatched = -1;
      const keyLen = this.consumeString(b.subarray(n));
      if (keyLen === 0) {
        return 0;
      } else {
        this.appendPath(b.subarray(n, n + keyLen - 1), qs);
        if (!this.querySatisfied) {
          queryMatched = queryPathMatch(qs, this.currPath);
        }
        n += keyLen;
      }
      n += this.consumeSpace(b, n);
      if (b.length - n === 0) {
        return 0;
      }
      if (b[n] !== 0x3a) {
        return 0;
      } else {
        n += 1;
        this.ib++;
      }
      n += this.consumeSpace(b, n);
      if (b.length - n === 0) {
        return 0;
      }

      const valLen = this.consumeAny(b.subarray(n), qs, lvl);
      if (valLen === 0) {
        return 0;
      } else {
        if (queryMatched !== -1) {
          const q = qs[queryMatched] as query;
          if (q.SearchVals.length === 0) {
            this.querySatisfied = true;
          }
          for (const val of q.SearchVals) {
            if (equal(val, trimSpace(b.subarray(n, n + valLen)))) {
              this.querySatisfied = true;
            }
          }
        }
        n += valLen;
      }
      if (b.length - n === 0) {
        return 0;
      }
      switch (b[n]) {
        case 0x2c:
          this.popLastPath(qs);
          n++;
          this.ib++;
          continue;
        case 0x7d:
          this.popLastPath(qs);
          this.ib++;
          return n + 1;
        default:
          return 0;
      }
    }
    return 0;
  }

  consumeAny(b: Uint8Array, qs: query[], lvl: number): number {
    // Avoid too much recursion.
    if (this.maxRecursion !== 0 && lvl > this.maxRecursion) {
      return 0;
    }
    if (qs.length === 0) {
      this.querySatisfied = true;
    }
    let n = this.consumeSpace(b);
    if (b.length - n === 0) {
      return 0;
    }

    let t: number;
    let rv: number;
    switch (b[n]) {
      case 0x22:
        n++;
        this.ib++;
        rv = this.consumeString(b.subarray(n));
        t = TokString;
        break;
      case 0x5b:
        n++;
        this.ib++;
        rv = this.consumeArray(b.subarray(n), qs, lvl + 1);
        t = TokArray;
        break;
      case 0x7b:
        n++;
        this.ib++;
        rv = this.consumeObject(b.subarray(n), qs, lvl + 1);
        t = TokObject;
        break;
      case 0x74:
        rv = this.consumeConst(b.subarray(n), constTrue);
        t = TokTrue;
        break;
      case 0x66:
        rv = this.consumeConst(b.subarray(n), constFalse);
        t = TokFalse;
        break;
      case 0x6e:
        rv = this.consumeConst(b.subarray(n), constNull);
        t = TokNull;
        break;
      default:
        rv = this.consumeNumber(b.subarray(n));
        t = TokNumber;
    }
    if (lvl === 0) {
      this.firstToken = t;
    }
    if (rv <= 0) {
      return n;
    }
    n += rv;
    n += this.consumeSpace(b, n);
    return n;
  }
}

export function eq(path1: Uint8Array[], path2: Uint8Array[]): boolean {
  if (path1.length !== path2.length) {
    return false;
  }
  for (let i = 0; i < path1.length; i++) {
    if (!equal(path1[i] as Uint8Array, path2[i] as Uint8Array)) {
      return false;
    }
  }
  return true;
}

// Parse will take out a parser from the pool depending on queryType and tries
// to parse raw bytes as JSON.
export function parse(
  queryType: string,
  raw: Uint8Array,
): [parsed: number, inspected: number, firstToken: number, querySatisfied: boolean] {
  const p = new parserState();
  p.reset();

  const qs = queries[queryType] ?? [];
  const got = p.consumeAny(raw, qs, 0);
  return [got, p.ib, p.firstToken, p.querySatisfied];
}

// openArray is used instead of an inline []byte{'['} to avoid mem alllocs.
const openArray = lit("[");
const constTrue = lit("true");
const constFalse = lit("false");
const constNull = lit("null");

function queryPathMatch(qs: query[], path: Uint8Array[]): number {
  for (let i = 0; i < qs.length; i++) {
    if (eq((qs[i] as query).SearchPath, path)) {
      return i;
    }
  }
  return -1;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
}
function isDigit(c: number): boolean {
  return 0x30 <= c && c <= 0x39;
}

function isXDigit(c: number): boolean {
  if (isDigit(c)) {
    return true;
  }
  return (0x61 <= c && c <= 0x66) || (0x41 <= c && c <= 0x46);
}

export const TokInvalid = 0;
export const TokNull = 1 << 1;
export const TokTrue = 1 << 2;
export const TokFalse = 1 << 3;
export const TokNumber = 1 << 4;
export const TokString = 1 << 5;
export const TokArray = 1 << 6;
export const TokObject = 1 << 7;
export const TokComma = 1 << 8;

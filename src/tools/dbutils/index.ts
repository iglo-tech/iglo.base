// Upstream: tools/dbutils/index.go
//
// The patterns are Go regexps (src/tools/regexp), so they match as
// upstream's do. Go's strings helpers are below: TrimSpace and Trim work
// on runes, EqualFold uses Unicode simple folding and ToUpper the simple
// uppercase mapping.

import { toUpperRune } from "@/tools/inflector/inflector";
import { mustCompile } from "@/tools/regexp/regexp";
import { Tokenizer } from "@/tools/tokenizer/tokenizer";
import { SimpleFold } from "@/tools/unicode/letter";

const indexRegex = mustCompile(
  String.raw`(?i)\s*create\s+(unique\s+)?\s*index\s*(if\s+not\s+exists\s+)?(\S*)\s+on\s+(\S*)\s*\(([\s\S]*?)\)(?:\s+where\s+([\s\S]*?))?\s*$`,
);
const indexColumnRegex = mustCompile(
  String.raw`(?i)^([\s\S]+?)(?:\s+collate\s+([\w]+))?(?:\s+(asc|desc))?\s*$`,
);

// IndexColumn represents a single parsed SQL index column.
export interface IndexColumn {
  name: string; // identifier or expression
  collate: string;
  sort: string;
}

// Index represents a single parsed SQL CREATE INDEX expression.
export class Index {
  schemaName = "";
  indexName = "";
  tableName = "";
  where = "";
  columns: IndexColumn[] = [];
  unique = false;
  optional = false;

  constructor(init: Partial<Index> = {}) {
    Object.assign(this, init);
  }

  // IsValid checks if the current Index contains the minimum required fields to be considered valid.
  isValid(): boolean {
    return this.indexName !== "" && this.tableName !== "" && this.columns.length > 0;
  }

  // Build returns a "CREATE INDEX" SQL string from the current index parts.
  //
  // Returns empty string if isValid() is false.
  build(): string {
    if (!this.isValid()) {
      return "";
    }

    let str = "CREATE ";

    if (this.unique) {
      str += "UNIQUE ";
    }

    str += "INDEX ";

    if (this.optional) {
      str += "IF NOT EXISTS ";
    }

    if (this.schemaName !== "") {
      str += "`" + this.schemaName + "`.";
    }

    str += "`" + this.indexName + "` ";

    str += "ON `" + this.tableName + "` (";

    if (this.columns.length > 1) {
      str += "\n  ";
    }

    let hasCol = false;
    for (const col of this.columns) {
      const trimmedColName = trimSpace(col.name);
      if (trimmedColName === "") {
        continue;
      }

      if (hasCol) {
        str += ",\n  ";
      }

      if (col.name.includes("(") || col.name.includes(" ")) {
        // most likely an expression
        str += trimmedColName;
      } else {
        // regular identifier
        str += "`" + trimmedColName + "`";
      }

      if (col.collate !== "") {
        str += " COLLATE " + col.collate;
      }

      if (col.sort !== "") {
        str += " " + toUpper(col.sort);
      }

      hasCol = true;
    }

    if (hasCol && this.columns.length > 1) {
      str += "\n";
    }

    str += ")";

    if (this.where !== "") {
      str += " WHERE " + this.where;
    }

    return str;
  }
}

// ParseIndex parses the provided "CREATE INDEX" SQL string into Index struct.
export function parseIndex(createIndexExpr: string): Index {
  const result = new Index();

  const matches = indexRegex.findStringSubmatch(createIndexExpr);
  if (matches === null || matches.length !== 7) {
    return result;
  }

  const trimChars = "`\"'[]\r\n\t\f\v ";

  // Unique
  // ---
  result.unique = trimSpace(matches[1] as string) !== "";

  // Optional (aka. "IF NOT EXISTS")
  // ---
  result.optional = trimSpace(matches[2] as string) !== "";

  // SchemaName and IndexName
  // ---
  const nameTk = Tokenizer.fromString(matches[3] as string);
  nameTk.setSeparators(".");

  const nameParts = scanAllOrEmpty(nameTk);
  switch (nameParts.length) {
    case 1:
      result.indexName = trim(nameParts[0] as string, trimChars);
      break;
    case 2:
      result.schemaName = trim(nameParts[0] as string, trimChars);
      result.indexName = trim(nameParts[1] as string, trimChars);
      break;
  }

  // TableName
  // ---
  result.tableName = trim(matches[4] as string, trimChars);

  // Columns
  // ---
  const columnsTk = Tokenizer.fromString(matches[5] as string);
  columnsTk.setSeparators(",");

  const rawColumns = scanAllOrEmpty(columnsTk);

  result.columns = [];

  for (const col of rawColumns) {
    const colMatches = indexColumnRegex.findStringSubmatch(col);
    if (colMatches === null || colMatches.length !== 4) {
      continue;
    }

    const trimmedName = trim(colMatches[1] as string, trimChars);
    if (trimmedName === "") {
      continue;
    }

    result.columns.push({
      name: trimmedName,
      collate: trimSpace(colMatches[2] as string),
      sort: toUpper(colMatches[3] as string),
    });
  }

  if (rawColumns.length !== result.columns.length) {
    // unset to trigger validation error
    result.columns = [];
  }

  // WHERE expression
  // ---
  result.where = trimSpace(matches[6] as string);

  return result;
}

// FindSingleColumnUniqueIndex returns the first matching single column
// unique index (Go's (Index, bool)).
export function findSingleColumnUniqueIndex(
  indexes: readonly string[],
  column: string,
): [Index, boolean] {
  for (const idx of indexes) {
    const index = parseIndex(idx);
    if (
      index.unique &&
      index.columns.length === 1 &&
      equalFold((index.columns[0] as IndexColumn).name, column)
    ) {
      return [index, true];
    }
  }

  return [new Index(), false];
}

// Deprecated: Use `const [, ok] = findSingleColumnUniqueIndex(indexes, column)` instead.
//
// HasColumnUniqueIndex loosely checks whether the specified column has
// a single column unique index (WHERE statements are ignored).
export function hasSingleColumnUniqueIndex(column: string, indexes: readonly string[]): boolean {
  const [, ok] = findSingleColumnUniqueIndex(indexes, column);
  return ok;
}

// tokenizer ScanAll with the error ignored (Go's `parts, _ := ScanAll()`
// gives a nil slice on error)
function scanAllOrEmpty(tk: Tokenizer): string[] {
  try {
    return tk.scanAll();
  } catch {
    return [];
  }
}

// unicode.IsSpace
const goSpaces = new Set([
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  "\u0085",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "　",
]);

// strings.TrimSpace (unlike JS trim(), U+0085 is a space and U+FEFF is not)
function trimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && goSpaces.has(s[start] as string)) {
    start++;
  }
  while (end > start && goSpaces.has(s[end - 1] as string)) {
    end--;
  }
  return s.slice(start, end);
}

// strings.Trim with an ASCII cutset
function trim(s: string, cutset: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && cutset.includes(s[start] as string)) {
    start++;
  }
  while (end > start && cutset.includes(s[end - 1] as string)) {
    end--;
  }
  return s.slice(start, end);
}

// strings.ToUpper: unicode.ToUpper on each rune
function toUpper(s: string): string {
  let out = "";
  for (const ch of s) {
    out += toUpperRune(ch);
  }
  return out;
}

// strings.EqualFold: equal under Unicode simple case folding
function equalFold(s: string, t: string): boolean {
  const a = [...s];
  const b = [...t];
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const r = (a[i] as string).codePointAt(0) as number;
    const tr = (b[i] as string).codePointAt(0) as number;
    if (r === tr) {
      continue;
    }
    // follow r's fold orbit looking for tr
    let f = SimpleFold(r);
    while (f !== r && f !== tr) {
      f = SimpleFold(f);
    }
    if (f !== tr) {
      return false;
    }
  }
  return true;
}

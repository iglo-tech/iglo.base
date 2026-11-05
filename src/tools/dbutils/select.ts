// Upstream: tools/dbutils/select.go

import { lazyMustCompile } from "@/tools/regexp/regexp";

// Regexp for columns and tables (the same as the one in dbx).
const selectRegex = lazyMustCompile(String.raw`(?i:\s+as\s+|\s+)([\w\-_\.]+)$`);

// AliasOrIdentifier returns the alias from a column or table identifier.
// Returns the identifier unmodified if no alias was found.
export function aliasOrIdentifier(columnOrTableIdentifier: string): string {
  const matches = selectRegex.findStringSubmatch(columnOrTableIdentifier);

  if (matches !== null && matches.length > 0 && matches[1] !== "") {
    return matches[1] as string;
  }

  return columnOrTableIdentifier;
}

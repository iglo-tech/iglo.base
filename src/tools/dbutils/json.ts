// Upstream: tools/dbutils/json.go

// JSONEach returns JSON_EACH SQLite string expression with
// some normalizations for non-json columns.
export function jsonEach(column: string): string {
  // note: we are not using the new and shorter "if(x,y)" syntax for
  // compatibility with custom drivers that use older SQLite version
  return `json_each(CASE WHEN iif(json_valid([[${column}]]), json_type([[${column}]])='array', FALSE) THEN [[${column}]] ELSE json_array([[${column}]]) END)`;
}

// JSONArrayLength returns JSON_ARRAY_LENGTH SQLite string expression
// with some normalizations for non-json columns.
//
// It works with both json and non-json column values.
//
// Returns 0 for empty string or NULL column values.
export function jsonArrayLength(column: string): string {
  // note: we are not using the new and shorter "if(x,y)" syntax for
  // compatibility with custom drivers that use older SQLite version
  return `json_array_length(CASE WHEN iif(json_valid([[${column}]]), json_type([[${column}]])='array', FALSE) THEN [[${column}]] ELSE (CASE WHEN [[${column}]] = '' OR [[${column}]] IS NULL THEN json_array() ELSE json_array([[${column}]]) END) END)`;
}

// JSONExtract returns a JSON_EXTRACT SQLite string expression with
// some normalizations for non-json columns.
export function jsonExtract(column: string, path: string): string {
  // prefix the path with dot if it is not starting with array notation
  if (path !== "" && !path.startsWith("[")) {
    path = "." + path;
  }

  // note: the extra object wrapping is needed to workaround the cases where a json_extract is used with non-json columns.
  return `(CASE WHEN json_valid([[${column}]]) THEN JSON_EXTRACT([[${column}]], '$${path}') ELSE JSON_EXTRACT(json_object('pb', [[${column}]]), '$.pb${path}') END)`;
}

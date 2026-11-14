// The JSON Schema of the schema file, embedded in the executable (D40): the
// same file is a release asset (schema/iglo.schema.json). Not an upstream
// file.

import schema from "@schema/iglo.schema.json";

// the schema as text, formatted as the file is (two spaces, final newline)
export const schemaJSONText: string = JSON.stringify(schema, null, 2) + "\n";

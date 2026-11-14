// The production lock of the schema (D41, S.6). Not an upstream file.
//
// With --mode prod and --schema, the schema file manages the collections and
// the settings. The collection create, update, delete and import, and the
// settings update, answer 403 with this message (upstream's error body).

export const schemaLockedMessage =
  "The schema and settings are managed by the schema file (production mode, --mode prod): change the collections in the schema file and restart the server. Change the settings with a JavaScript migration in pb_migrations (app.settings(), then app.save) and restart the server.";

// The schema file as the database has it (D40, S.6): `schema pull` and the
// development write-back both write this text. Not an upstream file.
//
// The description of the collections, with each auth collection's providers
// as references (src/schema/providers.ts), written over the existing file's
// extras (its descriptions, tsType and provider references). `notes` name the
// environment variables that must hold a secret; they never hold a value.
//
// Providers are written where there is no existing file (a plain pull makes
// one with the references and notes), or where the existing file already lists
// providers for that collection. An existing file that leaves them out gets
// none: the database keeps its providers, and an apply of the file leaves them
// alone (D40). Writing them would add references the file never had, and the
// next start would then need their variables.

import type { App } from "@/app/app";
import { findAllCollections } from "@/collections/collection-query";
import { describeCollections } from "@/schema/describe";
import { extractExtras, formatSchema } from "@/schema/write";
import { providersFileForm } from "@/schema/providers";
import { readSchema } from "@/schema/read";

export interface SchemaFileText {
  text: string;
  notes: string[];
}

// the file text of the database; `existing` is the file it is written over,
// if any. Throws when the existing text is not JSON (its extras are unknown).
export function schemaFileText(
  app: App,
  existing: string | undefined,
  schemaURL: string,
): SchemaFileText {
  const description = describeCollections(findAllCollections(app));
  const extras = existing === undefined ? undefined : extractExtras(existing);
  const previous = existing === undefined ? undefined : readSchema(existing);
  const notes: string[] = [];

  for (const collection of description.collections) {
    if (collection.type !== "auth") {
      continue;
    }
    const stored = collection.providers ?? [];
    const prior = previous?.ok
      ? previous.schema.collections.find((c) => c.name === collection.name)?.providers
      : undefined;
    // an existing file that does not list providers for the collection keeps them out
    const listed = prior !== undefined && prior.length > 0;
    if (stored.length === 0 || (existing !== undefined && !listed)) {
      collection.providers = undefined;
      continue;
    }
    const form = providersFileForm(collection.name, stored, prior, (name) => app.getenv(name));
    collection.providers = form.providers;
    notes.push(...form.notes);
  }

  return { text: formatSchema(description, { schemaURL, extras }), notes };
}

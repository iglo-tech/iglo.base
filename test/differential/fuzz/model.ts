// What the generator knows about the fixture: collections, fields, relations
// and the stored values, read through upstream's API before the first case,
// sorted so that the same fixture always gives the same model.

export interface FieldModel {
  name: string;
  type: string;
  hidden: boolean;
  // relation, select and file fields with maxSelect > 1
  multiple: boolean;
  // target collection of a relation field
  target?: string;
  // the distinct stored values, flattened for multi-value fields
  samples: unknown[];
}

export interface BackRelation {
  collection: string;
  field: string;
}

export interface CollectionModel {
  name: string;
  type: string;
  fields: FieldModel[];
  // relation fields of other collections that point here
  backRelations: BackRelation[];
  ids: string[];
}

export interface Model {
  collections: Map<string, CollectionModel>;
  names: string[];
}

interface ApiField {
  name: string;
  type: string;
  hidden?: boolean;
  maxSelect?: number;
  collectionId?: string;
}

export interface ApiCollection {
  id: string;
  name: string;
  type: string;
  fields: ApiField[];
}

function samplesOf(field: ApiField, records: Record<string, unknown>[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const record of records) {
    const value = record[field.name];
    const values = Array.isArray(value) && field.type !== "json" ? (value as unknown[]) : [value];
    for (const v of values) {
      if (v !== undefined) {
        seen.set(JSON.stringify(v), v);
      }
    }
  }
  return [...seen.keys()].toSorted().map((key) => seen.get(key));
}

export function buildModel(
  collections: ApiCollection[],
  records: Map<string, Record<string, unknown>[]>,
): Model {
  const namesById = new Map(collections.map((c) => [c.id, c.name]));
  const model: Model = {
    collections: new Map(),
    names: collections.map((c) => c.name).toSorted(),
  };
  for (const name of model.names) {
    const c = collections.find((item) => item.name === name) as ApiCollection;
    const rows = records.get(name) ?? [];
    model.collections.set(name, {
      name,
      type: c.type,
      fields: c.fields.map((f) => ({
        name: f.name,
        type: f.type,
        hidden: f.hidden === true,
        multiple: (f.maxSelect ?? 1) > 1,
        ...(f.type === "relation" ? { target: namesById.get(f.collectionId ?? "") ?? "" } : {}),
        samples: samplesOf(f, rows),
      })),
      backRelations: [],
      ids: rows.map((row) => String(row.id)).toSorted(),
    });
  }
  for (const c of model.collections.values()) {
    // views cannot be the source of a back-relation
    if (c.type === "view") {
      continue;
    }
    for (const f of c.fields) {
      if (f.target !== undefined) {
        model.collections.get(f.target)?.backRelations.push({ collection: c.name, field: f.name });
      }
    }
  }
  return model;
}

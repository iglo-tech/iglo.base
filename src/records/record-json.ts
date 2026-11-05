// Upstream: core/record_model.go (Record.MarshalJSON, PublicExport)
//
// The member order of a record's JSON for one collection. Go's encoder sorts
// the members of the map PublicExport returns by their UTF-8 bytes; the
// names a collection's records can have are known from its fields, so the
// sorted order and the quoted names are computed once per field list and
// used for every record of the collection, instead of being rebuilt (an
// object, a sort and a quote for each member) for each record.
//
// The cache is keyed by the field list object and is checked against the
// fields on every use (same field objects in the same order, same names),
// so renaming or changing a field cannot leave a stale layout. A collection
// whose names the layout cannot cover (a name that needs escaping, or a
// field named like one of the helper members) has no layout and the record
// is written through the generic path.

import {
  FieldNameCollectionId,
  FieldNameCollectionName,
  FieldNameExpand,
  type Field,
} from "@/fields/field";

// a member of the record's JSON object
export interface LayoutMember {
  // the quoted name: `"title"`
  readonly quoted: string;
  readonly name: string;
  // the schema field's index, or -1 for collectionId, collectionName, expand
  readonly fieldIndex: number;
}

export interface RecordJSONLayout {
  // all possible members in the order they are written
  readonly members: readonly LayoutMember[];
}

// what the layout was built from, to check it is still current
interface Entry {
  readonly fields: readonly Field[];
  readonly names: readonly string[];
  readonly layout: RecordJSONLayout | null;
}

const entries = new WeakMap<object, Entry>();

// names that are written as they are between quotes: no character that
// needs an escape and no surrogate (so UTF-16 order is UTF-8 order)
// oxlint-disable-next-line no-control-regex
const plainName = /^[^\u0000-\u001f"\\\ud800-\udfff]*$/;

// the layout for the field list `owner` holds, or null when there is none
export function recordJSONLayout(owner: object, fields: Iterable<Field>): RecordJSONLayout | null {
  const cached = entries.get(owner);
  if (cached !== undefined && matches(cached, fields)) {
    return cached.layout;
  }
  const built = build(fields);
  entries.set(owner, built);
  return built.layout;
}

function matches(entry: Entry, fields: Iterable<Field>): boolean {
  let i = 0;
  for (const f of fields) {
    if (i >= entry.fields.length || f !== entry.fields[i] || f.getName() !== entry.names[i]) {
      return false;
    }
    i++;
  }
  return i === entry.fields.length;
}

function build(fields: Iterable<Field>): Entry {
  const list: Field[] = [];
  const names: string[] = [];
  const members: LayoutMember[] = [];
  const seen = new Set<string>();
  let covered = true;
  for (const f of fields) {
    const name = f.getName();
    if (!plainName.test(name) || seen.has(name) || isHelperName(name)) {
      covered = false;
    }
    seen.add(name);
    members.push({ quoted: `"${name}"`, name, fieldIndex: list.length });
    list.push(f);
    names.push(name);
  }
  if (!covered) {
    return { fields: list, names, layout: null };
  }
  for (const name of [FieldNameCollectionId, FieldNameCollectionName, FieldNameExpand]) {
    members.push({ quoted: `"${name}"`, name, fieldIndex: -1 });
  }
  members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { fields: list, names, layout: { members } };
}

function isHelperName(name: string): boolean {
  return (
    name === FieldNameCollectionId || name === FieldNameCollectionName || name === FieldNameExpand
  );
}

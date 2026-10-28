// Upstream: core/record_model_superusers.go (CollectionNameSuperusers and
// IsSuperuser; the superuser protections come with M1.8c)
//
// IsSuperuser is a Record method in Go; the Record class
// (record-model.ts) exposes this function as isSuperuser().

import type { Record } from "@/records/record-model";

export const CollectionNameSuperusers = "_superusers";

// IsSuperuser returns whether the current record is a superuser, aka.
// whether the record is from the _superusers collection.
export function recordIsSuperuser(m: Record): boolean {
  return m.collection().name === CollectionNameSuperusers;
}

// The batch data set: upstream's fixture with these collections, created
// through upstream's API before both servers start on copies of it.

import { superuserToken } from "@test/scenarios/record-crud";

interface CollectionData {
  name: string;
  [key: string]: unknown;
}

const title = { name: "title", type: "text", required: true };
const publicRules = {
  listRule: "",
  viewRule: "",
  createRule: "",
  updateRule: "",
  deleteRule: "",
};

// the parents' id is filled in when its turn comes
function collections(parentsId: string, parentsListView: string): CollectionData[] {
  const parent = (extra: object): object => ({
    name: "parent",
    type: "relation",
    collectionId: parentsId,
    maxSelect: 1,
    ...extra,
  });
  return [
    {
      name: "b_children",
      ...publicRules,
      fields: [title, parent({ cascadeDelete: true })],
    },
    {
      name: "b_required",
      ...publicRules,
      fields: [title, parent({ required: true })],
    },
    {
      name: "b_refrule",
      ...publicRules,
      createRule: `@collection.b_parents.title ?= @request.body.title`,
      fields: [title],
    },
    {
      name: "b_rules",
      ...publicRules,
      createRule: `@request.context = "batch" && @request.headers.x_tenant = "acme"`,
      updateRule: `@request.headers.x_tenant = "acme"`,
      deleteRule: `@request.context = "batch"`,
      fields: [title],
    },
    {
      name: "b_auth_only",
      ...publicRules,
      createRule: `@request.auth.id != ""`,
      fields: [title],
    },
    {
      name: "b_method",
      ...publicRules,
      createRule: `@request.method = "POST" && @request.context = "batch"`,
      updateRule: `@request.method = "PATCH"`,
      fields: [title],
    },
    {
      name: "b_superuser_only",
      listRule: "",
      viewRule: "",
      fields: [title],
    },
    {
      name: "b_files",
      ...publicRules,
      fields: [
        { name: "title", type: "text" },
        { name: "doc", type: "file", maxSelect: 1, maxSize: 1000 },
        { name: "files", type: "file", maxSelect: 9, maxSize: 1000 },
      ],
    },
    {
      name: "b_json",
      ...publicRules,
      fields: [
        { name: "j", type: "json" },
        { name: "n", type: "number" },
      ],
    },
    {
      name: "b_auth",
      type: "auth",
      ...publicRules,
      manageRule: `@request.auth.id != ""`,
      fields: [
        { name: "name", type: "text" },
        { name: "secret", type: "text", hidden: true },
      ],
      passwordAuth: { enabled: true, identityFields: ["email"] },
    },
    {
      name: "b_view",
      type: "view",
      listRule: "",
      viewRule: "",
      viewQuery: parentsListView,
    },
  ];
}

async function post(url: string, path: string, body: unknown): Promise<{ id: string }> {
  const res = await fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: superuserToken },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

// creates the data set on a running upstream
export async function createBatchCollections(url: string): Promise<void> {
  const { id } = await post(url, "/api/collections", {
    name: "b_parents",
    ...publicRules,
    fields: [title],
    indexes: ["CREATE UNIQUE INDEX idx_b_parents_title ON b_parents (title)"],
  });
  for (const collection of collections(id, "SELECT id, title FROM b_parents")) {
    await post(url, "/api/collections", collection);
  }
}

// The schema of the `schema types` tests (D40, S.4): every field type, a view,
// an auth collection, relations for expand, a hidden password field, autodate
// fields and a json field with a tsType. Not an upstream file. It is written in
// the schema file's shape (schema/iglo.schema.json).

export const typesSchema = {
  collections: {
    authors: {
      type: "auth",
      description: "People who write posts.",
      rules: { list: "", view: "" },
      fields: {
        nickname: { type: "text", required: true, max: 40, description: "Shown publicly." },
      },
    },
    posts: {
      type: "base",
      rules: { list: "", view: "" },
      fields: {
        title: { type: "text", required: true, min: 1, max: 100 },
        body: { type: "editor" },
        views: { type: "number", onlyInt: true, min: 0 },
        published: { type: "bool" },
        contact: { type: "email" },
        site: { type: "url" },
        day: { type: "date" },
        status: {
          type: "select",
          values: ["draft", "published", "archived"],
          maxSelect: 1,
          required: true,
        },
        section: { type: "select", values: ["news", "sport"], maxSelect: 1 },
        tags: { type: "select", values: ["a", "b"], maxSelect: 2 },
        author: { type: "relation", collection: "authors", maxSelect: 1 },
        related: { type: "relation", collection: "posts", maxSelect: 5 },
        meta: { type: "json", tsType: "{ readonly k: string }" },
        free: { type: "json" },
        place: { type: "geoPoint" },
        cover: { type: "file", maxSelect: 1, maxSize: 1000 },
        gallery: { type: "file", maxSelect: 4, maxSize: 1000, description: "Images." },
        pin: { type: "password", min: 4, hidden: true },
        created: { type: "autodate", onCreate: true, onUpdate: false },
        updated: { type: "autodate", onCreate: true, onUpdate: true },
      },
    },
    post_list: {
      type: "view",
      rules: { list: "", view: "" },
      query: "SELECT id, title FROM posts",
    },
  },
};

// The JS migration patterns of upstream's docs, as test data: each file
// prints what it reads with console.log, so both servers' output can be
// compared. Ids are fixed; nothing here depends on the clock or randomness.

export const patternFiles: Record<string, string> = {
  "1000000001_create.js": `
migrate((app) => {
  const posts = new Collection({
    id: "pbc_posts00000001",
    type: "base",
    name: "posts",
    listRule: "",
    viewRule: "published = true",
    createRule: null,
    fields: [
      { id: "text0000000title", name: "title", type: "text", required: true, max: 100 },
      { id: "bool000published", name: "published", type: "bool" },
      { id: "numb0000000views", name: "views", type: "number", min: 0, onlyInt: true },
      { id: "json000000000meta", name: "meta", type: "json", maxSize: 2000 },
      { id: "date00000000when", name: "when", type: "date" },
      { id: "selt00000000tags", name: "tags", type: "select", maxSelect: 3, values: ["a", "b", "c"] },
    ],
    indexes: ["CREATE INDEX idx_posts_title ON posts (title)"],
  });
  app.save(posts);
  console.log(JSON.stringify({ id: posts.id, isNew: posts.isNew(), fields: posts.fields.length, names: posts.fields.fieldNames() }));

  const members = new Collection({ id: "pbc_members000001", name: "members", type: "auth" });
  members.listRule = "id = @request.auth.id";
  members.passwordAuth.identityFields = ["email"];
  members.authToken.duration = 3600;
  members.fields.add(new TextField({ id: "text00000nick000", name: "nick", max: 20 }));
  members.fields.add(new NumberField({ id: "numb000000age000", name: "age", min: 18 }));
  members.fields.add(new BoolField({ id: "bool0000active00", name: "active" }));
  members.fields.add(new URLField({ id: "url0000000site00", name: "site" }));
  members.fields.add(new EmailField({ id: "emai000000alt000", name: "alt" }));
  members.fields.add(new EditorField({ id: "edit0000000bio00", name: "bio" }));
  members.fields.add(new DateField({ id: "date00000birth00", name: "birth" }));
  members.fields.add(new AutodateField({ id: "auto000000seen00", name: "seen", onCreate: true, onUpdate: true }));
  members.fields.add(new JSONField({ id: "json0000000cfg00", name: "cfg" }));
  members.fields.add(new SelectField({ id: "selt0000000lvl00", name: "lvl", values: ["x", "y"], maxSelect: 1 }));
  members.fields.add(new FileField({ id: "file0000000pic00", name: "pic", maxSelect: 1, maxSize: 1000 }));
  members.fields.add(new GeoPointField({ id: "geop0000000loc00", name: "loc" }));
  members.fields.add(new RelationField({ id: "rela00000post000", name: "post", collectionId: posts.id, maxSelect: 1 }));
  members.addIndex("idx_nick", true, "nick", "nick != ''");
  members.addIndex("idx_age", false, "age");
  app.save(members);

  const stats = new Collection({
    id: "pbc_stats00000001",
    type: "view",
    name: "stats",
    viewQuery: "SELECT id, title FROM posts",
    listRule: "",
  });
  app.save(stats);
  console.log(stats.fields.fieldNames().join(","));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("stats"));
  app.delete(app.findCollectionByNameOrId("members"));
  app.delete(app.findCollectionByNameOrId("posts"));
});
`,
  "1000000002_update.js": `
migrate((app) => {
  const posts = app.findCollectionByNameOrId("posts");
  console.log(typeof posts.fields.getByName("title"), posts.fields.getByName("nope"), posts.fields[0].name, posts.fields.length);
  posts.fields.getByName("title").max = 200;
  posts.fields.getByName("title").required = false;
  posts.fields.add(new TextField({ id: "text000000slug0", name: "slug", pattern: "^[a-z]+$" }));
  posts.fields.addAt(1, new Field({ id: "text00000intro0", name: "intro", type: "text" }));
  posts.fields.removeByName("tags");
  posts.addIndex("idx_slug", true, "slug", "slug != ''");
  posts.removeIndex("idx_posts_title");
  console.log(JSON.stringify(posts.indexes), posts.getIndex("idx_slug"));
  posts.listRule = null;
  posts.viewRule = "id != ''";
  unmarshal({ deleteRule: "id = 'x'", updateRule: "" }, posts);
  app.save(posts);

  const members = app.findCollectionByNameOrId("members");
  members.otp.enabled = true;
  members.otp.duration = 120;
  members.mfa.enabled = false;
  members.oauth2.mappedFields.name = "nick";
  members.passwordAuth.identityFields = ["email", "nick"];
  members.resetPasswordTemplate.subject = "Reset!";
  unmarshal({ authAlert: { enabled: false }, fileToken: { duration: 99 } }, members);
  app.save(members);
  console.log(members.otp.duration, members.fileToken.duration, members.authAlert.enabled, members.isAuth(), members.isBase(), members.isView());

  const renamed = app.findCollectionByNameOrId("stats");
  renamed.name = "stats2";
  app.save(renamed);
  console.log(app.findCollectionByNameOrId("stats2").id, app.isCollectionNameUnique("stats"));
}, null);
`,
  "1000000003_records.js": `
migrate((app) => {
  const posts = app.findCollectionByNameOrId("posts");
  const a = new Record(posts);
  a.id = "postaaaaaaaaaaa";
  a.set("title", "First");
  a.set("views", 5);
  a.set("published", true);
  a.set("meta", { k: [1, 2], s: "x" });
  a.set("when", "2024-01-02 03:04:05.000Z");
  app.save(a);
  const b = new Record(posts, { id: "postbbbbbbbbbbb", title: "Second", views: 7, slug: "second" });
  app.save(b);
  const c = new Record(posts);
  c.load({ id: "postccccccccccc", title: "Third", views: 9 });
  app.save(c);

  const found = app.findRecordById("posts", "postaaaaaaaaaaa");
  console.log(found.id, found.get("title"), found.getString("title"), found.getInt("views"), found.getFloat("views"), found.getBool("published"), found.getString("meta"), found.getDateTime("when").string());
  console.log(found.tableName(), found.collection().name, found.isNew(), a.isNew());
  console.log(found.get("views") + 1, typeof found.get("published"), String(found.getDateTime("when")));
  console.log(JSON.stringify(found));
  console.log(found.publicExport().title, toString(found.get("meta")), JSON.stringify(found.get("meta")));
  console.log(JSON.stringify(found.fieldsData().title));

  const list = app.findRecordsByFilter("posts", "views > {:min}", "-views", 10, 0, { min: 6 });
  console.log(list.map((r) => r.id).join(","), list.length, Array.isArray(list));
  console.log(app.findFirstRecordByFilter("posts", "title = {:t}", { t: "Second" }).id);
  console.log(app.findFirstRecordByData("posts", "slug", "second").id);
  console.log(app.findRecordsByIds("posts", ["postbbbbbbbbbbb", "postccccccccccc"]).length);
  console.log(app.findAllRecords("posts", $dbx.exp("views >= {:v}", { v: 7 })).length);
  console.log(app.findAllRecords(posts, $dbx.hashExp({ title: "First" })).length);
  console.log(app.countRecords("posts"), app.countRecords("posts", $dbx.not($dbx.hashExp({ title: "First" }))));

  const records = arrayOf(new Record());
  app.recordQuery("posts").where($dbx.like("title", "ir")).orderBy("title DESC").limit(5).all(records);
  console.log(records.length, records[0].getString("title"));
  const one = new Record();
  app.recordQuery(posts).where($dbx.hashExp({ id: "postccccccccccc" })).one(one);
  console.log(one.id, one.getString("title"));
  one.set("title", "Third!");
  app.save(one);

  const members = app.findCollectionByNameOrId("members");
  const m = new Record(members);
  m.id = "membermmmmmmmmm";
  m.setEmail("m@example.com");
  m.setPassword("1234567890");
  m.set("nick", "mm");
  m.set("age", 30);
  m.setVerified(true);
  app.save(m);
  const fm = app.findAuthRecordByEmail("members", "m@example.com");
  console.log(fm.email(), fm.verified(), fm.validatePassword("1234567890"), fm.validatePassword("nope"), fm.getString("nick"));

  app.delete(app.findRecordById("posts", "postbbbbbbbbbbb"));
  console.log(app.countRecords("posts"));
  try {
    app.findRecordById("posts", "missing");
  } catch (e) {
    console.log(String(e), e.message, e.name, e instanceof Error);
  }
  try {
    const bad = new Record(members);
    bad.set("age", 1);
    app.save(bad);
  } catch (e) {
    console.log(String(e), JSON.stringify(e.value));
  }
}, (app) => {
  app.db().newQuery("DELETE FROM posts").execute();
  app.db().newQuery("DELETE FROM members").execute();
});
`,
  "1000000004_db.js": `
migrate((app) => {
  const created = app.db().newQuery("CREATE TABLE extra (id INTEGER PRIMARY KEY, name TEXT, score REAL, flag BOOLEAN, data JSON, opt TEXT)").execute();
  console.log(created.rowsAffected());
  const ins = app.db().newQuery("INSERT INTO extra (name, score, flag, data) VALUES ({:n}, {:s}, {:f}, {:d})").bind({ n: "one", s: 1.5, f: true, d: '{"a":1}' }).execute();
  console.log(ins.rowsAffected(), ins.lastInsertId());
  app.db().insert("extra", { name: "two", score: 2, flag: false, data: '{"b":[1,2]}' }).execute();
  app.db().update("extra", { name: "two!" }, $dbx.hashExp({ name: "two" })).execute();

  const row = new DynamicModel({ id: 0, name: "", score: -0, flag: false, data: {}, opt: nullString() });
  app.db().select("*").from("extra").where($dbx.exp("id = {:id}", { id: 1 })).one(row);
  console.log(JSON.stringify(row));

  const rows = arrayOf(new DynamicModel({ id: 0, name: "", score: -0, flag: false, data: nullObject(), opt: nullString() }));
  app.db().select("id", "name", "score", "flag", "data", "opt").from("extra").andWhere($dbx.in("id", 1, 2)).orderBy("id DESC").all(rows);
  console.log(JSON.stringify(rows), rows.length);

  const raw = new DynamicModel({ n: 0 });
  app.db().newQuery("SELECT count(*) AS n FROM extra").one(raw);
  console.log(raw.n);

  const names = arrayOf("");
  app.db().newQuery("SELECT name FROM extra ORDER BY id").column(names);
  console.log(JSON.stringify(names));

  console.log(app.hasTable("extra"), app.hasTable("nope"), JSON.stringify(app.tableColumns("extra")));
  console.log(app.db().delete("extra", $dbx.hashExp({ id: 2 })).execute().rowsAffected());
  console.log($dbx.and($dbx.hashExp({ a: 1 }), $dbx.or($dbx.exp("b=1"), $dbx.exp("c=2"))) !== null);
  try {
    app.db().newQuery("SELECT * FROM nope").execute();
  } catch (e) {
    console.log(e.name, e.message);
  }
  try {
    app.db().newQuery("SELECT * FROM extra WHERE id = 99").one(new DynamicModel({ id: 0 }));
  } catch (e) {
    console.log(e.message);
  }
}, (app) => {
  app.db().dropTable("extra").execute();
});
`,
  "1000000005_settings.js": `
migrate((app) => {
  const settings = app.settings();
  console.log(settings.meta.appName, settings.batch.enabled, settings.logs.maxDays, settings.rateLimits.enabled, settings.rateLimits.rules.length, Array.isArray(settings.trustedProxy.headers), settings.smtp.enabled);
  settings.meta.appName = "Migrated";
  settings.meta.senderName = "Sender";
  settings.batch.enabled = true;
  settings.batch.maxRequests = 25;
  settings.logs.maxDays = 3;
  settings.rateLimits.enabled = true;
  settings.rateLimits.rules = [{ label: "posts:list", maxRequests: 5, duration: 10 }];
  settings.trustedProxy.headers = ["X-Real-IP"];
  app.save(settings);
  console.log(app.settings().meta.appName, app.settings().rateLimits.rules.length, app.settings().rateLimits.rules[0].label, app.settings().rateLimits.rules[0].maxRequests);
  unmarshal({ meta: { appURL: "https://example.com" } }, settings);
  app.save(settings);
  console.log(JSON.stringify(settings).length > 10);
  try {
    settings.meta.appName = "";
    app.save(settings);
  } catch (e) {
    console.log(e.message);
    settings.meta.appName = "Migrated";
  }
}, null);
`,
  "1000000006_security.js": `
migrate((app) => {
  console.log($security.md5("a"), $security.sha256("a"), $security.sha512("a"));
  console.log($security.hs256("a", "k"), $security.hs512("a", "k"), $security.equal("a", "a"), $security.equal("a", "b"));
  console.log($security.randomString(8).length, $security.randomStringWithAlphabet(4, "x"), $security.pseudorandomString(3).length, $security.pseudorandomStringWithAlphabet(2, "y"), $security.randomStringByRegex("[a]{3}"));
  const key = "abcdefghijklmnopqrstuvwxyz012345";
  console.log($security.decrypt($security.encrypt("secret", key), key));
  const token = $security.createJWT({ id: 1, a: "b" }, "key", 3600);
  console.log(JSON.stringify(Object.keys($security.parseJWT(token, "key")).sort()), $security.parseUnverifiedJWT(token).a);
  try {
    $security.parseJWT(token, "other");
  } catch (e) {
    console.log(e.message);
  }
  console.log(toString(123), toString(true), toString(null), toString([1, 2]), toString({ a: 1 }), toString("s"), toString(-12.4));
  console.log(JSON.stringify(toBytes("ab")), JSON.stringify(toBytes(null)), Array.isArray(toBytes("a")));
  console.log(new DateTime("2024-05-06 07:08:09.123Z").string(), new DateTime("2024-05-06 07:08:09.123Z").unix(), new DateTime("bad").isZero(), new DateTime().isZero());
  console.log(new ValidationError("code", "msg").code(), new ValidationError("code", "msg").message(), String(new ValidationError("code", "msg")));
  console.log(typeof process.env, Buffer.from("hi").toString("hex"), typeof require);
  const v = new DynamicModel({ a: 1 });
  unmarshal({ a: 2, b: 3 }, v);
  console.log(JSON.stringify(v));
  console.log(new Collection({ name: "x" }) instanceof Collection, new Record() instanceof Record, new TextField() instanceof TextField);
  console.log(new TextField({ name: "n", min: 1 }).min, new TextField({ name: "n" }).type(), new Field({ name: "f", type: "bool" }).type(), new FieldsList([{ name: "a", type: "text" }]).length);
}, null);
`,
  "1000000007_nested.js": `
migrate((app) => {
  console.log(app.isTransactional());
  app.runInTransaction((txApp) => {
    console.log(txApp.isTransactional());
    txApp.db().newQuery("CREATE TABLE nested1 (a INT)").execute();
    txApp.runInTransaction((tx2) => {
      tx2.db().newQuery("INSERT INTO nested1 VALUES (1)").execute();
    });
  });
  try {
    app.runInTransaction((txApp) => {
      txApp.db().newQuery("INSERT INTO nested1 VALUES (2)").execute();
      throw new Error("inner");
    });
  } catch (e) {
    console.log(e.name);
  }
  const n = new DynamicModel({ n: 0 });
  app.db().newQuery("SELECT count(*) AS n FROM nested1").one(n);
  console.log(n.n);
}, (app) => {
  app.db().newQuery("DROP TABLE nested1").execute();
});
`,
  "1000000008_nullup.js": `
migrate(null, (app) => {
  app.db().newQuery("CREATE TABLE down_ran (a INT)").execute();
});
`,
  "1000000009_nodown.js": `
migrate((app) => {
  const c = new Collection({ id: "pbc_temp000000001", name: "temp", type: "base" });
  app.save(c);
  app.delete(app.findCollectionByNameOrId("temp"));
  const v = app.findCollectionByNameOrId("posts");
  app.saveNoValidate(v);
  app.truncateCollection(app.findCollectionByNameOrId("posts"));
});
`,
  "1000000010_nomigrate.js": `
var unused = 1;
`,
};

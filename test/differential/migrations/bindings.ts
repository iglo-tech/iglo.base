// What goja gives a migration file for each Go value, as test data: every
// line prints a value or a thrown error, so both servers' output can be
// compared. Each file runs on a fresh site. A case upstream ends with a Go
// panic is left out: it is no migration a site can have applied.
//
// Review findings of M3.7 and where their cases are:
//   1. duration units and default: "values", static *
//   2. FieldsList Array mutations: "records-fields", splice to save reverse
//   3. Settings arrays: "coercion-settings", rl *
//   4. Query destinations: "queries", one/all/model *
//   5. byte slices: "values", toBytes, encrypt, readFile, writeFile
//   6. typed JSON output: "records-fields", unmarshalJSONField; "queries", unm *
//   7. string-keyed maps: "records-fields", asMap, expand fail, tableIndexes
//   8. Field.prepareValue: "records-fields", prepare *
//   9. expansion callbacks: "records-fields", expand cb, expands cb
//
// Round 2 findings:
//   1. Go-valued SQL parameters: "sqlValues"; stored data in js-migrations.test.ts
//   2. JSON null at destinations: "outputs", unm null, field null, el null
//   3. new DynamicModel array elements: "outputs", zero *
//   4. named JSON values: "jsonValues"; "outputs", dv *
//   6. nullable column(): "outputs", col *
//   7. a saved settings clone: js-migrations.test.ts
//
// The further instances of the same classes are the rest of each file.

const helpers = String.raw`const show=(v)=>{ if(v===undefined) return "undefined"; if(typeof v==="function") return "fn"; if(typeof v==="bigint") return "bigint"; let s; try{s=JSON.stringify(v)}catch(e){s="<nojson "+e.message+">"} return typeof v+":"+Array.isArray(v)+":"+s; };
const t=(label,fn)=>{ try{console.log(label,"=>",show(fn()))}catch(e){console.log(label,"THROW",e&&e.name,String(e&&e.message!==undefined?e.message:e).slice(0,200))} };
const dur=(tok)=>{const c=$security.parseUnverifiedJWT(tok);return Math.round((c.exp-Date.now()/1000)/10)*10};
const seed=(app)=>{
 const users=app.findCollectionByNameOrId("users");
 const c=new Collection({id:"pbc_things0000001",name:"things",type:"base",fields:[
  {id:"t1",name:"title",type:"text"},{id:"n1",name:"note",type:"text"},{id:"n2",name:"num",type:"number",min:1,max:5},{id:"j1",name:"config",type:"json"},
  {id:"r1",name:"author",type:"relation",collectionId:users.id,maxSelect:1},{id:"r2",name:"authors",type:"relation",collectionId:users.id,maxSelect:5},
  {id:"s1",name:"tags",type:"select",values:["a","b","c"],maxSelect:3},{id:"f1",name:"pic",type:"file",maxSelect:2,maxSize:1000},{id:"g1",name:"loc",type:"geoPoint"},{id:"d1",name:"when",type:"date"},{id:"b1",name:"flag",type:"bool"}]});
 app.save(c);
 const u=new Record(users); u.id="useruseruseruse"; u.setEmail("u@example.com"); u.setPassword("1234567890"); app.save(u);
 const r=new Record(c); r.id="thingthingthing"; r.set("title","hello"); r.set("note","n"); r.set("config",{a:42,b:"x"}); r.set("author",u.id); r.set("authors",[u.id]); r.set("num",3); app.save(r);
 return {users,c,u,r};
};
`;

export const bindingFiles: Record<string, string> = {
  shapes:
    helpers +
    String.raw`
migrate((app)=>{
 const {users,c,u,r}=seed(app);
 // pointers
 t("listRule typeof",()=>typeof users.listRule);
 t("listRule val",()=>users.listRule);
 t("listRule ==",()=>users.listRule=="id = @request.auth.id");
 t("listRule ===",()=>users.listRule==="id = @request.auth.id");
 t("listRule str",()=>String(users.listRule));
 t("listRule +",()=>users.listRule+"!");
 t("listRule len",()=>users.listRule.length);
 t("null rule",()=>c.listRule);
 t("null rule typeof",()=>typeof c.listRule);
 t("set rule",()=>{c.listRule="x"; return [typeof c.listRule,c.listRule]});
 t("set rule undefined",()=>{c.listRule=undefined; return [typeof c.listRule,c.listRule]});
 t("set rule num",()=>{c.listRule=5; return [typeof c.listRule,c.listRule]});
 t("set rule null",()=>{c.listRule=null; return [typeof c.listRule,c.listRule]});
 const nf=new NumberField({name:"n",min:5});
 t("num min",()=>[typeof nf.min,nf.min,nf.min+1,nf.min===5,nf.max]);
 t("set num min",()=>{nf.min=7;return [typeof nf.min,nf.min]});
 // assign fields
 t("assign fields arr",()=>{const x=new Collection({name:"x1",type:"base"}); x.fields=[new TextField({name:"a"})]; return [x.fields.length, typeof x.fields.fieldNames, x.fields.fieldNames&&x.fields.fieldNames()]});
 t("assign fields list",()=>{const x=new Collection({name:"x1",type:"base"}); x.fields=new FieldsList([{name:"a",type:"text"}]); return [x.fields.length,x.fields.fieldNames()]});
 t("assign indexes",()=>{const x=new Collection({name:"x1",type:"base"}); x.indexes=["a"]; x.indexes.push("b"); return [x.indexes.length, x.indexes]});
 t("indexes splice",()=>{const x=new Collection({name:"x1",type:"base",indexes:["a","b"]}); x.indexes.splice(0,1); return x.indexes});
 t("indexes map",()=>{const x=new Collection({name:"x1",type:"base",indexes:["a","b"]}); return [x.indexes.map(v=>v+"!"),Array.isArray(x.indexes.map(v=>v))]});
 t("select values push",()=>{const f=new SelectField({name:"s",values:["a"]}); f.values.push("b"); return f.values});
 t("identity push",()=>{users.passwordAuth.identityFields.push("name"); const n=users.passwordAuth.identityFields.length; users.passwordAuth.identityFields.pop(); return n});
 // keys
 t("keys settings",()=>Object.keys(app.settings()));
 t("keys meta",()=>Object.keys(app.settings().meta));
 t("in rec",()=>["id" in r,"getString" in r,"nope" in r]);
 t("hasOwn",()=>[Object.hasOwn?Object.hasOwn(r,"id"):0, r.hasOwnProperty("id")]);
 t("record string",()=>String(r).length);
 t("coll string",()=>String(c).length);
 t("field string",()=>String(new TextField({name:"x"})));
 t("r.nope",()=>r.nope);
 t("r.nope set",()=>{r.nope=1;return r.nope});
 t("r.id set",()=>{const z=new Record(c);z.id="abc";return z.id});
 t("r.collectionId",()=>r.collectionId);
 t("stringify rec",()=>r);
 t("stringify list",()=>c.fields);
 t("stringify field",()=>c.fields[0]);
 t("stringify list spread",()=>[...c.fields].length);
 t("Array.from",()=>Array.from(c.fields).length);
 t("isArray",()=>Array.isArray(c.fields));
 t("list instanceof",()=>c.fields instanceof FieldsList);
 t("list instanceof Array",()=>c.fields instanceof Array);
 t("field ctor",()=>new TextField({name:"a"}) instanceof TextField);
 t("field Field",()=>new TextField({name:"a"}) instanceof Field);
 t("field2",()=>new Field({name:"a",type:"text"}) instanceof Field);
 t("field3",()=>new Field({name:"a",type:"text"}) instanceof TextField);
 t("field unknown",()=>new Field({name:"a",type:"nope"}));
 t("field nodata",()=>new Field());
 t("coll list",()=>c.fields.getByName("title") instanceof TextField);
});
`,
  values:
    helpers +
    String.raw`
migrate((app)=>{
 const {users,c,u,r}=seed(app);
 // 1 durations
 t("static 60e9",()=>dur(u.newStaticAuthToken(60*1e9)));
 t("static none",()=>dur(u.newStaticAuthToken()));
 t("static 0",()=>dur(u.newStaticAuthToken(0)));
 t("static str",()=>dur(u.newStaticAuthToken("60000000000")));
 t("static null",()=>dur(u.newStaticAuthToken(null)));
 t("static neg",()=>{try{return dur(u.newStaticAuthToken(-1))}catch(e){throw e}});
 t("tok dur",()=>users.authToken.duration);
 t("durationTime",()=>users.authToken.durationTime());
 t("otp dt",()=>users.otp.durationTime());
 t("mfa dt",()=>users.mfa.durationTime());
 t("otp keys",()=>Object.keys(users.otp));
 t("oauth keys",()=>Object.keys(users.oauth2));
 t("token keys",()=>Object.keys(users.authToken));
 t("createJWT 1.9",()=>dur($security.createJWT({a:1},"k",100.9)));
 t("createJWT none",()=>$security.createJWT({a:1},"k").length>0);
 t("createJWT str",()=>dur($security.createJWT({a:1},"k","60")));
 t("dt add",()=>{const d=new DateTime("2024-01-01 00:00:00.000Z");return [d.add(60*1e9).string()]});
 t("dt add none",()=>{const d=new DateTime("2024-01-01 00:00:00.000Z");return d.add().string()});
 t("dt addDate",()=>{const d=new DateTime("2024-01-01 00:00:00.000Z");return d.addDate(1,2,3).string()});
 t("dt sub",()=>{const d=new DateTime("2024-01-01 00:00:00.000Z");const e=new DateTime("2024-01-01 00:01:00.000Z");const s=e.sub(d);return [typeof s,s,s+0,String(s)]});
 t("dt sub secs",()=>{const d=new DateTime("2024-01-01 00:00:00.000Z");const e=new DateTime("2024-01-01 00:01:00.000Z");const s=e.sub(d);return [typeof s.seconds, s.seconds&&s.seconds(), s.milliseconds&&s.milliseconds()]});
 t("dt cmp",()=>{const d=new DateTime("2024-01-01 00:00:00.000Z");const e=new DateTime("2024-01-01 00:01:00.000Z");return [d.before(e),d.after(e),d.equal(d),d.compare(e),d.isZero(),d.unix(),d.string(),typeof d.time(),d.value&&d.value()]});
 t("dt json",()=>new DateTime("2024-01-01 00:00:00.000Z"));
 t("dt marshal",()=>new DateTime("2024-01-01 00:00:00.000Z").marshalJSON());
 t("dt str",()=>String(new DateTime("2024-01-01 00:00:00.000Z")));
 t("dt keys",()=>Object.keys(new DateTime("2024-01-01 00:00:00.000Z")));
 t("dt arith",()=>new DateTime("2024-01-01 00:00:00.000Z")+"");
 t("dt scan",()=>{const d=new DateTime();d.scan("2020-02-02 00:00:00.000Z");return d.string()});
 t("dt unmarshal",()=>{const d=new DateTime();d.unmarshalJSON('"2020-02-02 00:00:00.000Z"');return d.string()});
 // 5 bytes
 t("toString toBytes",()=>toString(toBytes("abc")));
 t("toBytes arr",()=>toBytes([97,98]));
 t("toBytes arr str",()=>toString(toBytes([97,98])));
 t("toBytes str arr",()=>toBytes(["a","b"]));
 t("toBytes big",()=>toBytes([300,1]));
 t("toBytes num",()=>toBytes(5));
 t("toBytes float",()=>toBytes(1.5));
 t("toBytes bool",()=>toBytes(true));
 t("toBytes obj",()=>toBytes({a:1}));
 t("toBytes undefined",()=>toBytes());
 t("toBytes record",()=>toBytes(r).length>0);
 t("toBytes json",()=>toString(toBytes(r.get("config"))));
 t("toBytes dt",()=>toString(toBytes(new DateTime("2024-01-01 00:00:00.000Z"))));
 t("toString arr",()=>toString([97,98,99]));
 t("toString undefined",()=>toString());
 t("toString rec",()=>toString(r).length>10);
 t("toString dt",()=>toString(new DateTime("2024-01-01 00:00:00.000Z")));
 t("toString bytes view",()=>{const b=toBytes("abc");b[0]=120;return toString(b)});
 t("toBytes slice",()=>toString(toBytes("abc").slice(1)));
 t("toBytes map",()=>toBytes("abc").map(x=>x+1));
 t("toBytes ops",()=>{const b=toBytes("abc");b.push(100);return [b.length,toString(b)]});
 t("bytes instanceof",()=>[toBytes("a") instanceof Array, typeof toBytes("a"), String(toBytes("ab")), toBytes("ab").join("-")]);
 t("encrypt bytes",()=>{const k="abcdefghijklmnopqrstuvwxyz012345";return $security.decrypt($security.encrypt(toBytes("abc"),k),k)});
 t("encrypt arr",()=>{const k="abcdefghijklmnopqrstuvwxyz012345";return $security.decrypt($security.encrypt([97,98],k),k)});
 t("encrypt str",()=>{const k="abcdefghijklmnopqrstuvwxyz012345";return $security.decrypt($security.encrypt("xx",k),k)});
 t("encrypt num",()=>{const k="abcdefghijklmnopqrstuvwxyz012345";return $security.decrypt($security.encrypt(5,k),k)});
 t("encrypt badkey",()=>$security.encrypt("x","short"));
 t("decrypt bad",()=>$security.decrypt("x","abcdefghijklmnopqrstuvwxyz012345"));
 t("md5 bytes",()=>$security.md5(toBytes("a")));
 t("md5 arr",()=>$security.md5([97]));
 t("md5 num",()=>$security.md5(5));
 t("md5 none",()=>$security.md5());
 t("sha256 bytes",()=>$security.sha256(toBytes("a")));
 t("hs256 bytes",()=>$security.hs256(toBytes("a"),toBytes("k")));
 t("equal bytes",()=>$security.equal(toBytes("a"),toBytes("a")));
 t("equal mixed",()=>$security.equal(toBytes("a"),"a"));
 t("randomString none",()=>$security.randomString());
 t("randomString str",()=>$security.randomString("3").length);
 t("randomString 2.7",()=>$security.randomString(2.7).length);
 t("regex none",()=>$security.randomStringByRegex("[a]{2}",5));
 t("regex bad",()=>$security.randomStringByRegex("("));
 t("parsejwt none",()=>$security.parseJWT());
 t("parseUnv none",()=>$security.parseUnverifiedJWT());
 // os
 const dir=$os.getwd()+"/bindings-tmp";
 t("mkdir",()=>$os.mkdirAll(dir,0o755));
 t("writeFile str",()=>{$os.writeFile(dir+"/a.txt","abc",0o644);return toString($os.readFile(dir+"/a.txt"))});
 t("writeFile bytes",()=>{$os.writeFile(dir+"/b.txt",toBytes("xyz"),0o644);return toString($os.readFile(dir+"/b.txt"))});
 t("writeFile arr",()=>{$os.writeFile(dir+"/c.txt",[97,98],0o644);return toString($os.readFile(dir+"/c.txt"))});
 t("writeFile noperm",()=>{$os.writeFile(dir+"/d.txt","q");return $os.stat(dir+"/d.txt").mode()});
 t("readFile",()=>$os.readFile(dir+"/a.txt"));
 t("readFile enc",()=>{const k="abcdefghijklmnopqrstuvwxyz012345";return $security.decrypt($security.encrypt($os.readFile(dir+"/a.txt"),k),k)});
 t("readFile miss",()=>$os.readFile(dir+"/zz"));
 t("stat",()=>{const s=$os.stat(dir+"/a.txt");return [s.name(),s.size(),s.isDir(),typeof s.modTime(),s.mode(),typeof s.sys]});
 t("stat modTime",()=>{const s=$os.stat(dir+"/a.txt");const x=s.modTime();return [typeof x.unix,typeof x.year]});
 t("stat dir mode",()=>$os.stat(dir).mode());
 t("readDir",()=>$os.readDir(dir).map(e=>[e.name(),e.isDir(),typeof e.info,typeof e.type]));
 t("readDir info",()=>$os.readDir(dir)[0].info().size());
 t("getenv none",()=>$os.getenv());
 t("args",()=>Array.isArray($os.args));
 t("getwd",()=>typeof $os.getwd());
 t("remove",()=>$os.remove(dir+"/a.txt"));
 t("remove miss",()=>$os.remove(dir+"/a.txt"));
 t("removeAll",()=>$os.removeAll(dir));
 t("removeAll none",()=>$os.removeAll());
 t("mkdir none",()=>$os.mkdir());
 t("truncate miss",()=>$os.truncate(dir+"/zz",0));
 t("rename miss",()=>$os.rename(dir+"/zz",dir+"/yy"));
 t("os keys",()=>Object.keys($os).sort());
 t("fp keys",()=>Object.keys($filepath).sort());
 t("sec keys",()=>Object.keys($security).sort());
 t("dbx keys",()=>Object.keys($dbx).sort());
 t("fp none",()=>[$filepath.base(),$filepath.clean(),$filepath.dir(),$filepath.ext(),$filepath.fromSlash(),$filepath.toSlash(),$filepath.isAbs(),$filepath.join(),$filepath.split(),$filepath.splitList()]);
 t("fp rel none",()=>$filepath.rel());
 t("fp rel",()=>$filepath.rel("/a","/b/c"));
 t("fp rel2",()=>$filepath.rel("a","/b"));
 t("fp vals",()=>[$filepath.base("/a/b/"),$filepath.base("/"),$filepath.clean("a//b/../c/"),$filepath.dir("/a/b/c"),$filepath.dir("a"),$filepath.ext("a.tar.gz"),$filepath.isAbs("/a"),$filepath.join("a","","b/"),$filepath.join(),$filepath.split("/a/b.c"),$filepath.splitList("/a:/b")]);
 t("fp num",()=>$filepath.base(5));
 t("readerToString",()=>readerToString("x"));
 t("sleep",()=>sleep());
 t("sleep str",()=>sleep("1"));
});
`,
  "records-fields":
    helpers +
    String.raw`
migrate((app)=>{
 const {users,c,u,r}=seed(app);
 // 2 FieldsList with real effects
 const fresh=()=>new Collection({name:"x",type:"base",fields:[{id:"a",name:"a",type:"text"},{id:"b",name:"b",type:"text"},{id:"d",name:"d",type:"number"}]});
 const names=(x)=>x.fields.map(f=>f.name);
 t("splice",()=>{const x=fresh();const s=x.fields.splice(1,1);return [names(x),s.length,s[0].name,Array.isArray(s)]});
 t("push",()=>{const x=fresh();const n=x.fields.push(new TextField({id:"z",name:"z"}));return [n,names(x)]});
 t("pop",()=>{const x=fresh();const p=x.fields.pop();return [p.name,names(x)]});
 t("shift",()=>{const x=fresh();const p=x.fields.shift();return [p.name,names(x)]});
 t("unshift",()=>{const x=fresh();x.fields.unshift(new TextField({id:"z",name:"z"}));return names(x)});
 t("reverse",()=>{const x=fresh();x.fields.reverse();return names(x)});
 t("sort",()=>{const x=fresh();x.fields.sort((p,q)=>p.name<q.name?1:-1);return names(x)});
 t("fill",()=>{const x=fresh();x.fields.fill(new TextField({id:"z",name:"z"}),1);return names(x)});
 t("copyWithin",()=>{const x=fresh();x.fields.copyWithin(0,1);return names(x)});
 t("idx",()=>{const x=fresh();x.fields[0]=new TextField({id:"z",name:"z"});return names(x)});
 t("idx append",()=>{const x=fresh();x.fields[3]=new TextField({id:"z",name:"z"});return names(x)});
 t("length0",()=>{const x=fresh();x.fields.length=1;return names(x)});
 t("delete",()=>{const x=fresh();delete x.fields[0];return x.fields.length});
 t("in",()=>{const x=fresh();return [0 in x.fields,9 in x.fields,"add" in x.fields, "length" in x.fields]});
 t("keys",()=>Object.keys(fresh().fields));
 t("slice",()=>{const s=fresh().fields.slice(0,2);return [Array.isArray(s),s.length,typeof s.add]});
 t("filter",()=>{const s=fresh().fields.filter(f=>f.name!="a");return [Array.isArray(s),s.length,typeof s.add]});
 t("find",()=>fresh().fields.find(f=>f.name=="b").id);
 t("cb args",()=>{const x=fresh();const o=[];x.fields.forEach((f,i,arr)=>o.push([f.name,i,arr===x.fields,arr.length]));return o});
 t("cb mutate",()=>{const x=fresh();x.fields.forEach(f=>{f.required=true});return x.fields[0].required});
 t("field idx mutate",()=>{const x=fresh();x.fields[0].name="q";return names(x)});
 t("identity",()=>{const x=fresh();return [x.fields[0]===x.fields[0],x.fields[0]===x.fields.getByName("a"),x.fields===x.fields]});
 t("concat",()=>fresh().fields.concat([1]).length);
 t("join",()=>fresh().fields.join("|").length);
 t("add ret",()=>{const x=fresh();x.fields.add(new TextField({name:"b"}));return x.fields.fieldNames()});
 t("add none",()=>{const x=fresh();x.fields.add();return x.fields.length});
 t("addAt none",()=>{const x=fresh();x.fields.addAt();return x.fields.length});
 t("addMarshaled str",()=>{const x=fresh();x.fields.addMarshaledJSON('{"name":"j","type":"text"}');return x.fields.fieldNames()});
 t("addMarshaled bytes",()=>{const x=fresh();x.fields.addMarshaledJSON(toBytes('{"name":"j","type":"text"}'));return x.fields.fieldNames()});
 t("addMarshaledAt",()=>{const x=fresh();x.fields.addMarshaledJSONAt(0,'[{"name":"j","type":"text"}]');return x.fields.fieldNames()});
 t("getByName none",()=>fresh().fields.getByName());
 t("getById none",()=>fresh().fields.getById());
 t("removeByName none",()=>fresh().fields.removeByName());
 t("marshalJSON",()=>typeof fresh().fields.marshalJSON);
 t("list marshal str",()=>toString(new FieldsList([{name:"a",type:"text",id:"i"}]).marshalJSON()));
 t("list value",()=>new FieldsList([{name:"a",type:"text",id:"i"}]).value());
 t("list clone",()=>{const l=fresh().fields.clone();return [Array.isArray(l),l.length,typeof l.add]});
 t("list scan",()=>{const l=new FieldsList();l.scan('[{"name":"a","type":"text","id":"i"}]');return l.length});
 t("list unmarshal",()=>{const l=new FieldsList();l.unmarshalJSON('[{"name":"a","type":"text","id":"i"}]');return l.length});
 t("save splice",()=>{const x=new Collection({name:"s1",type:"base",fields:[{name:"p",type:"text"},{name:"q",type:"text"}]});app.save(x);const y=app.findCollectionByNameOrId("s1");y.fields.splice(y.fields.length-1,1);app.save(y);return app.findCollectionByNameOrId("s1").fields.fieldNames()});
 t("save reverse",()=>{const y=app.findCollectionByNameOrId("s1");y.fields.reverse();app.save(y);return app.tableColumns("s1")});
 // 7 maps
 t("asMap title",()=>c.fields.asMap().title.name);
 t("asMap keys",()=>Object.keys(c.fields.asMap()).sort());
 t("asMap json",()=>Object.keys(JSON.parse(JSON.stringify(c.fields.asMap()))).length);
 t("asMap miss",()=>c.fields.asMap().nope);
 t("asMap in",()=>["title" in c.fields.asMap()]);
 t("asMap entries",()=>Object.entries(c.fields.asMap()).length);
 t("asMap inst",()=>c.fields.asMap() instanceof Object);
 t("expand ok",()=>{const e=app.expandRecord(r,["author"]);return [Object.keys(e),r.expandedOne("author").id,typeof e, e]});
 t("expand fail",()=>{const e=app.expandRecord(r,["nope"]);return [Object.keys(e),String(e.nope),e.nope.message,e.nope.error&&e.nope.error()]});
 t("expands fail",()=>{const e=app.expandRecords([r],["nope","author"]);return [Object.keys(e),String(e.nope)]});
 t("expand cb",()=>{const rr=app.findRecordById("things",r.id);const seen=[];const e=app.expandRecord(rr,["author"],(col,ids)=>{seen.push(col.name,ids);return []});return [seen,Object.keys(e),rr.expandedOne("author")]});
 t("expand cb find",()=>{const rr=app.findRecordById("things",r.id);app.expandRecord(rr,["author"],(col,ids)=>app.findRecordsByIds(col,ids));return rr.expandedOne("author").id});
 t("expands cb",()=>{const rr=app.findRecordById("things",r.id);const e=app.expandRecords([rr],["author"],(col,ids)=>{return []});return [Object.keys(e),rr.expandedOne("author")]});
 t("expand cb null",()=>{const rr=app.findRecordById("things",r.id);const e=app.expandRecord(rr,["author"],(col,ids)=>null);return [Object.keys(e),rr.expandedOne("author")]});
 t("expand cb nonarr",()=>{const rr=app.findRecordById("things",r.id);const e=app.expandRecord(rr,["author"],(col,ids)=>5);return [Object.keys(e),e.author&&String(e.author)]});
 t("expand null cb",()=>{const rr=app.findRecordById("things",r.id);const e=app.expandRecord(rr,["author"],null);return [Object.keys(e),rr.expandedOne("author").id]});
 t("expandedAll",()=>{const rr=app.findRecordById("things",r.id);app.expandRecord(rr,["authors"]);const a=rr.expandedAll("authors");return [Array.isArray(a),a.length,a[0].id,Object.keys(rr.expand()),rr.expand().authors[0].id]});
 t("setExpand",()=>{const rr=app.findRecordById("things",r.id);rr.setExpand({author:u});return [rr.expandedOne("author").id, Object.keys(rr.expand())]});
 t("mergeExpand",()=>{const rr=app.findRecordById("things",r.id);rr.mergeExpand({author:u});return rr.expandedOne("author").id});
 t("expand none",()=>app.expandRecord());
 t("tableIndexes",()=>{const m=app.tableIndexes("users");return [typeof m,Object.keys(m).sort(),Array.isArray(m)]});
 t("tableInfo",()=>app.tableInfo("things")[0]);
 t("tableInfo2",()=>{const x=app.tableInfo("things")[1];return [x.name,x.type,x.pk,x.notNull,x.defaultValue, x.index, typeof x.defaultValue]});
 t("tableInfo keys",()=>Object.keys(app.tableInfo("things")[0]));
 t("tableColumns",()=>app.tableColumns("things").slice(0,2));
 t("refs",()=>{const m=app.findCollectionReferences(users);return [typeof m,Object.keys(m).length,String(Object.keys(m)[0]).slice(0,20)]});
 t("refs excl",()=>{const m=app.findCollectionReferences(users,c.id);return Object.keys(m).length});
 t("refs cached",()=>Object.keys(app.findCachedCollectionReferences(users)).length);
 t("customData",()=>{const rr=app.findRecordById("things",r.id);rr.set("zz",1);return [rr.customData(),rr.fieldsData().title,rr.get("zz"),rr.getRaw("zz")]});
 t("publicExport",()=>Object.keys(r.publicExport()).sort());
 t("publicExport json",()=>typeof r.publicExport().config);
 t("dbExport",()=>Object.keys(r.dbExport(app)).sort());
 t("dbExport none",()=>Object.keys(r.dbExport()).length);
 t("coll dbExport",()=>Object.keys(c.dbExport(app)).sort());
 t("replaceModifiers",()=>r.replaceModifiers({"num+":2}));
 t("setIfFieldExists",()=>{const f=r.setIfFieldExists("title","z");const g=r.setIfFieldExists("nofield","z");return [f&&f.name,g]});
 t("getGeoPoint",()=>{const g=r.getGeoPoint("loc");return [g,g.lon,g.lat,typeof g.value,String(g)]});
 t("geo set",()=>{const x=new Record(c);x.set("loc",{lat:1,lon:2});return [x.get("loc"),typeof x.get("loc")]});
 t("get json",()=>{const v=r.get("config");return [Array.isArray(v),v.length,typeof v,String(v).length,v[0]]});
 t("get json a",()=>r.get("config").a);
 t("getRaw json",()=>r.getRaw("config"));
 t("get date",()=>[typeof r.get("when"),String(r.get("when")),r.get("when").isZero()]);
 t("get slices",()=>[r.get("tags"),r.get("authors"),r.getStringSlice("authors"),r.get("pic"),r.getStringSlice("title")]);
 t("get number",()=>[r.get("num"),r.getInt("num"),r.getFloat("num"),r.getInt64("num"),r.getBool("num"),r.getString("num")]);
 t("get none",()=>[r.get(),r.getString(),r.getInt(),r.getBool(),r.getFloat()]);
 t("getInt huge",()=>{const x=new Record(c);x.set("num",2**53);return [x.getInt("num"),x.getInt64("num")]});
 t("unmarshalJSONField dm",()=>{const d=new DynamicModel({a:0});r.unmarshalJSONField("config",d);return d});
 t("unmarshalJSONField obj",()=>{const d={};r.unmarshalJSONField("config",d);return d});
 t("unmarshalJSONField nope",()=>{const d={};r.unmarshalJSONField("nope",d);return d});
 t("unmarshalJSONField none",()=>r.unmarshalJSONField("config"));
 t("unmarshalJSONField arr",()=>{const d=[];r.unmarshalJSONField("config",d);return d});
 t("fresh",()=>r.fresh().id);
 t("original",()=>r.original().getString("title"));
 t("withCustomData none",()=>r.withCustomData().id);
 t("hide",()=>{const x=r.clone();x.hide("title");return Object.keys(x.publicExport()).includes("title")});
 t("unhide",()=>{const x=r.clone();x.hide("title");x.unhide("title");return Object.keys(x.publicExport()).includes("title")});
 t("tokens",()=>[u.newAuthToken().length>0,u.newVerificationToken().length>0,u.newPasswordResetToken().length>0,u.newEmailChangeToken("a@b.co").length>0,u.newFileToken().length>0]);
 t("token on base",()=>r.newAuthToken());
 t("email tok none",()=>$security.parseUnverifiedJWT(u.newEmailChangeToken()).newEmail);
 t("findFileFieldByFile",()=>r.findFileFieldByFile("x"));
 t("baseFilesPath",()=>[r.baseFilesPath(),c.baseFilesPath()]);
 t("pk",()=>[r.pk(),r.lastSavedPK(),c.pk(),new Record(c).pk()]);
 t("hookTags",()=>r.hookTags());
 t("setPassword none",()=>{const x=new Record(users);x.setPassword();return x.validatePassword("")});
 t("setRandomPassword",()=>u.clone().setRandomPassword().length);
 t("marshal",()=>toString(r.marshalJSON()).length>5);
 t("unmarshal rec str",()=>{const x=new Record(c);x.unmarshalJSON('{"title":"q"}');return x.getString("title")});
 t("unmarshal rec bytes",()=>{const x=new Record(c);x.unmarshalJSON(toBytes('{"title":"q"}'));return x.getString("title")});
 t("coll unmarshal",()=>{const x=new Collection();x.unmarshalJSON('{"name":"q","type":"base"}');return x.name});
 t("coll marshal",()=>toString(c.marshalJSON()).length>5);
 t("coll string",()=>c.string().length>5);
 t("coll rawOptions",()=>c.rawOptions);
 t("coll created",()=>[typeof c.created,String(c.created).length]);
 t("coll integrity",()=>{new Collection().integrityChecks();return 1});
 t("addIndex none",()=>{const x=new Collection({name:"i",type:"base"});x.addIndex();return x.indexes});
 t("addIndex nums",()=>{const x=new Collection({name:"i",type:"base"});x.addIndex("a",1,"b");return x.indexes});
 t("getIndex none",()=>c.getIndex());
 t("removeIndex none",()=>c.removeIndex());
 t("prepare",()=>new NumberField().prepareValue(r,"42"));
 t("prepare json",()=>new JSONField().prepareValue(r,{a:1}));
 t("prepare date",()=>String(new DateField().prepareValue(r,"2024-01-01 00:00:00.000Z")));
 t("prepare text",()=>new TextField().prepareValue(r,5));
 t("prepare bool",()=>new BoolField().prepareValue(r,"true"));
 t("prepare select",()=>new SelectField({maxSelect:2}).prepareValue(r,"a"));
 t("prepare rel",()=>new RelationField({maxSelect:1}).prepareValue(r,["a","b"]));
 t("prepare file",()=>new FileField({maxSelect:2}).prepareValue(r,["a","b"]));
 t("prepare pw",()=>{const v=new PasswordField().prepareValue(r,"abc");return typeof v});
 t("prepare email",()=>new EmailField().prepareValue(r,"a"));
 t("prepare url",()=>new URLField().prepareValue(r,"a"));
 t("prepare editor",()=>new EditorField().prepareValue(r,"a"));
 t("prepare auto",()=>new AutodateField().prepareValue(r,"a").isZero());
 t("prepare none",()=>new TextField().prepareValue());
 t("prepare via Field",()=>new Field({type:"number"}).prepareValue(r,"7"));
 t("columnType",()=>[new NumberField().columnType(app),new TextField().columnType(),new BoolField().columnType(app),new JSONField().columnType(app)]);
 t("validateValue",()=>new TextField({name:"title",required:true}).validateValue(null,app,new Record(c)));
 t("validateSettings",()=>new TextField({name:""}).validateSettings(null,app,c));
 t("field getters",()=>{const f=new TextField({name:"n",id:"i",hidden:true,system:true});f.setName("m");f.setId("j");f.setHidden(false);f.setSystem(false);return [f.getName(),f.getId(),f.getHidden(),f.getSystem()]});
 t("field setters none",()=>{const f=new TextField({name:"n"});f.setName();f.setHidden();return [f.getName(),f.getHidden()]});
 t("findSetter",()=>typeof new TextField().findSetter("x"));
 t("findGetter",()=>typeof new TextField().findGetter);
 t("rel methods",()=>[new RelationField({maxSelect:2}).isMultiple(),new SelectField({maxSelect:1}).isMultiple(),new FileField({maxSelect:3}).isMultiple()]);
 t("calc",()=>new FileField({maxSize:0}).calculateMaxBodySize&&new FileField({maxSize:0}).calculateMaxBodySize());
 t("json calc",()=>new JSONField().calculateMaxBodySize&&new JSONField().calculateMaxBodySize());
 t("editor calc",()=>new EditorField().calculateMaxBodySize&&new EditorField().calculateMaxBodySize());
 t("field value set",()=>{const f=new SelectField({name:"x"});f.values=["a"];f.maxSelect=2;return f});
 t("field unknown set",()=>{const f=new TextField({name:"x"});f.nope=1;return [f.nope,f]});
 t("field min str",()=>{const f=new TextField({name:"x"});f.min="5";return [f.min,typeof f.min]});
 t("field min float",()=>{const f=new TextField({name:"x"});f.min=1.5;return f.min});
 t("field req num",()=>{const f=new TextField({name:"x"});f.required=1;return f.required});
 t("field name num",()=>{const f=new TextField({name:"x"});f.name=5;return [f.name,typeof f.name]});
 t("coll name num",()=>{const f=new Collection({name:"x"});f.name=5;return [f.name,typeof f.name]});
 t("coll system",()=>{const f=new Collection({name:"x"});f.system="yes";return f.system});
 t("tok dur str",()=>{const f=new Collection({name:"x",type:"auth"});f.authToken.duration="60";return f.authToken.duration});
 t("tok dur float",()=>{const f=new Collection({name:"x",type:"auth"});f.authToken.duration=60.5;return f.authToken.duration});
 t("otp len",()=>{const f=new Collection({name:"x",type:"auth"});f.otp.length=9;return f.otp.length});
 t("mapped set",()=>{const f=new Collection({name:"x",type:"auth"});f.oauth2.mappedFields={id:"a"};return f.oauth2.mappedFields});
 t("providers set",()=>{const f=new Collection({name:"x",type:"auth"});f.oauth2.providers=[{name:"google",clientId:"a",clientSecret:"b"}];return [f.oauth2.providers.length,f.oauth2.providers[0].name,typeof f.oauth2.providers[0].displayName]});
 t("providers meth",()=>{const f=new Collection({name:"x",type:"auth"});f.oauth2.providers=[{name:"google"}];const p=f.oauth2.getProviderConfig("google");return p});
 t("providers push",()=>{const f=new Collection({name:"x",type:"auth"});f.oauth2.providers.push({name:"google"});return f.oauth2.providers.length});
 t("email tmpl",()=>{const f=new Collection({name:"x",type:"auth"});const e=f.verificationTemplate;return [e.subject.length>0,typeof e.resolve,typeof e.validate]});
 t("assign struct",()=>{const f=new Collection({name:"x",type:"auth"});f.authToken={duration:5,secret:"s"};return [f.authToken.duration,f.authToken.secret]});
 t("assign otp",()=>{const f=new Collection({name:"x",type:"auth"});f.otp={enabled:true,length:4};return [f.otp.enabled,f.otp.length,f.otp.duration]});
});
`,
  queries:
    helpers +
    String.raw`
migrate((app)=>{
 const {users,c,u,r}=seed(app);
 const db=app.db();
 // 4 query destinations
 t("one Rc",()=>{const o=new Record(c);app.recordQuery(c).one(o);return [o.getString("title"),o.id,o.isNew(),o.collection().name]});
 t("one R",()=>{const o=new Record();app.recordQuery(c).one(o);return [o.getString("title"),o.id,o.isNew(),o.collection().name]});
 t("one Rc wrongcoll",()=>{const o=new Record(users);app.recordQuery(c).one(o);return [o.getString("title"),o.collection().name]});
 t("one Rc name",()=>{const o=new Record(c);app.recordQuery("things").one(o);return o.getString("title")});
 t("all Rc",()=>{const a=arrayOf(new Record(c));app.recordQuery(c).all(a);return [a.length,a[0].getString("title"),a[0].isNew()]});
 t("all R",()=>{const a=arrayOf(new Record());app.recordQuery(c).all(a);return [a.length,a[0].getString("title")]});
 t("model Rc",()=>{const o=new Record(c);app.recordQuery(c).model(r.id,o);return [o.getString("title"),o.id]});
 t("model R",()=>{const o=new Record();app.recordQuery(c).model(r.id,o);return [o.getString("title"),o.id]});
 t("model miss",()=>{const o=new Record(c);app.recordQuery(c).model("nope",o);return o.id});
 t("one miss",()=>{const o=new Record(c);app.recordQuery(c).where($dbx.hashExp({id:"x"})).one(o);return o.id});
 t("one plain db Rc",()=>{const o=new Record(c);db.select("*").from("things").one(o);return [o.id,o.getString("title")]});
 t("model plain db Rc",()=>{const o=new Record(c);db.select("*").model(r.id,o);return [o.id,o.getString("title")]});
 t("one Coll",()=>{const o=new Collection();app.collectionQuery().where($dbx.hashExp({name:"things"})).one(o);return [o.name,o.fields.length,o.isNew()]});
 t("all Coll",()=>{const a=arrayOf(new Collection());app.collectionQuery().orderBy("name ASC").all(a);return [a.length,a[0].name,typeof a[0].fieldNames,a[0].fields.length]});
 t("model Coll",()=>{const o=new Collection();app.collectionQuery().model(c.id,o);return [o.name]});
 t("one obj",()=>{const o={};db.select("id").from("things").one(o);return o});
 t("one dm model",()=>{const o=new DynamicModel({id:""});db.select("*").from("things").model(r.id,o);return o});
 t("all arr",()=>{const a=[];db.select("id").from("things").all(a);return a});
 t("all obj",()=>{const a={};db.select("id").from("things").all(a);return a});
 t("all arrof str",()=>{const a=arrayOf("");db.select("id").from("things").all(a);return a});
 t("column arr",()=>{const a=[];db.select("id").from("things").column(a);return a});
 t("column arrof num",()=>{const a=arrayOf(0);db.select("num").from("things").column(a);return a});
 t("column arrof bool",()=>{const a=arrayOf(false);db.select("flag").from("things").column(a);return a});
 t("column none",()=>{db.select("id").from("things").column();return 1});
 t("all none",()=>{db.select("id").from("things").all();return 1});
 t("row none",()=>db.select("id").from("things").row());
 t("row arg",()=>{const x=[""];const y={};db.select("id").from("things").row(x);return [x,y]});
 t("q row",()=>{let x="";db.newQuery("select 1").row(x);return x});
 t("rows",()=>{const rs=db.select("id").from("things").rows();const o=[];while(rs.next()){const m={};rs.scanMap(m);o.push(m)}rs.close();return o});
 t("rows struct",()=>{const rs=db.select("id").from("things").rows();rs.next();const d=new DynamicModel({id:""});rs.scanStruct(d);rs.close();return d});
 t("build sql",()=>{const q=db.select("id").from("things").where($dbx.hashExp({id:"x"})).build();return [q.sql(),q.params(),typeof q.prepare]});
 t("build params",()=>{const q=db.newQuery("select {:a}").bind({a:1});return [q.sql(),q.params()]});
 t("q prepare close",()=>{const q=db.newQuery("select 1 as a").prepare();const o=new DynamicModel({a:0});q.one(o);q.close();return o});
 t("select none",()=>{const o=new DynamicModel({a:""});db.select().from("things").one(o);return 1});
 t("limit none",()=>db.select("id").from("things").limit().build().sql());
 t("limit str",()=>db.select("id").from("things").limit("1").build().sql());
 t("limit 1.5",()=>db.select("id").from("things").limit(1.5).build().sql());
 t("offset none",()=>db.select("id").from("things").offset().build().sql());
 t("where none",()=>db.select("id").from("things").where().build().sql());
 t("where null",()=>db.select("id").from("things").where(null).build().sql());
 t("where str",()=>db.select("id").from("things").where("a=1").build().sql());
 t("andWhere",()=>db.select("id").from("things").where($dbx.exp("a=1")).andWhere($dbx.exp("b=2")).orWhere($dbx.exp("c=3")).build().sql());
 t("from none",()=>db.select("id").from().build().sql());
 t("distinct none",()=>db.select("id").from("things").distinct().build().sql());
 t("distinct true",()=>db.select("id").from("things").distinct(true).build().sql());
 t("selectOption",()=>db.select("id").from("things").selectOption("SQL_X").build().sql());
 t("join",()=>db.select("id").from("things").join("LEFT JOIN","x",$dbx.exp("a=1")).innerJoin("y",$dbx.exp("1")).leftJoin("z",null).rightJoin("w",$dbx.exp("2")).build().sql());
 t("group",()=>db.select("id").from("things").groupBy("a").andGroupBy("b").having($dbx.exp("1")).andHaving($dbx.exp("2")).orHaving($dbx.exp("3")).build().sql());
 t("order",()=>db.select("id").from("things").orderBy("a DESC").andOrderBy("b").build().sql());
 t("frag",()=>db.select("id").from("things").preFragment("-- a").postFragment("-- b").build().sql());
 t("union",()=>db.select("id").from("things").union(db.newQuery("select 1")).unionAll(db.newQuery("select 2")).build().sql());
 t("andSelect",()=>db.select("id").andSelect("x").from("things").build().sql());
 t("andBind",()=>db.newQuery("x").params());
 t("withBuildHook",()=>{let n=0;db.select("1").withBuildHook((q)=>{n++;q.bind({z:1})}).build();return n});
 t("exec hook",()=>{let n=0;const q=db.newQuery("select 1").withExecHook((q,op)=>{n++;return op()});q.execute();return n});
 t("one hook",()=>{let n=0;const o=new DynamicModel({a:0});db.newQuery("select 1 as a").withOneHook((q,a,op)=>{n++;return op(a)}).one(o);return [n,o]});
 t("all hook",()=>{let n=0;const o=arrayOf(new DynamicModel({a:0}));db.newQuery("select 1 as a").withAllHook((q,a,op)=>{n++;return op(a)}).all(o);return [n,o]});
 t("builders",()=>{const n=[];const add=(q)=>n.push(q.sql());add(db.insert("t",{a:1}));add(db.upsert("t",{a:1},"a"));add(db.update("t",{a:1},null));add(db.update("t",{a:1},$dbx.exp("1")));add(db.delete("t",null));add(db.renameTable("a","b"));add(db.dropTable("a"));add(db.truncateTable("a"));add(db.addColumn("t","c","int"));add(db.dropColumn("t","c"));add(db.renameColumn("t","a","b"));add(db.createIndex("t","i","a","b"));add(db.createUniqueIndex("t","i","a"));add(db.dropIndex("t","i"));return n});
 t("createTable",()=>db.createTable("t2",{id:"int primary key",b:"text"},"strict").sql());
 t("createTable exec",()=>{db.createTable("t2",{id:"int primary key"}).execute();return app.hasTable("t2")});
 t("alterColumn",()=>db.alterColumn("t","a","int").sql());
 t("addPrimaryKey",()=>db.addPrimaryKey("t","n","a").sql());
 t("addForeignKey",()=>db.addForeignKey("t","n",["a"],["b"],"r").sql());
 t("dropPK",()=>db.dropPrimaryKey("t","n").sql());
 t("dropFK",()=>db.dropForeignKey("t","n").sql());
 t("insert none",()=>db.insert("t").sql());
 t("insert vals",()=>{const q=db.insert("t2",{id:new DateTime("2024-01-01 00:00:00.000Z")});return q.params()});
 t("begin",()=>typeof db.begin);
 t("model q2",()=>typeof db.model(r).insert);
 t("model dm",()=>{const m=new DynamicModel({id:"x"});return typeof db.model(m).update});
 t("newQuery none",()=>db.newQuery().sql());
 t("exp none",()=>$dbx.exp().build(db,{}));
 t("exp params",()=>{const p={};const s=$dbx.exp("a={:a}",{a:1}).build(db,p);return [s,p]});
 t("hash params",()=>{const p={};const s=$dbx.hashExp({a:1,b:[1,2],c:null}).build(db,p);return [s,p]});
 t("in none",()=>$dbx.in().build(db,{}));
 t("in arr",()=>$dbx.in("a",[1,2]).build(db,{}));
 t("and null",()=>$dbx.and(null,$dbx.exp("a")).build(db,{}));
 t("and none",()=>$dbx.and().build(db,{}));
 t("like none",()=>$dbx.like().build(db,{}));
 t("like nested",()=>$dbx.like("a","b").escape("x","y").build(db,{}));
 t("between none",()=>$dbx.between().build(db,{}));
 t("build none",()=>$dbx.exp("a").build());
 t("exp keys",()=>Object.keys($dbx.exp("a")));
 t("hash keys",()=>Object.keys($dbx.hashExp({a:1})));
 t("hash a",()=>$dbx.hashExp({a:1}).a);
 t("like keys",()=>Object.keys($dbx.like("a","b")));
 // finders args
 t("findCollection none",()=>app.findCollectionByNameOrId());
 t("findRecordById none",()=>app.findRecordById());
 t("findRecordById id",()=>app.findRecordById("things"));
 t("findRecordById filter",()=>{const n=[];const x=app.findRecordById("things",r.id,(q)=>{n.push(typeof q.andWhere);q.andWhere($dbx.exp("1=1"))});return [n,x.id]});
 t("filter throw",()=>app.findRecordById("things",r.id,(q)=>{throw new Error("no")}));
 t("filter ret err",()=>app.findRecordById("things",r.id,(q)=>new Error("ret")));
 t("filter ret val",()=>app.findRecordById("things",r.id,(q)=>5).id);
 t("filter null",()=>app.findRecordById("things",r.id,null).id);
 t("findRecordsByIds cb",()=>app.findRecordsByIds("things",[r.id],(q)=>{q.andWhere($dbx.exp("1=0"))}).length);
 t("findRecordsByIds none",()=>app.findRecordsByIds("things").length);
 t("findAll none",()=>app.findAllRecords("things").length);
 t("findAll exp arr",()=>app.findAllRecords("things",null).length);
 t("findRecordsByFilter 1",()=>app.findRecordsByFilter("things","id!=''").length);
 t("findRecordsByFilter none",()=>app.findRecordsByFilter("things").length);
 t("findRecordsByFilter sort",()=>app.findRecordsByFilter("things","id!=''","-id",1).length);
 t("findRecordsByFilter str",()=>app.findRecordsByFilter("things","id!=''","-id","1","0").length);
 t("findFirstFilter none",()=>app.findFirstRecordByFilter("things"));
 t("findFirstByData",()=>app.findFirstRecordByData("things","title").id);
 t("countRecords",()=>[app.countRecords("things"),app.countRecords(c)]);
 t("count none",()=>app.countRecords());
 t("findAuthEmail",()=>app.findAuthRecordByEmail("users").id);
 t("findAuthToken",()=>app.findAuthRecordByToken(u.newAuthToken()).id);
 t("findAuthToken type",()=>app.findAuthRecordByToken(u.newAuthToken(),"auth").id);
 t("findAuthToken wrong",()=>app.findAuthRecordByToken(u.newAuthToken(),"file").id);
 t("findAuthToken none",()=>app.findAuthRecordByToken());
 t("collNameUnique",()=>[app.isCollectionNameUnique("things"),app.isCollectionNameUnique("things",c.id),app.isCollectionNameUnique()]);
 t("findAll colls",()=>app.findAllCollections("view").length);
 t("findAll colls2",()=>app.findAllCollections("auth","base").length);
 t("cached",()=>app.findCachedCollectionByNameOrId("things").name);
 t("import",()=>{app.importCollections([{name:"imp1",type:"base"}],false);return app.hasTable("imp1")});
 t("import json",()=>{app.importCollectionsByMarshaledJSON(toBytes('[{"name":"imp2","type":"base"}]'),false);return app.hasTable("imp2")});
 t("import json str",()=>{app.importCollectionsByMarshaledJSON('[{"name":"imp3","type":"base"}]');return app.hasTable("imp3")});
 t("save bad",()=>app.save({}));
 t("delete bad",()=>app.delete(5));
 t("validate none",()=>app.validate());
 t("validate rec",()=>app.validate(new Record(c)));
 t("saveNoValidate settings",()=>{const s=app.settings();s.meta.appName="zz";app.saveNoValidate(s);return app.settings().meta.appName});
 t("datadir",()=>[typeof app.dataDir(),app.encryptionEnv(),app.isDev(),app.isTransactional()]);
 t("hasTable none",()=>[app.hasTable(),app.tableColumns("nope"),app.tableInfo("nope"),app.tableIndexes("nope")]);
 t("deleteTable",()=>app.deleteTable("nope"));
 t("deleteView",()=>app.deleteView("nope"));
 t("vacuum",()=>app.vacuum());
 t("auxHas",()=>app.auxHasTable("_logs"));
 t("aux tx",()=>{app.auxRunInTransaction((tx)=>{tx.auxDB().newQuery("select 1").execute()});return 1});
 t("rit nonfn",()=>app.runInTransaction(5));
 t("rit ret err",()=>app.runInTransaction((tx)=>new Error("x")));
 t("rit ret str",()=>app.runInTransaction((tx)=>"x"));
 t("dyn keys",()=>Object.keys(new DynamicModel({a:1,B:2})));
 t("dyn json",()=>new DynamicModel({a:1,bC:2}));
 t("dyn extra",()=>{const d=new DynamicModel({a:1});d.z=2;return [d.z,d]});
 t("dyn wrong",()=>{const d=new DynamicModel({a:1});d.a="x";return d.a});
 t("dyn str num",()=>{const d=new DynamicModel({a:""});d.a=5;return [d.a,typeof d.a]});
 t("dyn instance",()=>new DynamicModel({a:1}) instanceof DynamicModel);
 t("dyn nest",()=>{const d=new DynamicModel({a:{b:1},c:[1]});return [d.a,d.c]});
 t("null helpers",()=>[typeof nullString(),nullString(),nullInt(),nullBool(),nullFloat(),nullArray(),nullObject()]);
 t("unm arrof coll",()=>{const a=arrayOf(new Collection());unmarshal([{name:"demo",type:"base"}],a);return [a.length,a[0].name,typeof a[0].isBase,a[0].isBase()]});
 t("unm arrof coll save",()=>{const a=arrayOf(new Collection());unmarshal([{name:"demo2",type:"base"}],a);app.save(a[0]);return app.hasTable("demo2")});
 t("unm arrof dm",()=>{const a=arrayOf(new DynamicModel({a:0}));unmarshal([{a:1,b:2},{a:3}],a);return [a,a[0].b]});
 t("unm arrof str",()=>{const a=arrayOf("");unmarshal(["a"],a);return a});
 t("unm arrof num",()=>{const a=arrayOf(0);unmarshal([1],a);return a});
 t("unm arrof field",()=>{const a=arrayOf(new TextField());unmarshal([{name:"q"}],a);return [a.length,a[0].name,a[0].type()]});
 t("unm arrof wrong",()=>{const a=arrayOf(0);unmarshal(["a"],a);return a});
 t("unm plain arr",()=>{const a=[];unmarshal([1,{x:2}],a);return a});
 t("unm obj",()=>{const a={};unmarshal({x:1},a);return a});
 t("unm obj exist",()=>{const a={y:1};unmarshal({x:1},a);return a});
 t("unm rec",()=>{const x=new Record(c);unmarshal({title:"t"},x);return x.getString("title")});
 t("unm coll",()=>{const x=new Collection();unmarshal({name:"t"},x);return x.name});
 t("unm list",()=>{const x=new FieldsList();unmarshal([{name:"t",type:"text"}],x);return x.length});
 t("unm field",()=>{const x=new TextField();unmarshal({name:"t",max:3},x);return x.max});
 t("unm dm type",()=>{const x=new DynamicModel({a:0});unmarshal({a:"s"},x);return x});
 t("unm settings",()=>{const s=app.settings();unmarshal({meta:{appName:"U"}},s);return s.meta.appName});
 t("unm none",()=>unmarshal());
 t("unm str dst",()=>{const d="a";unmarshal("b",d);return d});
});
`,
  "coercion-settings":
    helpers +
    String.raw`
migrate((app)=>{
 const {users,c,u,r}=seed(app);
 const db=app.db();
 t("str undef",()=>[r.getString(undefined),$filepath.base(undefined),$filepath.base(null),$security.md5(null),$security.md5(undefined)]);
 t("str obj",()=>[$filepath.base({}),$filepath.base([1,2]),$filepath.base(true)]);
 t("select arr",()=>db.select(["a","b"]).from("t").build().sql());
 t("select mix",()=>db.select("a",["b"]).from("t").build().sql());
 t("from arr",()=>db.select("a").from(["t","u"]).build().sql());
 t("findAll types arr",()=>app.findAllCollections(["view"]).length);
 t("hide arr",()=>{const x=r.clone();x.hide(["title"]);return Object.keys(x.publicExport()).includes("title")});
 t("fields add arr",()=>{const x=new Collection({name:"i",type:"base"});x.fields.add([new TextField({name:"q"})]);return x.fields.fieldNames()});
 t("int null",()=>[db.select("a").limit(null).build().sql()]);
 t("int nan",()=>[db.select("a").limit("x").build().sql()]);
 t("int inf",()=>[$security.randomString(Infinity)===undefined]);
 t("bool str",()=>db.select("a").distinct("").build().sql());
 t("idx plain",()=>{const x=new Collection({name:"i",type:"base",fields:[{name:"a",type:"text"}]});x.fields[0]={name:"z",type:"text"};return 1});
 t("date min",()=>{const f=new DateField({name:"d"});f.min="2024-01-01 00:00:00.000Z";return String(f.min)});
 t("date min dt",()=>{const f=new DateField({name:"d"});f.min=new DateTime("2024-01-01 00:00:00.000Z");return String(f.min)});
 t("date get",()=>{const f=new DateField({name:"d",min:"2024-01-01 00:00:00.000Z"});return [typeof f.min,String(f.min),f.max.isZero()]});
 t("field json",()=>JSON.stringify(new NumberField({name:"a",min:1})));
 t("list map json",()=>JSON.stringify(new FieldsList([{name:"a",type:"number",min:1,id:"i"}])));
 t("coll json fields",()=>JSON.stringify(new Collection({name:"x",type:"base"}).fields).length);
 t("rec json get",()=>JSON.stringify(r.publicExport()).length);
 t("rec export",()=>r.publicExport().config);
 t("rec export when",()=>[typeof r.publicExport().when,String(r.publicExport().when)]);
 t("fieldsData",()=>r.fieldsData().config);
 t("json str",()=>[r.get("config").string(),typeof r.get("config").value,typeof r.get("config").marshalJSON]);
 t("json ops",()=>{const v=r.get("config");return [Array.isArray(v),String(v).slice(0,5),v instanceof Array]});
 t("set json bytes",()=>{const x=new Record(c);x.set("config",toBytes('{"z":1}'));return x.getString("config")});
 t("set json raw",()=>{const x=new Record(c);x.set("config",r.get("config"));return x.getString("config")});
 t("set json str",()=>{const x=new Record(c);x.set("config",'{"z":1}');return x.getString("config")});
 t("set text bytes",()=>{const x=new Record(c);x.set("title",toBytes('ab'));return x.getString("title")});
 t("set text arr",()=>{const x=new Record(c);x.set("title",[1]);return x.getString("title")});
 t("set rec",()=>{const x=new Record(c);x.set("author",u);return x.get("author")});
 t("set date dt",()=>{const x=new Record(c);x.set("when",new DateTime("2024-01-01 00:00:00.000Z"));return x.getString("when")});
 t("set date Date",()=>{const x=new Record(c);x.set("when",new Date(0));return x.getString("when")});
 t("set expand key",()=>{const x=new Record(c);x.set("expand",{a:1});return [x.expand(),x.get("expand")]});
 t("load",()=>{const x=new Record(c);x.load({title:"l",num:2,zz:1});return [x.getString("title"),x.get("zz")]});
 t("load none",()=>{const x=new Record(c);x.load();return 1});
 t("setRaw",()=>{const x=new Record(c);x.setRaw("num","7");return x.getRaw("num")});
 t("Record data str",()=>{const x=new Record(c,5);return x.getString("title")});
 t("Record bad",()=>{const x=new Record(5);return [x.id,x.isNew()]});
 t("Record empty",()=>{const x=new Record();return [x.id,x.isNew(),x.collection(),x.pk(),x.lastSavedPK()]});
 t("Record empty set id",()=>{const x=new Record();x.id="a";return x.id});
 t("Record empty json",()=>{const x=new Record();x.markAsNotNew();return x.isNew()});
 t("Collection num",()=>new Collection(5).name);
 t("Collection str",()=>new Collection("x").name);
 t("Coll json bad",()=>new Collection({name:5}).name);
 t("TextField bad",()=>new TextField({name:5}).name);
 t("DateTime num",()=>new DateTime(5).isZero());
 t("DateTime empty",()=>new DateTime("").isZero());
 t("VErr",()=>{const v=new ValidationError();return [v.code(),v.message(),String(v),v.error()]});
 t("VErr set",()=>{const v=new ValidationError("a","b");return [typeof v.setParams, Object.keys(v)]});
 t("VErr throw",()=>{try{throw new ValidationError("a","b")}catch(e){return [String(e),e.code()]}});
 t("settings fn",()=>{const s=app.settings();return [typeof s.clone,typeof s.merge,typeof s.string,s.string().length>5, s.tableName(),s.pk(),s.isNew()]});
 t("settings clone",()=>{const s=app.settings().clone();s.meta.appName="c";return [s.meta.appName==app.settings().meta.appName]});
 t("settings merge",()=>{const s=app.settings();const q=s.clone();q.meta.appName="mm";s.merge(q);return s.meta.appName});
 t("settings marshal",()=>toString(app.settings().marshalJSON()).length>5);
 t("settings json",()=>Object.keys(JSON.parse(JSON.stringify(app.settings()))));
 t("settings smtp",()=>{const s=app.settings();s.smtp.port="25";s.smtp.tls=1;return [s.smtp.port,s.smtp.tls]});
 t("settings obj assign",()=>{const s=app.settings();s.smtp={enabled:false,host:"h"};return [s.smtp.host,s.smtp.port]});
 t("settings ips",()=>{const s=app.settings();s.superuserIPs=["1.1.1.1"];s.superuserIPs.push("2.2.2.2");const n=s.superuserIPs.length;s.superuserIPs=[];return n});
 const rr=()=>{const s=app.settings();s.rateLimits.rules=[{label:"*:auth",duration:10,maxRequests:3},{label:"b",duration:5,maxRequests:2}];return s};
 t("rl filter",()=>{const s=rr();s.rateLimits.rules=s.rateLimits.rules.filter(r=>r.label==="*:auth");return s.rateLimits.rules.length});
 t("rl foreach",()=>{const s=rr();s.rateLimits.rules.forEach(r=>{r.maxRequests=100});return s.rateLimits.rules.map(r=>r.maxRequests)});
 t("rl map",()=>rr().rateLimits.rules.map(r=>r.label));
 t("rl idx",()=>{const s=rr();s.rateLimits.rules[0]={label:"demo",duration:10,maxRequests:3};return [s.rateLimits.rules[0].label,s.rateLimits.rules[0].maxRequests]});
 t("rl splice",()=>{const s=rr();s.rateLimits.rules.splice(1,0,{label:"x",duration:1,maxRequests:1});return s.rateLimits.rules.map(r=>r.label)});
 t("rl push",()=>{const s=rr();s.rateLimits.rules.push({label:"y",duration:1,maxRequests:1});return s.rateLimits.rules[2].maxRequests});
 t("rl find",()=>rr().rateLimits.rules.find(r=>r.label=="b").duration);
 t("rl sort",()=>{const s=rr();s.rateLimits.rules.sort((a,b)=>a.duration-b.duration);return s.rateLimits.rules.map(r=>r.label)});
 t("rl reverse",()=>{const s=rr();s.rateLimits.rules.reverse();return s.rateLimits.rules.map(r=>r.label)});
 t("rl pop",()=>{const s=rr();const p=s.rateLimits.rules.pop();return [p.label,s.rateLimits.rules.length]});
 t("rl len",()=>{const s=rr();s.rateLimits.rules.length=1;return s.rateLimits.rules.length});
 t("rl fill",()=>{const s=rr();s.rateLimits.rules.fill({label:"f",duration:1,maxRequests:1});return s.rateLimits.rules.map(r=>r.label)});
 t("rl copyWithin",()=>{const s=rr();s.rateLimits.rules.copyWithin(0,1);return s.rateLimits.rules.map(r=>r.label)});
 t("rl spread",()=>{const s=rr();const a=[...s.rateLimits.rules];s.rateLimits.rules=a.reverse();return s.rateLimits.rules.map(r=>r.label)});
 t("rl methods",()=>{const x=rr().rateLimits.rules[0];return [typeof x.durationTime,x.durationTime&&x.durationTime(),typeof x.string,x.string&&x.string(),typeof x.validate]});
 t("rl json",()=>rr().rateLimits.rules);
 t("rl arr check",()=>[Array.isArray(rr().rateLimits.rules),rr().rateLimits.rules instanceof Array]);
 t("rl save",()=>{const s=rr();s.rateLimits.enabled=true;s.rateLimits.rules=s.rateLimits.rules.filter(r=>r.label==="*:auth");app.save(s);return app.settings().rateLimits.rules.length});
 t("rl fnd",()=>{const s=app.settings();return typeof s.rateLimits.findRateLimitRule});
 t("rl disable",()=>{const s=app.settings();s.rateLimits.enabled=false;app.save(s);return 1});
 t("backups",()=>{const s=app.settings();s.backups.s3.enabled=false;s.backups.cron="0 0 * * *";return [s.backups.cron,s.backups.s3.bucket]});
 t("cfg methods",()=>[Object.keys(app.settings().meta),Object.keys(app.settings().batch),Object.keys(app.settings().logs),Object.keys(app.settings().s3),Object.keys(app.settings().backups),Object.keys(app.settings().rateLimits),Object.keys(app.settings().trustedProxy)]);
 t("meta validate",()=>{const m=app.settings().meta; return typeof m.validate});
 t("proxy",()=>{const p=app.settings().trustedProxy;return [p.useLeftmostIP,p.headers,typeof p.markAsLeftmost]});
 t("geo methods",()=>{const g=r.getGeoPoint("loc");return [g.string(),g.asMap().lon,g.asMap().lat,g.value()]});
 t("geo set lat",()=>{const g=r.getGeoPoint("loc");g.lat=5;return g.lat});
 t("geo scan",()=>{const g=r.getGeoPoint("loc");g.scan('{"lon":1,"lat":2}');return g});
 t("indexes",()=>{const v=users.indexes;return [typeof v.string,typeof v.value,v instanceof Array]});
 t("jsonarr str",()=>users.indexes.string().length>2);
});
`,
  // named JSON values: construction, unmarshal, hydration, driverValue, rawOptions
  jsonValues:
    helpers +
    String.raw`
migrate((app)=>{
 const dm=()=>new DynamicModel({meta:{status:"pending",n:1,nest:{a:1}},tags:["first",2],s:"",n:0});
 t("dm.meta",()=>dm().meta);
 t("dm.meta.status",()=>dm().meta.status);
 t("dm.meta typeof",()=>typeof dm().meta);
 t("dm.meta keys",()=>Object.keys(dm().meta));
 t("dm.meta get",()=>dm().meta.get("status"));
 t("dm.meta get none",()=>dm().meta.get("zz"));
 t("dm.meta get n",()=>dm().meta.get("n"));
 t("dm.meta get nest",()=>dm().meta.get("nest"));
 t("dm.meta get nest.a",()=>dm().meta.get("nest").a);
 t("dm.meta set",()=>{const d=dm();d.meta.set("x",5);return [d.meta,d.meta.get("x")]});
 t("dm.meta set prop",()=>{const d=dm();d.meta.y=5;return [d.meta,d.meta.y,d.meta.get("y")]});
 t("dm.meta string",()=>dm().meta.string());
 t("dm.meta String()",()=>String(dm().meta));
 t("dm.meta value",()=>dm().meta.value());
 t("dm.meta marshalJSON",()=>dm().meta.marshalJSON());
 t("dm.meta toStr",()=>toString(dm().meta.marshalJSON()));
 t("dm.meta scan",()=>{const d=dm();d.meta.scan('{"q":1}');return d.meta});
 t("dm.meta scan empty",()=>{const d=dm();d.meta.scan('');return d.meta});
 t("dm.meta scan null",()=>{const d=dm();d.meta.scan(null);return d.meta});
 t("dm.meta scan bytes",()=>{const d=dm();d.meta.scan(toBytes('{"r":2}'));return d.meta});
 t("dm.meta in",()=>["status" in dm().meta,"get" in dm().meta]);
 t("dm.meta isArray",()=>Array.isArray(dm().meta));
 t("dm.meta for",()=>{const o=[];for(const k in dm().meta)o.push(k);return o});
 t("dm.meta ctor",()=>dm().meta.constructor===Object);
 t("dm.meta assign obj",()=>{const d=dm();d.meta={z:1};return [d.meta,d.meta.get&&d.meta.get("z"),typeof d.meta.get]});
 t("dm.meta assign arr",()=>{const d=dm();d.meta=[1];return d.meta});
 t("dm.meta assign null",()=>{const d=dm();d.meta=null;return [d.meta,typeof d.meta]});
 t("dm.meta assign str",()=>{const d=dm();d.meta="x";return d.meta});
 t("dm.meta assign other",()=>{const d=dm();const e=dm();d.meta=e.meta;d.meta.set("k",1);return [d.meta,e.meta]});
 t("dm.tags",()=>dm().tags);
 t("dm.tags [0]",()=>dm().tags[0]);
 t("dm.tags len",()=>dm().tags.length);
 t("dm.tags isArray",()=>Array.isArray(dm().tags));
 t("dm.tags typeof",()=>typeof dm().tags);
 t("dm.tags keys",()=>Object.keys(dm().tags));
 t("dm.tags string",()=>dm().tags.string());
 t("dm.tags String()",()=>String(dm().tags));
 t("dm.tags value",()=>dm().tags.value());
 t("dm.tags marshal",()=>toString(dm().tags.marshalJSON()));
 t("dm.tags scan",()=>{const d=dm();d.tags.scan('[9]');return d.tags});
 t("dm.tags scan empty",()=>{const d=dm();d.tags.scan('');return d.tags});
 t("dm.tags scan null",()=>{const d=dm();d.tags.scan(null);return d.tags});
 t("dm.tags push",()=>{const d=dm();d.tags.push("x");return d.tags});
 t("dm.tags idx",()=>{const d=dm();d.tags[0]="x";return d.tags});
 t("dm.tags idx far",()=>{const d=dm();d.tags[5]="x";return d.tags});
 t("dm.tags map",()=>dm().tags.map(x=>x+"!"));
 t("dm.tags filter string",()=>{const x=dm().tags.filter(x=>x); return [x, typeof x.string]});
 t("dm.tags spread",()=>[...dm().tags]);
 t("dm.tags join",()=>dm().tags.join(","));
 t("dm.tags length set",()=>{const d=dm();d.tags.length=1;return d.tags});
 t("dm.tags assign",()=>{const d=dm();d.tags=[1];return [d.tags,typeof d.tags.string,d.tags.string&&d.tags.string()]});
 t("dm.tags assign null",()=>{const d=dm();d.tags=null;return [d.tags,typeof d.tags.string]});
 t("dm.tags assign str",()=>{const d=dm();d.tags="abc";return d.tags});
 t("dm.tags assign obj",()=>{const d=dm();d.tags={a:1};return d.tags});
 t("dm unmarshal",()=>{const d=dm();unmarshal({meta:{a:1},tags:[3]},d);return [d,d.meta.get("a"),d.meta.get("status"),d.tags.string()]});
 t("dm unmarshal empty",()=>{const d=dm();unmarshal({meta:{},tags:[]},d);return [d,d.meta.get("status")]});
 t("dm unmarshal null mem",()=>{const d=dm();unmarshal({meta:null,tags:null,s:null},d);return [d,typeof d.meta]});
 t("nullObject",()=>{const d=new DynamicModel({o:nullObject(),a:nullArray()});return [d,typeof d.o,d.o]});
 t("nullObject set",()=>{const d=new DynamicModel({o:nullObject()});d.o={a:1};return [d,typeof d.o,d.o.get&&d.o.get("a")]});
 t("nullObject q",()=>{const d=new DynamicModel({o:nullObject(),a:nullArray()});app.db().newQuery('SELECT \'{"a":1}\' AS o, \'[1]\' AS a').one(d);return [d,typeof d.o,typeof d.o.get,d.o.get&&d.o.get("a"),typeof d.a.string]});
 t("dm q",()=>{const d=dm();app.db().newQuery('SELECT \'{"a":1}\' AS meta, \'[1]\' AS tags').one(d);return [d,d.meta.get("a"),d.tags.string()]});
 t("dm q null",()=>{const d=dm();app.db().newQuery('SELECT NULL AS meta, NULL AS tags').one(d);return [d,d.meta.get("a"),d.tags.string()]});
 t("dm q all",()=>{const d=arrayOf(dm());app.db().newQuery('SELECT \'{"a":1}\' AS meta, \'[1]\' AS tags').all(d);return [d,d[0].meta.get("a"),d[0].tags.string()]});
 t("arrayOf unm",()=>{const d=arrayOf(dm());unmarshal([{meta:{a:1},tags:[1]}],d);return [d,d[0].meta.get("a"),d[0].tags.string()]});
 t("arrayOf unm zero",()=>{const d=arrayOf(dm());unmarshal([{}],d);return [d,d[0].meta.get&&d[0].meta.get("a"),d[0].tags.string&&d[0].tags.string()]});
 t("arrayOf q zero",()=>{const d=arrayOf(dm());app.db().newQuery('SELECT 1 AS other').all(d);return d});
 t("arrayOf zero 2",()=>{const d=arrayOf(new DynamicModel({a:7,b:"fallback",c:true,d:1.5,e:[1],f:{x:1},g:nullString()}));unmarshal([{a:1}],d);return d});
 t("copy",()=>{const d=dm();const o={...d};return Object.keys(o)});
 t("dm keys",()=>Object.keys(dm()));
 t("dm stringify",()=>JSON.stringify(dm()));
 t("col.indexes",()=>{const c=new Collection({name:"x",type:"base",indexes:["a"]});return [c.indexes.string(),c.indexes.value(),toString(c.indexes.marshalJSON())]});
 t("col.indexes scan",()=>{const c=new Collection({name:"x",type:"base",indexes:["a"]});c.indexes.scan('["b","c"]');return [c.indexes]});
 t("col.indexes scan empty",()=>{const c=new Collection({name:"x",type:"base",indexes:["a"]});c.indexes.scan('');return [c.indexes]});
 t("col.indexes scan null",()=>{const c=new Collection({name:"x",type:"base",indexes:["a"]});c.indexes.scan(null);return [c.indexes]});
 t("col.indexes scan bytes",()=>{const c=new Collection({name:"x",type:"base",indexes:["a"]});c.indexes.scan(toBytes('["z"]'));return [c.indexes]});
 t("col.indexes keys",()=>Object.keys(new Collection({name:"x",type:"base",indexes:["a"]}).indexes));
 t("col.indexes str",()=>String(new Collection({name:"x",type:"base",indexes:["a"]}).indexes));
 t("rawOptions",()=>{const c=new Collection({name:"x",type:"base"});const r=c.rawOptions;return [r,typeof r.string,r.length,typeof r.value,typeof r.scan,typeof r.marshalJSON,typeof r.unmarshalJSON]});
 t("rawOptions str",()=>new Collection({name:"x",type:"base"}).rawOptions.string());
 t("rawOptions value",()=>new Collection({name:"x",type:"base"}).rawOptions.value());
 t("rawOptions marshal",()=>new Collection({name:"x",type:"base"}).rawOptions.marshalJSON());
 t("rawOptions scan",()=>{const r=new Collection({name:"x",type:"base"}).rawOptions;r.scan('{"a":1}');return [r.string(),r]});
 t("rawOptions auth",()=>{const c=new Collection({name:"x",type:"auth"});return [c.rawOptions.length]});
 t("rawOptions view",()=>{const c=new Collection({name:"x",type:"view"});return [c.rawOptions.string()]});
 t("rawOptions view2",()=>{const c=app.findCollectionByNameOrId("users");return c.rawOptions.string().length});
 t("rawOptions set",()=>{const c=new Collection({name:"x",type:"base"});c.rawOptions=toBytes('{"a":1}');return [c.rawOptions.string?c.rawOptions.string():0, typeof c.rawOptions.string]});
});
`,
  // what each value binds, read back from the table, through every way to bind
  sqlValues:
    helpers +
    String.raw`
migrate((app)=>{
 app.db().newQuery("CREATE TABLE seed(k TEXT, v)").execute();
 const users=app.findCollectionByNameOrId("users");
 const c=new Collection({name:"things",type:"base",fields:[{name:"config",type:"json"},{name:"tags",type:"select",values:["a","b"],maxSelect:2},{name:"tag1",type:"select",values:["a","b"],maxSelect:1},{name:"rels",type:"relation",collectionId:users.id,maxSelect:5},{name:"rel1",type:"relation",collectionId:users.id,maxSelect:1},{name:"fs",type:"file",maxSelect:3,maxSize:100},{name:"f1",type:"file",maxSelect:1,maxSize:100},{name:"loc",type:"geoPoint"},{name:"pw",type:"password"},{name:"when",type:"date"},{name:"num",type:"number"},{name:"flag",type:"bool"}],indexes:["CREATE INDEX idx_x ON things (config)"],listRule:"id != ''"});
 app.save(c);
 const r=new Record(c); r.set("config",{a:1}); r.set("tags",["a"]); r.set("tag1","a"); r.set("num",3); r.set("flag",true); r.set("when","2024-01-01 00:00:00.000Z"); r.set("loc",{lon:1,lat:2}); app.save(r);
 const r2=new Record(c);
 const dm=new DynamicModel({m:{a:1},arr:[1,"x"],s:"str",n:5,f:1.5,b:true,ns:nullString(),nf:nullFloat()});
 const f=(n)=>c.fields.getByName(n);
 const cases={
  dt:()=>new DateTime("2024-01-01 00:00:00.000Z"), dtz:()=>r2.getDateTime("when"), getdt:()=>r.getDateTime("when"),
  dtnow:()=>r.get("when"),
  geo:()=>r.getGeoPoint("loc"), geoget:()=>r.get("loc"),
  raw:()=>r.get("config"), rawempty:()=>r2.get("config"), rawopts:()=>c.rawOptions,
   indexes:()=>c.indexes, fields:()=>c.fields, rule:()=>c.listRule, rulenull:()=>c.viewRule, dur:()=>users.authToken.durationTime(),
  min:()=>new NumberField({name:"n",min:5}).min,
  sub:()=>new DateTime("2024-01-01 00:00:01.000Z").sub(new DateTime("2024-01-01 00:00:00.000Z")),
  dvsel:()=>f("tags").driverValue(r), dvsel0:()=>f("tags").driverValue(r2), dvsel1:()=>f("tag1").driverValue(r), dvrel:()=>f("rels").driverValue(r), dvrel1:()=>f("rel1").driverValue(r), dvf:()=>f("fs").driverValue(r), dvf1:()=>f("f1").driverValue(r),
  dvpw:()=>f("pw").driverValue(r2),
  dmm:()=>dm.m, dmarr:()=>dm.arr, dms:()=>dm.s, dmn:()=>dm.n, dmf:()=>dm.f, dmb:()=>dm.b, dmns:()=>dm.ns,
  str:()=>"text", num:()=>5, flt:()=>1.5, flt2:()=>2.0, t:()=>true, fa:()=>false, nul:()=>null, und:()=>undefined,
  bytes:()=>toBytes("abc"), buf:()=>toBytes(""), 
  jsdate:()=>new Date(1704067200000),
  arr:()=>["a"], obj:()=>({a:1}), rec:()=>r, coll:()=>c, field:()=>f("tags"), stringify:()=>JSON.stringify({a:1}),
  big:()=>2**53, neg0:()=>-0, nan:()=>NaN, inf:()=>Infinity, 
  val:()=>r.getDateTime("when").value(), jm:()=>dm.m.value(),
  filemode:()=>$os.stat(".").mode(), time:()=>new DateTime("2024-01-01 00:00:00.000Z").time(),
 };
 const read=(k)=>{const d=new DynamicModel({t:"",v:""});app.db().newQuery("SELECT typeof(v) AS t, COALESCE(CAST(v AS TEXT),'<null>') AS v FROM seed WHERE k={:k}").bind({k}).one(d);return d.t+"|"+d.v.replace(/[a-z0-9]{15}/g,"ID")};
 for(const [k,fn] of Object.entries(cases)){
  t("bind "+k,()=>{app.db().newQuery("INSERT INTO seed(k,v) VALUES ({:k},{:v})").bind({k,v:fn()}).execute();return read(k)});
  const k2=k+"_i"; t("insert "+k,()=>{app.db().insert("seed",{k:k2,v:fn()}).execute();return read(k2)});
  const k3=k+"_u"; t("update "+k,()=>{app.db().insert("seed",{k:k3}).execute();app.db().update("seed",{v:fn()},$dbx.hashExp({k:k3})).execute();return read(k3)});
  const k4=k+"_e"; t("exp "+k,()=>{app.db().insert("seed",{k:k4}).execute();app.db().update("seed",{v:$dbx.exp("{:x}",{x:fn()})},$dbx.hashExp({k:k4})).execute();return read(k4)});
  t("hash "+k,()=>{const n=new DynamicModel({n:0});app.db().select("count(*) as n").from("seed").where($dbx.hashExp({v:fn(),k:k})).one(n);return n.n});
  t("in "+k,()=>{const n=new DynamicModel({n:0});app.db().select("count(*) as n").from("seed").where($dbx.in("v",fn())).andWhere($dbx.hashExp({k})).one(n);return n.n});
  t("between "+k,()=>{const n=new DynamicModel({n:0});app.db().select("count(*) as n").from("seed").where($dbx.between("v",fn(),fn())).andWhere($dbx.hashExp({k})).one(n);return n.n});
  t("data "+k,()=>{const n=app.findFirstRecordByData("things","config",fn());return n.id.length});
  t("filter "+k,()=>{const n=app.findFirstRecordByFilter("things","config={:x}",{x:fn()});return n.id.length});
  if(!["rec","coll","field","jsdate","time"].includes(k)) t("params "+k,()=>app.db().newQuery("SELECT 1").bind({v:fn()}).params());
 }
});
`,
  // JSON null, new slice elements, named values, nullable columns
  outputs:
    helpers +
    String.raw`
migrate((app)=>{
 const users=app.findCollectionByNameOrId("users");
 const c=new Collection({name:"things",type:"base",fields:[{name:"config",type:"json"},{name:"tags",type:"select",values:["a","b"],maxSelect:2},{name:"rels",type:"relation",collectionId:users.id,maxSelect:5},{name:"fs",type:"file",maxSelect:3,maxSize:100},{name:"title",type:"text"}]});
 app.save(c);
 const r=new Record(c); r.set("tags",["a"]); app.save(r);
 const f=(n)=>c.fields.getByName(n);
 // 2 null
 const shapes={dm:()=>new DynamicModel({a:7}), coll:()=>new Collection({name:"keep",type:"base"}), list:()=>new FieldsList([{name:"a",type:"text"}]), arrc:()=>arrayOf(new Collection()), arrd:()=>arrayOf(new DynamicModel({a:7})), arrs:()=>arrayOf(""), arrf:()=>arrayOf(new TextField()), nat:()=>[1], obj:()=>({a:1}), set:()=>app.settings().clone(), dt:()=>new DateTime("2024-01-01 00:00:00.000Z"), rec:()=>new Record(c),
  text:()=>new TextField({name:"t"}),num:()=>new NumberField({name:"t"}),bool:()=>new BoolField({name:"t"}),url:()=>new URLField({name:"t"}),email:()=>new EmailField({name:"t"}),ed:()=>new EditorField({name:"t"}),pw:()=>new PasswordField({name:"t"}),date:()=>new DateField({name:"t"}),ad:()=>new AutodateField({name:"t"}),js:()=>new JSONField({name:"t"}),rel:()=>new RelationField({name:"t"}),sel:()=>new SelectField({name:"t"}),file:()=>new FileField({name:"t"}),geo:()=>new GeoPointField({name:"t"})};
 const sum=(d)=>{let s=JSON.stringify(d); return s.length>120? s.length: s;};
 for(const [k,mk] of Object.entries(shapes)){
  t("unm null "+k,()=>{const d=mk();const b=sum(d);unmarshal(null,d);return [b===sum(d),sum(d)]});
  t("unm undef "+k,()=>{const d=mk();const b=sum(d);unmarshal(undefined,d);return b===sum(d)});
  t("field null "+k,()=>{const d=mk();const b=sum(d);r.unmarshalJSONField("config",d);return [b===sum(d),sum(d)]});
 }
 t("el null coll",()=>{const d=arrayOf(new Collection());unmarshal([null,{name:"x",type:"base"}],d);return [d.length,d[0],d[1].name]});
 t("el null txt",()=>{const d=arrayOf(new TextField());unmarshal([null,{name:"x"}],d);return [d.length,d[0],d[1].name]});
 t("el null dm",()=>{const d=arrayOf(new DynamicModel({a:7}));unmarshal([null,{a:1}],d);return d});
 t("el null str",()=>{const d=arrayOf("");unmarshal([null,"a"],d);return d});
 t("el null num",()=>{const d=arrayOf(0);unmarshal([null,1],d);return d});
 t("el null field-json",()=>{r.set("config",[null,{a:1}]);const d=arrayOf(new DynamicModel({a:7}));r.unmarshalJSONField("config",d);r.set("config",null);return d});
 t("el null nstr",()=>{const d=arrayOf(nullString());unmarshal([null,"a"],d);return [d,typeof d[1],d[1]=="a",d[1]==="a"]});
 t("el null nint",()=>{const d=arrayOf(nullInt());unmarshal([null,5],d);return [d,typeof d[1]]});
 t("member null",()=>{const d=new DynamicModel({s:"x",n:5,b:true,f:1.5});unmarshal({s:null,n:null,b:null,f:null},d);return d});
 // 3 zero
 const zshape=()=>new DynamicModel({a:7,b:"fallback",c:true,d:1.5,e:[1],f:{x:1},g:nullString(),h:nullArray(),i:nullObject(),j:new DateTime("2024-01-01 00:00:00.000Z")});
 t("zero unm",()=>{const d=arrayOf(zshape());unmarshal([{a:1}],d);return [d,d[0].j.isZero&&d[0].j.isZero()]});
 t("zero q",()=>{const d=arrayOf(zshape());app.db().newQuery("SELECT 1 AS other").all(d);return d});
 t("zero fld",()=>{r.set("config",[{a:1}]);const d=arrayOf(zshape());r.unmarshalJSONField("config",d);r.set("config",null);return d});
 t("zero shape unchanged",()=>{const s=zshape();const d=arrayOf(s);unmarshal([{a:1},{a:2}],d);d[0].e.push(1);return [s.a,s.e,s.f,d[1].e,d[1].f]});
 t("single keeps",()=>{const d=zshape();unmarshal({a:1},d);return d});
 t("single q keeps",()=>{const d=zshape();app.db().newQuery("SELECT 1 AS a").one(d);return d});
 // 4 named
 for(const n of ["tags","rels","fs"]){
  t("dv keys "+n,()=>Object.keys(f(n).driverValue(r)));
  t("dv str "+n,()=>f(n).driverValue(r).string());
  t("dv val "+n,()=>f(n).driverValue(r).value());
  t("dv marsh "+n,()=>toString(f(n).driverValue(r).marshalJSON()));
  t("dv String "+n,()=>String(f(n).driverValue(r)));
  t("dv scan "+n,()=>{const v=f(n).driverValue(r);v.scan('["z"]');return v});
  t("dv scan bad "+n,()=>{const v=f(n).driverValue(r);try{v.scan('[1]')}catch(e){};return v});
  t("dv push "+n,()=>{const v=f(n).driverValue(r);v.push(5);return [v,v.string()]});
 }
 t("toString dmm",()=>toString(new DynamicModel({m:{b:1,a:2}}).m));
 t("toString dma",()=>toString(new DynamicModel({m:[1,"x"]}).m));
 t("toBytes dmm",()=>toString(toBytes(new DynamicModel({m:{b:1,a:2}}).m)));
 t("toBytes dma",()=>toString(toBytes(new DynamicModel({m:[1,"x"]}).m)));
 t("toBytes dmn",()=>toBytes(new DynamicModel({m:[1,2]}).m));
 t("rec set map",()=>{const q=new Record(c);q.set("config",new DynamicModel({m:{b:1,a:2}}).m);app.save(q);return app.findRecordById("things",q.id).get("config").string()});
 t("rec set arr",()=>{const q=new Record(c);q.set("config",new DynamicModel({m:[1,"x"]}).m);q.set("tags",new DynamicModel({m:["a","b"]}).m);app.save(q);const z=app.findRecordById("things",q.id);return [z.get("config").string(),z.get("tags")]});
 t("new rec dm",()=>{const d=new DynamicModel({title:"t",config:{a:1},tags:["a"]});const q=new Record(c,d);return q.getString("title")});
 t("new rec obj",()=>{const d=new DynamicModel({m:{a:1}});const q=new Record(c,{config:d.m});return q.get("config").string()});
 t("rec dbExport",()=>{const e=r.dbExport(app);return [Object.keys(e).sort(),e.tags,typeof e.tags.string,e.config]});
 t("insert dbExport",()=>{app.db().newQuery("CREATE TABLE t2(id TEXT,tags TEXT)").execute();const e=r.dbExport(app);app.db().insert("t2",{id:"1",tags:e.tags}).execute();const d=new DynamicModel({tags:""});app.db().newQuery("SELECT tags FROM t2").one(d);return d});
 t("bind map",()=>{const d=new DynamicModel({m:{v:"x"}});const o=new DynamicModel({v:""});app.db().newQuery("SELECT {:v} AS v").bind(d.m).one(o);return o});
 t("collection save raw",()=>{const x=new Collection({name:"ro",type:"base"});x.rawOptions=toBytes('{"viewQuery":""}');app.save(x);return app.findCollectionByNameOrId("ro").name});
 t("get map iter",()=>{const d=new DynamicModel({m:{a:{b:{c:1}},z:[1,{y:2}]}});const v=d.m.get("a");v.b.c=2;return [d.m,d.m.get("z"),typeof d.m.get("z"),Array.isArray(d.m.get("z"))]});
 t("set obj",()=>{const d=new DynamicModel({m:{}});d.m.set("o",{z:1,a:2});d.m.set("r",[3]);d.m.set("dt",new DateTime("2024-01-01 00:00:00.000Z"));return [d.m,d.m.get("o").z,d.m.get("dt")]});
 t("arr el obj",()=>{const d=new DynamicModel({m:[{b:1,a:2}]});return [d.m[0].a,d.m.string()]});
 t("arr set obj",()=>{const d=new DynamicModel({m:[]});d.m.push({b:1});return [d.m,d.m[0].b,d.m.string()]});
 // 6
 t("col str",()=>{const d=arrayOf(nullString());app.db().newQuery("SELECT 'hello' AS v UNION ALL SELECT NULL").column(d);return [d,typeof d[0],d[0]=="hello",d[0]==="hello",String(d[0]),d[1]]});
 t("col int",()=>{const d=arrayOf(nullInt());app.db().newQuery("SELECT 5 AS v UNION ALL SELECT NULL").column(d);return [d,typeof d[0],d[0]+1]});
 t("col float",()=>{const d=arrayOf(nullFloat());app.db().newQuery("SELECT 1.5 AS v UNION ALL SELECT NULL").column(d);return [d,typeof d[0],d[0]+1]});
 t("col bool",()=>{const d=arrayOf(nullBool());app.db().newQuery("SELECT 1 AS v UNION ALL SELECT NULL").column(d);return [d,typeof d[0]]});
 t("col bool f",()=>{const d=arrayOf(nullBool());app.db().newQuery("SELECT 0 AS v").column(d);return [d, d[0]==false]});
 t("col arr",()=>{const d=arrayOf(nullArray());app.db().newQuery("SELECT '[1]' AS v UNION ALL SELECT NULL").column(d);return [d]});
 t("col obj",()=>{const d=arrayOf(nullObject());app.db().newQuery('SELECT \'{"a":1}\' AS v UNION ALL SELECT NULL').column(d);return [d,d[0].get("a")]});
 t("col sel str",()=>{const d=arrayOf(nullString());app.db().select("title").from("things").column(d);return d});
 t("col str plain",()=>{const d=arrayOf("");app.db().newQuery("SELECT 'a' AS v").column(d);return d});
 t("col bind back",()=>{const d=arrayOf(nullString());app.db().newQuery("SELECT 'hello' AS v").column(d);const o=new DynamicModel({v:""});app.db().newQuery("SELECT {:v} AS v").bind({v:d[0]}).one(o);return o});
 t("all nstr",()=>{const d=arrayOf(nullString());app.db().newQuery("SELECT 'x' AS v").all(d);return d});
});
`,
  // the Go fields and methods of each class, and no internal member
  surface: String.raw`
const walk=(label,o,names)=>{for(const n of names){let ty; try{ty=typeof o[n]}catch(e){ty="THROW "+e.message} console.log(label,n,ty)}};
migrate((app)=>{
 const users=app.findCollectionByNameOrId("users");
 walk("Collection",users,["tableName","baseFilesPath","isBase","isAuth","isView","integrityChecks","postScan","unmarshalJSON","marshalJSON","string","dbExport","getIndex","addIndex","removeIndex","id","lastSavedPK","pk","isNew","markAsNew","markAsNotNew","listRule","viewRule","createRule","updateRule","deleteRule","rawOptions","name","type","fields","indexes","created","updated","system","authRule","manageRule","authAlert","oauth2","passwordAuth","mfa","otp","authToken","passwordResetToken","emailChangeToken","verificationToken","fileToken","verificationTemplate","resetPasswordTemplate","confirmEmailChangeTemplate","viewQuery"]);
 walk("base",new Collection({type:"base",name:"x"}),["tableName","baseFilesPath","isBase","isAuth","isView","integrityChecks","postScan","unmarshalJSON","marshalJSON","string","dbExport","getIndex","addIndex","removeIndex","id","lastSavedPK","pk","isNew","markAsNew","markAsNotNew","listRule","viewRule","createRule","updateRule","deleteRule","rawOptions","name","type","fields","indexes","created","updated","system","authRule","manageRule","authAlert","oauth2","passwordAuth","mfa","otp","authToken","passwordResetToken","emailChangeToken","verificationToken","fileToken","verificationTemplate","resetPasswordTemplate","confirmEmailChangeTemplate","viewQuery"]);
 const r=new Record(users); r.setEmail("a@b.co");
 walk("Record",r,["collection","tableName","postScan","hookTags","baseFilesPath","original","fresh","clone","expand","setExpand","mergeExpand","fieldsData","customData","withCustomData","ignoreEmailVisibility","ignoreUnchangedFields","setRaw","setIfFieldExists","set","getRaw","get","load","getBool","getString","getInt","getInt64","getFloat","getDateTime","getGeoPoint","getStringSlice","getUnsavedFiles","getUploadedFiles","unmarshalJSONField","expandedOne","expandedAll","findFileFieldByFile","dbExport","hide","unhide","publicExport","marshalJSON","unmarshalJSON","replaceModifiers","email","setEmail","emailVisibility","setEmailVisibility","verified","setVerified","tokenKey","setTokenKey","refreshTokenKey","setPassword","setRandomPassword","validatePassword","isSuperuser","newStaticAuthToken","newAuthToken","newVerificationToken","newPasswordResetToken","newEmailChangeToken","newFileToken","id","lastSavedPK","pk","isNew","markAsNew","markAsNotNew"]);
 walk("EmptyRecord",new Record(),["collection","tableName","postScan","hookTags","baseFilesPath","original","fresh","clone","expand","setExpand","mergeExpand","fieldsData","customData","withCustomData","ignoreEmailVisibility","ignoreUnchangedFields","setRaw","setIfFieldExists","set","getRaw","get","load","getBool","getString","getInt","getInt64","getFloat","getDateTime","getGeoPoint","getStringSlice","getUnsavedFiles","getUploadedFiles","unmarshalJSONField","expandedOne","expandedAll","findFileFieldByFile","dbExport","hide","unhide","publicExport","marshalJSON","unmarshalJSON","replaceModifiers","email","setEmail","emailVisibility","setEmailVisibility","verified","setVerified","tokenKey","setTokenKey","refreshTokenKey","setPassword","setRandomPassword","validatePassword","isSuperuser","newStaticAuthToken","newAuthToken","newVerificationToken","newPasswordResetToken","newEmailChangeToken","newFileToken","id","lastSavedPK","pk","isNew","markAsNew","markAsNotNew"]);
 walk("FieldsList",users.fields,["clone","fieldNames","asMap","getById","getByName","removeById","removeByName","add","addAt","addMarshaledJSON","addMarshaledJSONAt","string","unmarshalJSON","marshalJSON","value","scan"]);
 walk("NumberField",new NumberField({name:"x"}),["name","id","system","hidden","presentable","help","min","max","onlyInt","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings","findSetter"]);
 walk("BoolField",new BoolField({name:"x"}),["name","id","system","hidden","presentable","help","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings"]);
 walk("TextField",new TextField({name:"x"}),["name","id","system","hidden","presentable","help","min","max","pattern","autogeneratePattern","required","primaryKey","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validatePlainValue","validateSettings","findSetter"]);
 walk("URLField",new URLField({name:"x"}),["name","id","system","hidden","presentable","help","exceptDomains","onlyDomains","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings"]);
 walk("EmailField",new EmailField({name:"x"}),["name","id","system","hidden","presentable","help","exceptDomains","onlyDomains","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings"]);
 walk("EditorField",new EditorField({name:"x"}),["name","id","system","hidden","presentable","help","maxSize","convertURLs","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings","calculateMaxBodySize"]);
 walk("PasswordField",new PasswordField({name:"x"}),["name","id","system","hidden","presentable","help","pattern","min","max","cost","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","driverValue","prepareValue","validateValue","validateSettings","findGetter","findSetter"]);
 walk("DateField",new DateField({name:"x"}),["name","id","system","hidden","presentable","help","min","max","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings"]);
 walk("AutodateField",new AutodateField({name:"x"}),["name","id","system","hidden","presentable","onCreate","onUpdate","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings","findSetter"]);
 walk("JSONField",new JSONField({name:"x"}),["name","id","system","hidden","presentable","help","maxSize","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings","calculateMaxBodySize"]);
 walk("RelationField",new RelationField({name:"x"}),["name","id","system","hidden","presentable","help","collectionId","cascadeDelete","minSelect","maxSelect","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","isMultiple","columnType","prepareValue","driverValue","validateValue","validateSettings","findSetter"]);
 walk("SelectField",new SelectField({name:"x"}),["name","id","system","hidden","presentable","help","values","maxSelect","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","isMultiple","columnType","prepareValue","driverValue","validateValue","validateSettings","findSetter"]);
 walk("FileField",new FileField({name:"x"}),["name","id","system","hidden","presentable","help","maxSize","maxSelect","mimeTypes","thumbs","protected","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","isMultiple","columnType","prepareValue","driverValue","validateSettings","validateValue","calculateMaxBodySize","findGetter","findSetter"]);
 walk("GeoPointField",new GeoPointField({name:"x"}),["name","id","system","hidden","presentable","help","required","type","getId","setId","getName","setName","getSystem","setSystem","getHidden","setHidden","columnType","prepareValue","validateValue","validateSettings"]);
  walk("DB",app.db(),["clone","db","close","begin","beginTx","wrap","transactional","transactionalContext","driverName","quoteTableName","quoteColumnName","newQuery","select","model","generatePlaceholder","quote","quoteSimpleTableName","quoteSimpleColumnName","queryBuilder","insert","upsert","update","delete","createTable","renameTable","dropTable","truncateTable","addColumn","dropColumn","renameColumn","alterColumn","addPrimaryKey","dropPrimaryKey","addForeignKey","dropForeignKey","createIndex","createUniqueIndex","dropIndex","commit","rollback"]);
 walk("SelectQuery",app.db().select("*"),["withBuildHook","preFragment","postFragment","select","andSelect","distinct","selectOption","from","where","andWhere","orWhere","join","innerJoin","leftJoin","rightJoin","orderBy","andOrderBy","groupBy","andGroupBy","having","andHaving","orHaving","union","unionAll","limit","offset","bind","andBind","build","one","model","all","rows","row","column","info"]);
 walk("Query",app.db().newQuery("select 1"),["sql","withExecHook","withOneHook","withAllHook","params","prepare","close","bind","execute","one","all","row","column","rows"]);
 walk("RecordQuery",app.recordQuery(users),["withBuildHook","preFragment","postFragment","select","andSelect","distinct","selectOption","from","where","andWhere","orWhere","join","innerJoin","leftJoin","rightJoin","orderBy","andOrderBy","groupBy","andGroupBy","having","andHaving","orHaving","union","unionAll","limit","offset","bind","andBind","build","one","model","all","rows","row","column","info"]);
 walk("DateTime",new DateTime(),["time","add","sub","addDate","after","before","compare","equal","unix","isZero","string","marshalJSON","unmarshalJSON","value","scan"]);
 walk("Settings",app.settings(),["tableName","lastSavedPK","pk","isNew","markAsNew","markAsNotNew","postScan","string","dbExport","postValidate","merge","clone","marshalJSON","superuserIPs","smtp","backups","s3","meta","rateLimits","trustedProxy","batch","logs"]);
 walk("LikeExp",$dbx.like("a","b"),["like","escape","match","build"]);
 walk("exp",$dbx.exp("a=1"),["build"]);
 walk("TableInfo",app.tableInfo("users")[0],["pk","index","name","type","notNull","defaultValue"]);
 walk("hidden",r,["dbColumns","dbScan","dbPrimaryKey","originalData","lastSavedPKValue"]);
 walk("hidden",users,["dbColumns","dbScan","autogeneratedId","disableIntegrityChecks","initDefaultFields"]);
 walk("hidden",users.fields,["toArray","items","setItems","list"]);
});`,
};

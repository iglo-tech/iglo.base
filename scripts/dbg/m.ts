import { loadSQLite } from "@/db/sqlite-lib";
import { Database } from "bun:sqlite";
try {
  loadSQLite();
  const db = new Database(":memory:");
  console.log(
    "main ok",
    db.query("select sqlite_version() v").get(),
    Bun.main,
    Bun.embeddedFiles.map((f) => (f as any).name),
  );
} catch (e) {
  console.log("main failed", String(e));
}
const w = new Worker("./dbg/w.ts");
w.addEventListener("message", (e) => {
  console.log("worker says", JSON.stringify(e.data));
  w.terminate();
});
w.addEventListener("error", (e) => {
  console.log("worker error", e.message);
  w.terminate();
});
w.addEventListener("close", () => console.log("worker closed"));
setTimeout(() => {
  console.log("timeout");
  process.exit(0);
}, 8000);

import { loadSQLite } from "@/db/sqlite-lib";
try {
  postMessage(
    "start " + Bun.main + " " + JSON.stringify(Bun.embeddedFiles.map((f) => (f as any).name)),
  );
  loadSQLite();
  postMessage("worker loaded ok");
} catch (e) {
  postMessage("worker failed " + String(e));
}

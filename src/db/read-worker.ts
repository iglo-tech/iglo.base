// Upstream: none. The thread of one read worker of the read pool
// (src/db/read-pool.ts), standing in for one connection of upstream's
// concurrent pools: read-only connections to data.db and auxiliary.db,
// opened on first use, that run one query at a time as the main thread's
// synchronous resolvers would (driver.ts, rows.ts) and post the result back.
//
// `bun build --compile` needs this file as an entry point of its own
// (package.json "build").

import type { Database } from "bun:sqlite";

import { openReadOnly } from "@/db/connect";
import { queryStatements, splitStatements } from "@/db/dbx/driver";
import { readRows } from "@/db/dbx/rows";
import type { ReadRequestMessage, ReadResponseMessage, SerializedError } from "@/db/read-pool";

declare const self: Worker;

const conns = new Map<string, Database>();

function conn(path: string): Database {
  let c = conns.get(path);
  if (c === undefined) {
    c = openReadOnly(path);
    conns.set(path, c);
  }
  return c;
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const { code, errno } = err as { code?: unknown; errno?: unknown };
    return {
      name: err.name,
      message: err.message,
      code: typeof code === "string" ? code : null,
      errno: typeof errno === "number" ? errno : null,
    };
  }
  return { name: "Error", message: String(err), code: null, errno: null };
}

self.addEventListener("message", (event: MessageEvent<ReadRequestMessage>) => {
  const req = event.data;
  let res: ReadResponseMessage;
  try {
    const c = conn(req.path);
    const value = readRows(
      queryStatements(c, splitStatements(req.sql), req.args, null, false).withExactIntegers(
        req.exactIntegers,
      ),
      req.mode,
    );
    res = { id: req.id, ok: true, value };
  } catch (err) {
    res = { id: req.id, ok: false, error: serializeError(err) };
  }
  postMessage(res);
});

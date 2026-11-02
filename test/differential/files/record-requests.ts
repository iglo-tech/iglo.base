// What the record file differential tests share (files.test.ts and
// s3-files.test.ts): the requests of a case, the pairing of generated values
// and the comparison of the responses.

import { type FileCase, type Part, text } from "@test/differential/files/cases";
import { superuserToken } from "@test/scenarios/record-crud";

export interface Res {
  status: number;
  contentType: string;
  text: string;
  body: Uint8Array;
}

export async function req(
  url: string,
  method: string,
  path: string,
  body?: Uint8Array | string,
  contentType?: string,
): Promise<Res> {
  const res = await fetch(url + path, {
    method,
    headers: {
      authorization: superuserToken,
      ...(contentType ? { "content-type": contentType } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    text: new TextDecoder().decode(bytes),
    body: bytes,
  };
}

// -------------------------------------------------------------------
// pairing of generated values

const idPattern = /^[a-z0-9]{15}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class Pairing {
  readonly forward = new Map<string, string>();
  readonly backward = new Map<string, string>();

  pair(up: string, ig: string): boolean {
    const f = this.forward.get(up);
    const b = this.backward.get(ig);
    if (f === undefined && b === undefined) {
      this.forward.set(up, ig);
      this.backward.set(ig, up);
      return true;
    }
    return f === ig && b === up;
  }
}

// same length, and every differing character is [a-z0-9] on both sides
function sameShape(up: string, ig: string): boolean {
  if (up.length !== ig.length) {
    return false;
  }
  for (let i = 0; i < up.length; i++) {
    if (
      up[i] !== ig[i] &&
      !(/[a-z0-9]/.test(up[i] as string) && /[a-z0-9]/.test(ig[i] as string))
    ) {
      return false;
    }
  }
  return true;
}

export function compareJSON(
  up: unknown,
  ig: unknown,
  path: string,
  pairing: Pairing,
  out: string[],
): void {
  if (typeof up === "string" && typeof ig === "string") {
    if (up === ig) {
      return;
    }
    const key = path.split(".").at(-1) ?? "";
    if (
      (key === "created" || key === "updated") &&
      timestampPattern.test(up) &&
      timestampPattern.test(ig)
    ) {
      return;
    }
    if (idPattern.test(up) && idPattern.test(ig)) {
      if (!pairing.pair(up, ig)) {
        out.push(`${path}: id ${up} / ${ig} paired otherwise`);
      }
      return;
    }
    if (sameShape(up, ig)) {
      // a generated file name (or a message holding one)
      if (/^[^/ ]+_[a-z0-9]{10}(\.[^/ ]*)?$/.test(up) && !pairing.pair(up, ig)) {
        out.push(`${path}: file name ${up} / ${ig} paired otherwise`);
      }
      return;
    }
    out.push(`${path}: ${JSON.stringify(up)} != ${JSON.stringify(ig)}`);
    return;
  }
  if (Array.isArray(up) && Array.isArray(ig)) {
    if (up.length !== ig.length) {
      out.push(`${path}: length ${up.length} != ${ig.length}`);
      return;
    }
    up.forEach((v, i) => compareJSON(v, ig[i], `${path}.${i}`, pairing, out));
    return;
  }
  if (up !== null && ig !== null && typeof up === "object" && typeof ig === "object") {
    const uk = Object.keys(up);
    const ik = Object.keys(ig);
    if (uk.join(",") !== ik.join(",")) {
      out.push(`${path}: keys ${uk.join(",")} != ${ik.join(",")}`);
      return;
    }
    for (const k of uk) {
      compareJSON(
        (up as Record<string, unknown>)[k],
        (ig as Record<string, unknown>)[k],
        `${path}.${k}`,
        pairing,
        out,
      );
    }
    return;
  }
  if (up !== ig) {
    out.push(`${path}: ${JSON.stringify(up)} != ${JSON.stringify(ig)}`);
  }
}

export function compareRes(up: Res, ig: Res, pairing: Pairing): string[] {
  const out: string[] = [];
  if (up.status !== ig.status) {
    out.push(`status ${up.status} != ${ig.status}: ${up.text} / ${ig.text}`);
    return out;
  }
  if (up.text === "" || ig.text === "") {
    if (up.text !== ig.text) {
      out.push(`body ${JSON.stringify(up.text)} != ${JSON.stringify(ig.text)}`);
    }
    return out;
  }
  compareJSON(JSON.parse(up.text), JSON.parse(ig.text), "$", pairing, out);
  return out;
}

// -------------------------------------------------------------------
// requests

// a server's view of the run: its own records per ref
export interface Side {
  url: string;
  records: Map<string, Record<string, unknown>>;
}

function resolveValue(v: string, side: Side): string {
  return v.replace(
    /\$([a-z0-9]+)\.([a-z]+)(?:\.(\d+))?/g,
    (_m, ref: string, field: string, i?: string) => {
      const rec = side.records.get(ref);
      if (rec === undefined) {
        throw new Error(`no record ${ref}`);
      }
      const val = rec[field];
      if (i === undefined) {
        return String(val);
      }
      return String(Array.isArray(val) ? val[Number(i)] : val);
    },
  );
}

export function resolveJSON(v: unknown, side: Side): unknown {
  if (typeof v === "string") {
    return resolveValue(v, side);
  }
  if (Array.isArray(v)) {
    return v.map((x) => resolveJSON(x, side));
  }
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveJSON(x, side)]));
  }
  return v;
}

function escapeQuotes(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function multipartBody(parts: Part[], boundary: string, side: Side): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    if ("value" in p) {
      chunks.push(
        text(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(p.name)}"\r\n\r\n${resolveValue(p.value, side)}\r\n`,
        ),
      );
    } else {
      chunks.push(
        text(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(p.name)}"; filename="${escapeQuotes(p.filename)}"\r\nContent-Type: ${p.type ?? "application/octet-stream"}\r\n\r\n`,
        ),
        p.content,
        text("\r\n"),
      );
    }
  }
  chunks.push(text(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

export async function sendCase(c: FileCase, side: Side): Promise<Res> {
  const rec = c.ref === undefined ? undefined : side.records.get(c.ref);
  const base = `/api/collections/${c.collection}/records`;
  const path = c.method === "POST" ? base : `${base}/${String(rec?.id)}`;
  let res: Res;
  if (c.json !== undefined) {
    res = await req(
      side.url,
      c.method,
      path,
      JSON.stringify(resolveJSON(c.json, side)),
      "application/json",
    );
  } else if (c.parts !== undefined) {
    const boundary =
      c.quotedBoundary === undefined ? "filesdifferentialboundary" : JSON.parse(c.quotedBoundary);
    const ct = `multipart/form-data; boundary=${c.quotedBoundary ?? boundary}`;
    res = await req(side.url, c.method, path, multipartBody(c.parts, boundary, side), ct);
  } else {
    res = await req(side.url, c.method, path);
  }
  if (res.status === 200 && c.ref !== undefined && c.method !== "DELETE") {
    side.records.set(c.ref, JSON.parse(res.text) as Record<string, unknown>);
  }
  return res;
}

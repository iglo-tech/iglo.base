// Upstream: tools/filesystem/internal/s3blob/s3/list_objects.go
//
// The response keeps the members the driver reads.

import { parseRoot } from "@/tools/filesystem/internal/s3blob/s3/xml";
import { childText, type XmlElement } from "@/tools/filesystem/internal/s3blob/s3/xml";
import type { S3 } from "@/tools/filesystem/internal/s3blob/s3/s3";

// ListParams defines optional parameters for the ListObject request.
export interface ListParams {
  continuationToken?: string;
  delimiter?: string;
  prefix?: string;
  encodingType?: string;
  startAfter?: string;
  maxKeys?: number;
  fetchOwner?: boolean;
}

// url.QueryEscape
function queryEscape(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + (c.codePointAt(0) as number).toString(16).toUpperCase())
    .replaceAll("%20", "+");
}

// Encode encodes the parameters in a properly formatted query string
// (url.Values.Encode: sorted by key).
export function encodeListParams(l: ListParams): string {
  const query: [string, string][] = [["list-type", "2"]];

  if ((l.continuationToken ?? "") !== "") {
    query.push(["continuation-token", l.continuationToken as string]);
  }
  if ((l.delimiter ?? "") !== "") {
    query.push(["delimiter", l.delimiter as string]);
  }
  if ((l.prefix ?? "") !== "") {
    query.push(["prefix", l.prefix as string]);
  }
  if ((l.encodingType ?? "") !== "") {
    query.push(["encoding-type", l.encodingType as string]);
  }
  if (l.fetchOwner === true) {
    query.push(["fetch-owner", "true"]);
  }
  if ((l.maxKeys ?? 0) > 0) {
    query.push(["max-keys", String(l.maxKeys)]);
  }
  if ((l.startAfter ?? "") !== "") {
    query.push(["start-after", l.startAfter as string]);
  }

  return query
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${queryEscape(k)}=${queryEscape(v)}`)
    .join("&");
}

export interface ListObjectContent {
  key: string;
  etag: string;
  // Unix nanoseconds
  lastModified: bigint;
  size: number;
}

export interface ListObjectsResponse {
  nextContinuationToken: string;
  commonPrefixes: string[];
  contents: ListObjectContent[];
}

// an xsd:dateTime in Unix nanoseconds (time.Time.UnmarshalText)
function parseLastModified(text: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  const ms = m === null ? Number.NaN : Date.parse(`${m[1]}${m[3]}`);
  if (m === null || Number.isNaN(ms)) {
    throw new Error(`parsing time ${JSON.stringify(text)}: invalid format`);
  }
  return BigInt(ms) * 1_000_000n + BigInt(((m[2] ?? "") + "000000000").slice(0, 9));
}

function parseContent(element: XmlElement): ListObjectContent {
  const size = childText(element, "Size").trim();
  return {
    key: childText(element, "Key"),
    etag: childText(element, "ETag"),
    lastModified: parseLastModified(childText(element, "LastModified")),
    size: size === "" ? 0 : Number(size),
  };
}

// ListObjects retrieves paginated objects list.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
export async function listObjects(
  s3: S3,
  params: ListParams,
  signal?: AbortSignal,
): Promise<ListObjectsResponse> {
  const resp = await s3.signAndSend({
    method: "GET",
    url: s3.url("?" + encodeListParams(params)),
    signal,
  });

  const root = parseRoot(new Uint8Array(await resp.arrayBuffer()), "ListBucketResult");

  return {
    nextContinuationToken: childText(root, "NextContinuationToken"),
    commonPrefixes: root.children
      .filter((c) => c.name === "CommonPrefixes")
      .map((c) => childText(c, "Prefix")),
    contents: root.children.filter((c) => c.name === "Contents").map(parseContent),
  };
}

// Upstream: tests/request.go (MockMultipartData), with the body layout of
// Go's mime/multipart Writer (WriteField, CreateFormFile, Close)
//
// Each file field gets one part with a temporary file's path as its file
// name and "test" as its content, as upstream's helper creates
// (os.CreateTemp(os.TempDir(), "tmpfile-*.txt")). Go's boundary is 30
// random bytes in hex.

export interface MultipartBody {
  body: Uint8Array;
  headers: { "Content-Type": string };
}

export function multipart(data: Record<string, string>, ...fileFields: string[]): MultipartBody {
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  const boundary = Buffer.from(bytes).toString("hex");

  const parts: string[] = [];
  // write data fields
  for (const [k, v] of Object.entries(data)) {
    parts.push(`Content-Disposition: form-data; name="${escapeQuotes(k)}"\r\n\r\n${v}`);
  }
  // write file fields
  for (const fileField of fileFields) {
    const name = `/tmp/tmpfile-${String(Math.floor(Math.random() * 1e9))}.txt`;
    parts.push(
      `Content-Disposition: form-data; name="${escapeQuotes(fileField)}"; filename="${escapeQuotes(name)}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\ntest`,
    );
  }

  let text = "";
  parts.forEach((part, i) => {
    text += `${i === 0 ? "" : "\r\n"}--${boundary}\r\n${part}`;
  });
  text += `\r\n--${boundary}--\r\n`;

  return {
    body: new TextEncoder().encode(text),
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  };
}

// mime/multipart escapeQuotes
function escapeQuotes(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// Upstream: tools/filesystem/internal/s3blob/s3/error.go

import { bytesToText } from "@/tools/types/go-json";

// ResponseError defines a general S3 response error.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/ErrorResponses.html
export class ResponseError extends Error {
  status: number;
  code = "";
  s3Message = "";
  raw: Uint8Array = new Uint8Array();

  constructor(status: number) {
    super();
    this.status = status;
  }

  // Error implements the std error interface.
  override get message(): string {
    let text = `${this.status} ${this.code === "" ? "S3ResponseError" : this.code}`;
    if (this.s3Message !== "") {
      text += `: ${this.s3Message}`;
    }
    if (this.raw.length > 0) {
      text += `\n(RAW: ${bytesToText(this.raw)})`;
    }
    return text;
  }
}

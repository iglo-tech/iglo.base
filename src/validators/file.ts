// Upstream: core/validators/file.go and cutStr of core/validators/validators.go

import { goQuote } from "@/fields/field";
import { File } from "@/tools/filesystem/file";
import { bytesToText, textToBytes, type GoInt } from "@/tools/types/go-json";
import { NewError } from "@/validation/error";
import type { RuleFunc } from "@/validation/validation";
import { ErrUnsupportedValueType } from "@/validators/validators";

// UploadedFileSize checks whether the validated [File] size is no more
// than the provided maxBytes.
//
// Example:
//
//	StructField("file", form.file, By(UploadedFileSize(1000)))
export function UploadedFileSize(maxBytes: GoInt): RuleFunc {
  return (value) => {
    if (value === null) {
      return null; // nothing to validate (a nil *filesystem.File)
    }
    if (!(value instanceof File)) {
      return ErrUnsupportedValueType;
    }

    if (value.size > maxBytes) {
      return NewError(
        "validation_file_size_limit",
        "Failed to upload {{.file}} - the maximum allowed file size is {{.maxSize}} bytes.",
      ).setParams({
        file: cutStr(value.originalName, 300),
        maxSize: maxBytes,
      });
    }

    return null;
  };
}

// UploadedFileMimeType checks whether the validated [File] mimetype is
// within the provided allowed mime types.
//
// Example:
//
//	const validMimeTypes = ["test/plain", "image/jpeg"];
//	StructField("file", form.file, By(UploadedFileMimeType(validMimeTypes)))
export function UploadedFileMimeType(validTypes: readonly string[] | null): RuleFunc {
  return (value) => {
    if (value === null) {
      return null; // nothing to validate (a nil *filesystem.File)
    }
    if (!(value instanceof File)) {
      return ErrUnsupportedValueType;
    }

    const baseErr = NewError(
      "validation_invalid_mime_type",
      `Failed to upload ${goQuote(cutStr(value.originalName, 300))} due to unsupported file type.`,
    );

    if (validTypes === null || validTypes.length === 0) {
      return baseErr;
    }

    // mimetype.DetectReader of the opened reader (src/tools/filesystem/file.ts)
    const [filetype, err] = value.detect();
    if (err !== null) {
      return baseErr;
    }

    for (const t of validTypes) {
      if (filetype.is(t)) {
        return null; // valid
      }
    }

    return NewError(
      "validation_invalid_mime_type",
      `${goQuote(value.name)} mime type must be one of: ${validTypes.join(", ")}.`,
    );
  };
}

// cutStr cuts str at max bytes and appends "..." (the cut may split a
// multi-byte character, as in Go).
function cutStr(str: string, max: number): string {
  const b = textToBytes(str);
  if (b.length > max) {
    return bytesToText(b.subarray(0, max)) + "...";
  }
  return str;
}

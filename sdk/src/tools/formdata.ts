// js-sdk v0.28.1 src/tools/formdata.ts
import type { Json } from "@sdk/tools/json";

// `global` is provided by React Native (Hermes) and Node; it is not part of the DOM typings.
declare const global: { HermesInternal?: unknown } | undefined;
/**
 * Checks if the specified value is a file (aka. File, Blob, RN file object).
 */
export function isFile(val: unknown): boolean {
  return Boolean(
    (typeof Blob !== "undefined" && val instanceof Blob) ||
    (typeof File !== "undefined" && val instanceof File) ||
    // check for React Native file object format
    // (see https://ganigeorgiev.com/pocketbase/discussions/2002#comment-mruqg2o3j3vujsi)
    (val !== null &&
      typeof val === "object" &&
      (val as { uri?: unknown }).uri &&
      ((typeof navigator !== "undefined" && navigator.product === "ReactNative") ||
        // oxlint-disable-next-line unicorn/no-typeof-undefined -- global is undeclared outside Hermes: typeof must not throw
        (typeof global !== "undefined" && global.HermesInternal))),
  );
}

/**
 * Loosely checks if the specified body is a FormData instance.
 */
export function isFormData(body: unknown): boolean {
  // the original returns `body` itself when it is falsy; kept as is
  return (
    (body as boolean) &&
    // we are checking the constructor name because FormData
    // is not available natively in some environments and the
    // polyfill(s) may not be globally accessible
    ((body as { constructor?: { name?: unknown } }).constructor?.name === "FormData" ||
      // fallback to global FormData instance check
      // note: this is needed because the constructor.name could be different in case of
      //       custom global FormData implementation, eg. React Native on Android/iOS
      (typeof FormData !== "undefined" && body instanceof FormData))
  );
}

/**
 * Checks if the submitted body object has at least one Blob/File field value.
 */
export function hasFileField(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }

  // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- the user's request body: its values are arbitrary JS values (File, Blob, nested objects) that isFile() checks and nothing rewrites
  const obj = body as Record<string, unknown>;
  for (const key in obj) {
    const values = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
    for (const v of values) {
      if (isFile(v)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Converts analyzes the provided body and converts it to FormData
 * in case a plain object with File/Blob values is used.
 */
export function convertToFormDataIfNeeded(body: unknown): unknown {
  if (
    typeof FormData === "undefined" ||
    body === undefined ||
    typeof body !== "object" ||
    body === null ||
    isFormData(body) ||
    !hasFileField(body)
  ) {
    return body;
  }

  const form = new FormData();
  // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- the user's request body: its values are arbitrary JS values (File, Blob, nested objects) that are appended or JSON-encoded unchanged
  const obj = body as Record<string, unknown>;

  for (const key in obj) {
    const val = obj[key];

    // skip undefined values for consistency with JSON.stringify
    // (see https://ganigeorgiev.com/pocketbase/discussions/6731#comment-5v564g1mzopqmot)
    if (val === undefined) {
      continue;
    }

    if (typeof val === "object" && !hasFileField({ data: val })) {
      // send json-like values as jsonPayload to avoid the implicit string value normalization
      // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- wraps the user's arbitrary value unchanged for JSON.stringify
      const payload: Record<string, unknown> = {};
      payload[key] = val;
      form.append("@jsonPayload", JSON.stringify(payload));
    } else {
      // in case of mixed string and file/blob
      const normalizedVal = Array.isArray(val) ? val : [val];
      for (const v of normalizedVal) {
        form.append(key, v as Blob | string);
      }
    }
  }

  return form;
}

// A multipart value is a File (kept as is) or an inferred JSON value; repeated keys become arrays.
type FormDataValue = Json | File | Array<FormDataValue>;

/**
 * Converts the provided FormData instance into a plain object.
 *
 * For consistency with the server multipart/form-data inferring,
 * the following normalization rules are applied for plain multipart string values:
 *   - "true" is converted to the json "true"
 *   - "false" is converted to the json "false"
 *   - numeric strings are converted to json number ONLY if the resulted
 *     minimal number string representation is the same as the provided raw string
 *     (aka. scientific notations, "Infinity", "0.0", "0001", etc. are kept as string)
 *   - any other string (empty string too) is left as it is
 */
export function convertFormDataToObject(formData: FormData): { [key: string]: FormDataValue } {
  const result: { [key: string]: FormDataValue } = {};

  formData.forEach((v, k) => {
    if (k === "@jsonPayload" && typeof v == "string") {
      try {
        const parsed: unknown = JSON.parse(v);
        if (typeof parsed === "object" && parsed !== null) {
          Object.assign(result, parsed);
        }
      } catch (error) {
        console.warn("@jsonPayload error:", error);
      }
    } else {
      if (result[k] !== undefined) {
        if (!Array.isArray(result[k])) {
          result[k] = [result[k]];
        }
        (result[k] as Array<FormDataValue>).push(inferFormDataValue(v));
      } else {
        result[k] = inferFormDataValue(v);
      }
    }
  });

  return result;
}

const inferNumberCharsRegex = /^[-.\d]+$/;

function inferFormDataValue(value: File | string): FormDataValue {
  if (typeof value != "string") {
    return value;
  }

  if (value == "true") {
    return true;
  }

  if (value == "false") {
    return false;
  }

  // note: expects the provided raw string to match exactly with the minimal string representation of the parsed number
  const first = value.charAt(0);
  if ((first === "-" || (first >= "0" && first <= "9")) && inferNumberCharsRegex.test(value)) {
    const num = +value;
    if ("" + num === value) {
      return num;
    }
  }

  return value;
}

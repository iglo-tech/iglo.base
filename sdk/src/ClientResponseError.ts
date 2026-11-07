// js-sdk v0.28.1 src/ClientResponseError.ts
import type { Loose, LooseObject } from "@sdk/tools/loose";
type ErrorData = {
  originalError?: unknown;
  url?: unknown;
  status?: unknown;
  isAbort?: unknown;
  name?: unknown;
  message?: unknown;
  response?: unknown;
  data?: unknown;
};

/**
 * ClientResponseError is a custom Error class that is intended to wrap
 * and normalize any error thrown by `Client.send()`.
 */
export class ClientResponseError extends Error {
  url: string = "";
  status: number = 0;
  response: LooseObject = {};
  isAbort: boolean = false;
  originalError: Loose = null;

  constructor(errData?: unknown) {
    super("ClientResponseError");

    // Set the prototype explicitly.
    // https://github.com/Microsoft/TypeScript-wiki/blob/main/Breaking-Changes.md#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, ClientResponseError.prototype);

    if (errData !== null && typeof errData === "object") {
      const err = errData as ErrorData;
      this.originalError = err.originalError;
      this.url = typeof err.url === "string" ? err.url : "";
      this.status = typeof err.status === "number" ? err.status : 0;

      // note: DOMException is not implemented yet in React Native
      // and aborting a fetch throws a plain Error with message "Aborted".
      this.isAbort = !!err.isAbort || err.name === "AbortError" || err.message === "Aborted";

      if (err.response !== null && typeof err.response === "object") {
        this.response = err.response as LooseObject;
      } else if (err.data !== null && typeof err.data === "object") {
        this.response = err.data as LooseObject;
      } else {
        this.response = {};
      }
    }

    if (!this.originalError && !(errData instanceof ClientResponseError)) {
      this.originalError = errData;
    }

    this.name = "ClientResponseError " + this.status;
    this.message = this.response?.message;
    if (!this.message) {
      if (this.isAbort) {
        this.message =
          "The request was aborted (most likely autocancelled; you can find more info in https://github.com/pocketbase/js-sdk#auto-cancellation).";
      } else if (this.originalError?.cause?.message?.includes("ECONNREFUSED ::1")) {
        this.message =
          "Failed to connect to the PocketBase server. Try changing the SDK URL from localhost to 127.0.0.1 (https://github.com/pocketbase/js-sdk/issues/21).";
      } else {
        this.message = "Something went wrong.";
      }
    }

    // set this.cause so that JS debugging tools can automatically connect
    // the dots between the original error and the wrapped one
    this.cause = this.originalError;
  }

  /**
   * Alias for `this.response` for backward compatibility.
   */
  get data() {
    return this.response;
  }

  /**
   * Make a POJO's copy of the current error class instance.
   * @see https://github.com/vuex-orm/vuex-orm/issues/255
   */
  toJSON() {
    return { ...this };
  }
}

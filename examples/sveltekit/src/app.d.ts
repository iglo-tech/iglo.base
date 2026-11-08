import type { SvelteKitLocals } from "iglo.base/ssr/sveltekit";

// What the adapter's hook puts on event.locals: the server client (locals.pb) and the browser
// token function (locals.pbBrowserToken).
declare global {
  namespace App {
    interface Locals extends SvelteKitLocals {}
  }
}

export {};

// docs/design/13-ssr.md ("Clients", "Runtime (Next.js)"). The browser condition of every iglo.base/ssr
// subpath resolves here, so a bundle for the browser or for the Edge runtime loads this module and
// nothing else. Its named exports are missing: Turbopack fails the build on the import, and webpack
// builds it and the app answers every request with this error.
throw new Error(
  'iglo.base/ssr is server-only and cannot be imported in browser code. On Next.js, the middleware must run on the Node.js runtime: proxy.ts (Next.js 16), or middleware.ts with export const runtime = "nodejs" (Next.js 15.5). The Edge runtime is not supported.',
);

import { createNextAuth } from "iglo.base/ssr/next";
import { createSvelteKitAuth } from "iglo.base/ssr/sveltekit";
import { createNuxtAuth } from "iglo.base/ssr/nuxt";
import { createAstroAuth } from "iglo.base/ssr/astro";
import { createReactRouterAuth } from "iglo.base/ssr/react-router";
console.log(
  "adapters",
  typeof createNextAuth,
  typeof createSvelteKitAuth,
  typeof createNuxtAuth,
  typeof createAstroAuth,
  typeof createReactRouterAuth,
);

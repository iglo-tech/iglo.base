import { createNextAuth } from "@iglo.tech/iglo.base/ssr/next";
import { createSvelteKitAuth } from "@iglo.tech/iglo.base/ssr/sveltekit";
import { createNuxtAuth } from "@iglo.tech/iglo.base/ssr/nuxt";
import { createAstroAuth } from "@iglo.tech/iglo.base/ssr/astro";
import { createReactRouterAuth } from "@iglo.tech/iglo.base/ssr/react-router";
console.log(
  "adapters",
  typeof createNextAuth,
  typeof createSvelteKitAuth,
  typeof createNuxtAuth,
  typeof createAstroAuth,
  typeof createReactRouterAuth,
);

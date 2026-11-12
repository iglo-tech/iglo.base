import type { NextAuth } from "@iglo.tech/iglo.base/ssr/next";
import type { SvelteKitAuth } from "@iglo.tech/iglo.base/ssr/sveltekit";
import type { NuxtAuth } from "@iglo.tech/iglo.base/ssr/nuxt";
import type { AstroAuth } from "@iglo.tech/iglo.base/ssr/astro";
import type { ReactRouterAuth } from "@iglo.tech/iglo.base/ssr/react-router";
export type Adapters = [NextAuth, SvelteKitAuth, NuxtAuth, AstroAuth, ReactRouterAuth];

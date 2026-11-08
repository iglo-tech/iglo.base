import type { NextAuth } from "iglo.base/ssr/next";
import type { SvelteKitAuth } from "iglo.base/ssr/sveltekit";
import type { NuxtAuth } from "iglo.base/ssr/nuxt";
import type { AstroAuth } from "iglo.base/ssr/astro";
import type { ReactRouterAuth } from "iglo.base/ssr/react-router";
export type Adapters = [NextAuth, SvelteKitAuth, NuxtAuth, AstroAuth, ReactRouterAuth];

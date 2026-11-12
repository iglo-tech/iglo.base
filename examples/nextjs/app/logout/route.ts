import { SSR_NO_CACHE_HEADERS } from "@iglo.tech/iglo.base/ssr";

import { currentSession } from "@/lib/auth";

export async function POST() {
  const { server } = await currentSession();
  // clearing the store clears the session cookie through the adapter
  server.authStore.clear();
  return new Response(null, {
    status: 303,
    headers: { Location: "/", ...SSR_NO_CACHE_HEADERS },
  });
}

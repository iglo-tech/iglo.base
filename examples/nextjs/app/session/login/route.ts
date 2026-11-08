import { ClientResponseError } from "iglo.base";
import { SSR_NO_CACHE_HEADERS } from "iglo.base/ssr";

import { currentSession } from "@/lib/auth";

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...SSR_NO_CACHE_HEADERS } });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const { server } = await currentSession();
  try {
    // the adapter writes the session cookie when the sign-in succeeds
    await server.collection("users").authWithPassword(email, password);
  } catch (err: unknown) {
    if (err instanceof ClientResponseError) {
      return seeOther("/login?error=1");
    }
    throw err;
  }
  return seeOther("/");
}

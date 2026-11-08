import { SSR_NO_CACHE_HEADERS } from "iglo.base/ssr";

import { currentSession } from "@/lib/auth";

export async function GET() {
  const { server } = await currentSession();
  try {
    const user = await server.auth.verify();
    if (!user) {
      return Response.json({}, { status: 401, headers: SSR_NO_CACHE_HEADERS });
    }
    return Response.json({ id: user.id, email: user.email }, { headers: SSR_NO_CACHE_HEADERS });
  } catch {
    return Response.json({}, { status: 401, headers: SSR_NO_CACHE_HEADERS });
  }
}

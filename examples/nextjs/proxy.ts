// Next.js 16 proxy (formerly middleware.ts): resumes the session on every page and route, so Server
// Components can read the refreshed cookies. A proxy always runs on the Node.js runtime, which
// iglo.base/ssr/next requires (the Edge runtime is not supported).
import type { NextRequest } from "next/server";

import { getAuth } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  return (await getAuth()).middleware(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

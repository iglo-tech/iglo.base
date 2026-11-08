// Resumes the session on every page and route, so Server Components can read the refreshed cookies.
import type { NextRequest } from "next/server";

import { getAuth } from "@/lib/auth";

// iglo.base/ssr is server-only: the Edge build resolves it to the browser stub, which throws.
export const runtime = "nodejs";

export async function middleware(request: NextRequest) {
  return (await getAuth()).middleware(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

import type { Handle } from "@sveltejs/kit";
import { getAuth } from "$lib/server/auth";

// The adapter runs for every request: it resumes the session, answers its own routes
// (/api/pb/*) and the CSRF guard, then resolves the app's routes.
export const handle: Handle = async ({ event, resolve }) => {
  const auth = await getAuth();
  return auth.handle({ event, resolve: async () => resolve(event) });
};

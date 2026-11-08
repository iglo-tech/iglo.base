import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  // checks the session with iglo.base every time, bypassing the cache
  const user = await locals.pb.auth.verify().catch(() => null);
  if (!user) {
    redirect(303, "/login?next=/protected");
  }
  return { email: user.email };
};

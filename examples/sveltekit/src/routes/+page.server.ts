import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  // the hook resumed the session; no request to iglo.base here
  return { email: locals.pb.authStore.record?.email ?? null };
};

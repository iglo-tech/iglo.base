import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  // checks the session with iglo.base every time; a refused session is null
  const user = await locals.pb.auth.verify().catch(() => null);
  if (!user) {
    return json({}, { status: 401 });
  }
  return json({ id: user.id, email: user.email });
};

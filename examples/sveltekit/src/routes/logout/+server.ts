import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ locals }) => {
  // clears the session cookie through event.cookies
  locals.pb.authStore.clear();
  redirect(303, "/");
};

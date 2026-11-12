import { redirect } from "@sveltejs/kit";
import { ClientResponseError } from "@iglo.tech/iglo.base";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  try {
    // the adapter writes the session cookie through event.cookies
    await locals.pb.collection("users").authWithPassword(email, password);
  } catch (err) {
    if (err instanceof ClientResponseError) {
      redirect(303, "/login?error=1");
    }
    throw err;
  }
  redirect(303, "/");
};

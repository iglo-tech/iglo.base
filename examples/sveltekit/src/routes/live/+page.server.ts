import { env } from "$env/dynamic/private";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  return {
    // the URL the browser reaches iglo.base at
    url: env.PB_PUBLIC_URL || env.PB_URL || "",
    browser: await locals.pbBrowserToken(),
  };
};

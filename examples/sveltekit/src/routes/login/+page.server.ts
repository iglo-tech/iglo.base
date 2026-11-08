import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  try {
    // the OAuth2 providers of the users collection, from the server client the hook resumed
    const methods = await locals.pb.collection("users").listAuthMethods();
    return {
      providers: methods.oauth2.providers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
      })),
    };
  } catch {
    return { providers: [] };
  }
};

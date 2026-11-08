import { currentSession } from "@/lib/auth";

/** The OAuth2 providers of the users collection; none when iglo.base cannot be asked. */
async function oauth2Providers() {
  try {
    const { server } = await currentSession();
    const methods = await server.collection("users").listAuthMethods();
    return methods.oauth2.providers;
  } catch {
    return [];
  }
}

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const providers = await oauth2Providers();
  return (
    <main>
      <h1>Sign in</h1>
      {error === "1" && <p role="alert">wrong email or password</p>}
      <form method="POST" action="/session/login">
        <p>
          <label>
            Email <input name="email" type="email" autoComplete="username" required />
          </label>
        </p>
        <p>
          <label>
            Password{" "}
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
        </p>
        <button type="submit">Sign in</button>
      </form>
      <h2>Or</h2>
      {/* the OAuth2 redirect flow: the adapter's start route sends the browser to the provider */}
      {providers.map((provider) => (
        <p key={provider.name}>
          <a href={`/api/pb/oauth2/start/${encodeURIComponent(provider.name)}`}>
            Sign in with {provider.displayName || provider.name}
          </a>
        </p>
      ))}
    </main>
  );
}

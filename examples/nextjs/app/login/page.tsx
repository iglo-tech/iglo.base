export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
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
    </main>
  );
}

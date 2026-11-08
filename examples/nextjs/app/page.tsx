import { currentSession } from "@/lib/auth";

export default async function Home() {
  const { server } = await currentSession();
  const user = server.authStore.isValid ? server.authStore.record : null;
  return (
    <main>
      <h1>iglo.base with Next.js</h1>
      <p>{user ? `signed in as ${user.email}` : "signed out"}</p>
    </main>
  );
}

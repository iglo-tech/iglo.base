import { redirect } from "next/navigation";

import { currentSession } from "@/lib/auth";

export default async function Protected() {
  const { server } = await currentSession();
  let user;
  try {
    // checks with iglo.base every time, bypassing the session cache
    user = await server.auth.verify();
  } catch {
    user = null;
  }
  if (!user) {
    redirect("/login?next=/protected");
  }
  return (
    <main>
      <h1>Protected</h1>
      <p>{`protected: ${user.email}`}</p>
    </main>
  );
}

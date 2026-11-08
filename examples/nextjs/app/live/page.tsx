import { currentSession } from "@/lib/auth";

import { LiveClient } from "./live-client";

export default async function Live() {
  const { browserToken } = await currentSession();
  // a short token minted for this page; the session token itself never reaches the browser
  const session = await browserToken();
  if (!session) {
    return (
      <main>
        <p>not signed in</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Live records</h1>
      <LiveClient
        token={session.token}
        record={session.record}
        serverTime={session.serverTime}
        expiresAt={session.expiresAt}
        url={process.env.PB_PUBLIC_URL ?? process.env.PB_URL ?? ""}
        renewUrl="/api/pb/renew"
      />
    </main>
  );
}

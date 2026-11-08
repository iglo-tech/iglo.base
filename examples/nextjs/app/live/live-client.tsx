"use client";

import { useEffect, useState } from "react";

import type { AuthRecord } from "iglo.base";
import { createBrowserClient } from "iglo.base/ssr/browser";

interface LiveClientProps {
  token: string;
  record: AuthRecord;
  serverTime: number;
  /** When the token expires; the browser client reads the same from the token's `exp` claim. */
  expiresAt: number;
  url: string;
  renewUrl: string;
}

export function LiveClient({ token, record, serverTime, url, renewUrl }: LiveClientProps) {
  const [status, setStatus] = useState("connecting");
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    const pb = createBrowserClient({ url, token, record, serverTime, renewUrl });
    let active = true;
    pb.collection("ssr_live")
      .subscribe("*", (e) => {
        setIds((previous) => [...previous, (e.record as { id: string }).id]);
      })
      .then(() => {
        if (active) setStatus("subscribed");
      })
      .catch(() => {
        if (active) setStatus("subscribe failed");
      });
    return () => {
      active = false;
      void pb.realtime.unsubscribe();
      pb.dispose();
    };
  }, [url, token, record, serverTime, renewUrl]);

  return (
    <>
      <p>{status}</p>
      <ul>
        {ids.map((id, index) => (
          <li key={index}>{id}</li>
        ))}
      </ul>
    </>
  );
}

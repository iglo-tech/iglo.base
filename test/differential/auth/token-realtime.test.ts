// A realtime client subscribed to a record during a confirm
// (src/apis/record-auth-verification-confirm.ts, -password-reset-confirm.ts,
// -email-change-confirm.ts): both servers, each on its own copy of the
// vendored fixture; the statuses and every SSE event must be equal once
// client ids and timestamps are normalized (test/realtime/scenario.ts). A
// guest, the record itself and a superuser are subscribed, so the email
// visibility of each is covered too. Not
// part of `bun test`: run `bun run test:reference`.

import { describe, expect, test } from "bun:test";

import { mint } from "@test/differential/auth/token-cases";
import type { RealtimeStream } from "@test/realtime/client";
import { observe } from "@test/realtime/run";
import {
  normalize,
  type Observation,
  type RealtimeScenario,
  response,
  type ScenarioContext,
  settled,
} from "@test/realtime/scenario";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const userId = "4q1xlclmfloku33";

// one topic per stream: upstream sends one message per topic in Go's random
// map order
async function subscribed(
  ctx: ScenarioContext,
  topic: string,
  token?: string,
): Promise<RealtimeStream> {
  const stream = await ctx.open();
  const res = await ctx.subscribe(stream.clientId, [topic], token);
  if (res.status !== 204) {
    throw new Error(`subscribe: ${res.status} ${res.body}`);
  }
  return stream;
}

// the confirm with the streams open, then what each stream received
function confirmScenario(name: string, path: string, body: unknown): RealtimeScenario {
  return {
    func: "differential",
    name,
    run: async (ctx): Promise<Observation> => {
      const guest = await subscribed(ctx, "users/*");
      const owner = await subscribed(ctx, `users/${userId}`, usersToken);
      const superuser = await subscribed(ctx, "users/*", superuserToken);
      const confirm = response(await ctx.api("POST", `/api/collections/users/${path}`, body, ""));
      await superuser.waitFor((events) => events.some((e) => e.event === "users/*"));
      return {
        confirm,
        guest: await settled(guest),
        owner: await settled(owner),
        superuser: await settled(superuser),
      };
    },
    check: (o) => {
      expect((o.confirm as { status: number }).status).toBe(204);
      expect((o.superuser as unknown[]).length).toBeGreaterThan(0);
    },
  };
}

const scenarios = [
  confirmScenario("confirm-verification", "confirm-verification", {
    token: mint("verification", "users", userId),
  }),
  confirmScenario("confirm-password-reset", "confirm-password-reset", {
    token: mint("passwordReset", "users", userId),
    password: "1234567!",
    passwordConfirm: "1234567!",
  }),
  confirmScenario("confirm-email-change", "confirm-email-change", {
    token: mint("emailChange", "users", userId, { claims: { newEmail: "change@example.com" } }),
    password: "1234567890",
  }),
];

describe("realtime messages after a confirm", () => {
  for (const scenario of scenarios) {
    test(
      scenario.name,
      async () => {
        const [upstream, igloBase] = await Promise.all([
          observe(scenario, (dataDir) => startUpstream({ dataDir })),
          observe(scenario, (dataDir) => startServer([], dataDir)),
        ]);
        scenario.check?.(upstream);
        scenario.check?.(igloBase);
        expect(normalize(igloBase, false)).toBe(normalize(upstream, false));
      },
      60_000,
    );
  }
});

// Upstream: tools/auth/gitee.go (FetchAuthUser and fetchPrimaryEmail). Gitee's
// emails URL is fixed upstream, so the lookup is checked in-process through a
// test-only fetch (test/support/fetch-stub.ts) that fails any other request.
// The user info is answered by the same stub.

import { afterEach, describe, expect, test } from "bun:test";

import { Gitee } from "@/oauth2/gitee";
import { Token } from "@/oauth2/token";
import { json, type StubbedFetch, stubFetch } from "@test/support/fetch-stub";

const userURL = "https://gitee.com/api/v5/user";
const emailsURL = "https://gitee.com/api/v5/emails";

let stub: StubbedFetch | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

// a Gitee user whose public email is `email`, with the emails lookup answered
// by `emails` (a JSON body) and `status`
function signIn(
  user: { [key: string]: unknown },
  emails: unknown,
  status = 200,
): Promise<{ email: string; id: string; name: string; username: string }> {
  stub?.restore();
  stub = stubFetch({
    [userURL]: () => json(user),
    [emailsURL]: () =>
      typeof emails === "string"
        ? new Response(emails, { status, headers: { "Content-Type": "application/json" } })
        : json(emails, status),
  });
  const provider = new Gitee();
  return provider.fetchAuthUser(new Token({ accessToken: "abc" })).then((u) => ({
    email: u.email,
    id: u.id,
    name: u.name,
    username: u.username,
  }));
}

const gitee = { login: "gitee_user", name: "Gitee User", avatar_url: "", id: 99 };
const primary = (email: string, extra: { [key: string]: unknown } = {}) => ({
  email,
  state: "confirmed",
  scope: ["primary", "emails"],
  ...extra,
});

describe("Gitee", () => {
  test("a valid public email is used without the emails lookup", async () => {
    stub = stubFetch({ [userURL]: () => json({ ...gitee, email: "public@example.com" }) });
    const user = await new Gitee().fetchAuthUser(new Token({ accessToken: "abc" }));
    expect(user.email).toBe("public@example.com");
    expect(user.id).toBe("99");
    expect(stub.calls).toEqual([userURL]);
    stub.restore();
    stub = undefined;
  });

  test("an empty public email looks up the primary confirmed email", async () => {
    const user = await signIn({ ...gitee, email: "" }, [primary("primary@example.com")]);
    expect(user.email).toBe("primary@example.com");
  });

  test("an invalid public email looks up the email too", async () => {
    const user = await signIn({ ...gitee, email: "not-an-email" }, [
      primary("primary@example.com"),
    ]);
    expect(user.email).toBe("primary@example.com");
  });

  test("only a confirmed primary email counts", async () => {
    expect(
      (await signIn({ ...gitee, email: "" }, [primary("a@example.com", { state: "unconfirmed" })]))
        .email,
    ).toBe("");
    expect(
      (await signIn({ ...gitee, email: "" }, [primary("b@example.com", { scope: ["emails"] })]))
        .email,
    ).toBe("");
  });

  test("the first confirmed primary email wins", async () => {
    const user = await signIn({ ...gitee, email: "" }, [
      { email: "x@example.com", state: "confirmed", scope: ["emails"] },
      primary("first@example.com"),
      primary("second@example.com"),
    ]);
    expect(user.email).toBe("first@example.com");
  });

  test("a lookup without permission gives no email", async () => {
    expect((await signIn({ ...gitee, email: "" }, { message: "forbidden" }, 403)).email).toBe("");
    expect((await signIn({ ...gitee, email: "" }, { message: "unauthorized" }, 401)).email).toBe(
      "",
    );
    expect((await signIn({ ...gitee, email: "" }, { message: "not found" }, 404)).email).toBe("");
  });

  test("a private email answer (not a list) gives no email", async () => {
    const user = await signIn(
      { ...gitee, email: "" },
      { email: "12285415+test@user.noreply.gitee.com" },
    );
    expect(user.email).toBe("");
  });

  test("a scope that is not a string gives no email", async () => {
    const user = await signIn({ ...gitee, email: "" }, [
      { email: "bad@example.com", state: "confirmed", scope: [1] },
    ]);
    expect(user.email).toBe("");
  });

  test("only the Gitee hosts are reached", async () => {
    stub = stubFetch({
      [userURL]: () => json({ ...gitee, email: "" }),
      [emailsURL]: () => json([primary("p@example.com")]),
    });
    await new Gitee().fetchAuthUser(new Token({ accessToken: "abc" }));
    expect(stub.calls).toEqual([userURL, emailsURL]);
  });
});

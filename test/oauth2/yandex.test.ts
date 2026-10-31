// Upstream: tools/auth/yandex.go (FetchAuthUser). The avatar host is fixed
// upstream and the avatar is downloaded by the sign-in, so the differential
// cases use an empty avatar; the avatar URL is checked here, with the user
// info answered by a test-only fetch (test/support/fetch-stub.ts).

import { afterEach, describe, expect, test } from "bun:test";

import { Yandex } from "@/oauth2/yandex";
import { Token } from "@/oauth2/token";
import { json, type StubbedFetch, stubFetch } from "@test/support/fetch-stub";

const infoURL = "https://login.yandex.ru/info";

let stub: StubbedFetch | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

async function fetchUser(user: { [key: string]: unknown }) {
  stub?.restore();
  stub = stubFetch({ [infoURL]: () => json(user) });
  return new Yandex().fetchAuthUser(new Token({ accessToken: "abc" }));
}

const yandex = {
  id: "1000000001",
  real_name: "Yandex User",
  login: "yandex_user",
  default_email: "yandex@example.com",
  default_avatar_id: "131652374",
};

describe("Yandex", () => {
  test("an avatar that is not empty is the avatars host's islands-200 image", async () => {
    const user = await fetchUser({ ...yandex, is_avatar_empty: false });
    expect(user.avatarURL).toBe("https://avatars.yandex.net/get-yapic/131652374/islands-200");
    expect(user.email).toBe("yandex@example.com");
    expect(user.username).toBe("yandex_user");
    expect(user.name).toBe("Yandex User");
  });

  test("an empty avatar is no avatar URL", async () => {
    const user = await fetchUser({ ...yandex, is_avatar_empty: true });
    expect(user.avatarURL).toBe("");
  });

  test("the default email is not checked for verification", async () => {
    const user = await fetchUser({ ...yandex, is_avatar_empty: true });
    expect(user.email).toBe("yandex@example.com");
    expect(stub?.calls).toEqual([infoURL]);
  });
});

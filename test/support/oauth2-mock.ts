// A local OAuth2/OIDC provider on a free 127.0.0.1 port, for the OAuth2
// scenarios: upstream's tests inject a Go mock provider, and the servers
// here reach this one through a provider's `tokenURL` and `userInfoURL`.
// Upstream's binary calls provider endpoints on loopback without complaint;
// only the avatar download refuses it.
//
// Every provider registered here is one entry with its own paths, so a
// scenario's two servers see the same provider and scenarios never share
// one. The requests of an entry are kept for the checks.
//
// One mock is shared by the scenarios of a test process
// (sharedOAuth2Mock); its listener does not keep the process alive.

export interface MockEndpoints {
  authURL: string;
  tokenURL: string;
  userInfoURL: string;
  jwksURL: string;
  avatarURL: string;
}

export interface MockProviderSpec {
  // the token endpoint: a JSON body (or the body's text), its status and
  // Content-Type (application/json)
  token?: unknown;
  tokenStatus?: number;
  tokenContentType?: string;
  // when set, a token request with another code_verifier gets a 400
  codeVerifier?: string;
  // the userinfo endpoint: a JSON body (or the body's text) and its status
  user?: unknown;
  userStatus?: number;
  // the JWKS endpoint's body
  jwks?: unknown;
}

export interface MockRequest {
  path: string;
  method: string;
  authorization: string;
  contentType: string;
  body: string;
}

export interface MockProvider extends MockEndpoints {
  requests: MockRequest[];
}

interface Entry {
  spec: MockProviderSpec;
  requests: MockRequest[];
}

const pngPixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function json(value: unknown, status: number, contentType = "application/json"): Response {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

export class OAuth2Mock {
  readonly #entries = new Map<string, Entry>();
  readonly #server: ReturnType<typeof Bun.serve>;
  #next = 0;

  constructor() {
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.#handle(req),
    });
    this.#server.unref();
  }

  get url(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  // a new provider; spec may depend on its endpoints
  register(spec: MockProviderSpec | ((p: MockEndpoints) => MockProviderSpec) = {}): MockProvider {
    const id = `p${++this.#next}`;
    const base = `${this.url}/${id}`;
    const endpoints: MockEndpoints = {
      authURL: `${base}/auth`,
      tokenURL: `${base}/token`,
      userInfoURL: `${base}/userinfo`,
      jwksURL: `${base}/jwks`,
      avatarURL: `${base}/avatar.png`,
    };
    const requests: MockRequest[] = [];
    this.#entries.set(id, {
      spec: typeof spec === "function" ? spec(endpoints) : spec,
      requests,
    });
    return { ...endpoints, requests };
  }

  async #handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const [, id = "", endpoint = ""] = pathname.split("/");
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      return new Response("unknown provider", { status: 404 });
    }

    const body = await req.text();
    entry.requests.push({
      path: `/${endpoint}`,
      method: req.method,
      authorization: req.headers.get("Authorization") ?? "",
      contentType: req.headers.get("Content-Type") ?? "",
      body,
    });

    const { spec } = entry;
    switch (endpoint) {
      case "token": {
        const verifier = new URLSearchParams(body).get("code_verifier");
        if (spec.codeVerifier !== undefined && verifier !== spec.codeVerifier) {
          return json({ error: "invalid_grant" }, 400);
        }
        return json(
          spec.token ?? { access_token: "abc", token_type: "bearer" },
          spec.tokenStatus ?? 200,
          spec.tokenContentType,
        );
      }
      case "userinfo":
        return json(spec.user ?? { sub: "test_id" }, spec.userStatus ?? 200);
      case "jwks":
        return json(spec.jwks ?? { keys: [] }, 200);
      case "avatar.png":
        return new Response(pngPixel, { headers: { "Content-Type": "image/png" } });
      default:
        return new Response("not found", { status: 404 });
    }
  }
}

let shared: OAuth2Mock | undefined;

export function sharedOAuth2Mock(): OAuth2Mock {
  shared ??= new OAuth2Mock();
  return shared;
}

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
  // a URL that answers with this redirect status to the provider's endpoint
  // on the mock's second listener: same host name, another port. With
  // `otherHost`, on localhost instead of 127.0.0.1.
  moved(status: number, endpoint: "token" | "userinfo", otherHost?: boolean): string;
}

export interface MockProviderSpec {
  // the token endpoint: a JSON body (or the body's text), its status and
  // Content-Type (application/json)
  token?: unknown;
  tokenStatus?: number;
  tokenContentType?: string;
  // when set, a token request with another code_verifier gets a 400
  codeVerifier?: string;
  // a token request with a Basic Authorization header gets a 401, so only
  // the credentials in the form body work
  rejectBasicAuth?: boolean;
  // a token request without a Basic Authorization header gets a 401
  requireBasicAuth?: boolean;
  // a token request with another method gets a 405
  tokenMethod?: string;
  // a code exchange gets a 302 to this Location
  tokenLocation?: string;
  // a grant_type=refresh_token request gets a 302 to this Location
  refreshLocation?: string;
  // the answer to a grant_type=refresh_token request
  refreshedToken?: unknown;
  // the userinfo endpoint: a JSON body (or the body's text) and its status
  user?: unknown;
  userStatus?: number;
  // a userinfo request without an Authorization header gets a 401
  requireBearer?: boolean;
  // a userinfo request gets a 302 to this Location
  userLocation?: string;
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

const found = (location: string): Response =>
  new Response(null, { status: 302, headers: { Location: location } });

function json(value: unknown, status: number, contentType = "application/json"): Response {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

export class OAuth2Mock {
  readonly #entries = new Map<string, Entry>();
  readonly #server: ReturnType<typeof Bun.serve>;
  readonly #other: ReturnType<typeof Bun.serve>;
  #next = 0;

  constructor() {
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.#handle(req),
    });
    this.#server.unref();
    this.#other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.#handle(req),
    });
    this.#other.unref();
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
      moved: (status, endpoint, otherHost = false) =>
        `${base}/moved/${status}/${otherHost ? "localhost" : "127.0.0.1"}/${endpoint}`,
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
    const [, id = "", endpoint = "", status = "", host = "", target = ""] = pathname.split("/");
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
      case "moved":
        return new Response(null, {
          status: Number(status),
          headers: { Location: `http://${host}:${this.#other.port}/${id}/${target}` },
        });
      case "token": {
        const form = new URLSearchParams(body);
        if (spec.tokenMethod !== undefined && req.method !== spec.tokenMethod) {
          return json({ error: "invalid_request" }, 405);
        }
        if (
          spec.requireBasicAuth === true &&
          !req.headers.get("Authorization")?.startsWith("Basic ")
        ) {
          return json({ error: "invalid_client" }, 401);
        }
        if (spec.rejectBasicAuth === true && req.headers.has("Authorization")) {
          return json({ error: "invalid_client" }, 401);
        }
        if (spec.codeVerifier !== undefined && form.get("code_verifier") !== spec.codeVerifier) {
          return json({ error: "invalid_grant" }, 400);
        }
        if (form.get("grant_type") === "refresh_token") {
          if (spec.refreshLocation !== undefined) {
            return found(spec.refreshLocation);
          }
          return json(spec.refreshedToken ?? { error: "invalid_grant" }, 200);
        }
        if (spec.tokenLocation !== undefined) {
          return found(spec.tokenLocation);
        }
        return json(
          spec.token ?? { access_token: "abc", token_type: "bearer" },
          spec.tokenStatus ?? 200,
          spec.tokenContentType,
        );
      }
      case "userinfo":
        if (spec.requireBearer === true && !req.headers.has("Authorization")) {
          return json({ error: "invalid_token" }, 401);
        }
        if (spec.userLocation !== undefined) {
          return found(spec.userLocation);
        }
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

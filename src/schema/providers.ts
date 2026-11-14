// OAuth2 providers in the schema file (D40, amended 2026-11-13; S.6). Not an
// upstream file. Upstream's provider config is OAuth2ProviderConfig
// (core/collection_model_auth_options.go).
//
// The file may list an auth collection's providers under oauth2.providers.
// Every secret key holds an environment reference, {"env": "NAME"}, and the
// value is read from the process environment when the apply runs. The file,
// the logs and the reports never hold a secret value:
//
//   - the description of a file holds the references (file form);
//   - the description of the database holds the stored values, in memory
//     only (apply and plan compare them, and report key names); the writer
//     refuses a secret that is not a reference, so no value reaches a file;
//   - a resolved provider (apply form) holds the values, passed to the save.
//
// Upstream v0.41.0 has one secret key, clientSecret: the other keys are
// ids, URLs, the display name, the PKCE flag and the extra map. Those may
// also be references. A reference to a non-string key is read as text: pkce
// as "true" or "false", extra as a JSON object.

import type { OAuth2Config } from "@/collections/collection-model-auth-options";
import type { SchemaObject, SchemaValue } from "@/schema/types";
import { isPlainObject, jsonEqual } from "@/schema/values";

// the keys of a provider, in the order the file and the save use (name first)
export const providerKeyOrder = [
  "name",
  "clientId",
  "clientSecret",
  "authURL",
  "tokenURL",
  "userInfoURL",
  "displayName",
  "pkce",
  "extra",
] as const;

// the keys that hold a secret: they are references only in the file
export const secretProviderKeys: readonly string[] = ["clientSecret"];

// the value of a key that the file leaves out, as upstream's zero value
const providerDefaults: Readonly<Record<string, SchemaValue>> = Object.freeze({
  clientId: "",
  clientSecret: "",
  authURL: "",
  tokenURL: "",
  userInfoURL: "",
  displayName: "",
  pkce: null,
  extra: {},
});

// the name of a process environment variable
export const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The name of the variable of an environment reference, or undefined when the
// value is not one: an object whose only member is "env", a string.
export function envReference(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "env" || typeof value.env !== "string") {
    return undefined;
  }
  return value.env;
}

// the providers of a stored auth configuration, with their values (apply and
// plan only; see the header)
export function storedProviders(config: OAuth2Config): SchemaObject[] {
  return (config.providers ?? []).map((p) => ({
    name: p.name,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    authURL: p.authURL,
    tokenURL: p.tokenURL,
    userInfoURL: p.userInfoURL,
    displayName: p.displayName,
    pkce: p.pkce,
    extra: (p.extra ?? {}) as SchemaObject,
  }));
}

// The variable a generated reference names: the collection, the provider and
// the key, in upper case (USERS_GITHUB_CLIENT_SECRET).
export function generatedEnvName(collection: string, provider: string, key: string): string {
  return [collection, provider, key]
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

// The value of a variable as its key expects it. Throws when the text does not
// fit the key; the message names the variable, never the value.
function parseEnvValue(key: string, text: string, variable: string): SchemaValue {
  if (key === "pkce") {
    if (text === "true" || text === "false") {
      return text === "true";
    }
    throw new Error(`${variable} must be "true" or "false" (the pkce option of a provider)`);
  }
  if (key === "extra") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${variable} must hold a JSON object (the extra option of a provider)`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`${variable} must hold a JSON object (the extra option of a provider)`);
    }
    return parsed;
  }
  return text;
}

// The values of the providers the file lists, with the references read from
// getenv and the defaults filled in. A variable that is not set (or is set to
// nothing) is a problem: every missing name is reported at once, and the
// apply, the plan and the start stop on it.
export function resolveProviders(
  collection: string,
  providers: readonly SchemaObject[],
  getenv: (name: string) => string,
): SchemaObject[] {
  const missing = new Set<string>();
  const resolved = providers.map((provider) => {
    const out: SchemaObject = { name: String(provider.name) };
    for (const key of providerKeyOrder) {
      if (key === "name") {
        continue;
      }
      const given = provider[key];
      const variable = envReference(given);
      if (variable !== undefined) {
        if (!envNamePattern.test(variable)) {
          throw new Error(
            `the schema file's env reference for ${key} of provider ${provider.name} in ${collection} is not a variable name`,
          );
        }
        const text = getenv(variable);
        if (text === "") {
          missing.add(variable);
          continue;
        }
        out[key] = parseEnvValue(key, text, variable);
      } else {
        out[key] = given ?? providerDefaults[key] ?? null;
      }
    }
    return out;
  });
  if (missing.size > 0) {
    throw new Error(
      `the schema file sets OAuth2 providers of ${collection} from environment variables that are not set: ${[...missing].join(", ")}`,
    );
  }
  return resolved;
}

// What changed in a collection's providers, as lines that name the provider
// and the key ("github: clientSecret changed"); never a value.
export function providerChanges(
  before: readonly SchemaObject[],
  desired: readonly SchemaObject[],
): string[] {
  const changes: string[] = [];
  const beforeByName = new Map(before.map((p) => [String(p.name), p]));
  const desiredNames = new Set(desired.map((p) => String(p.name)));
  for (const provider of desired) {
    const name = String(provider.name);
    const old = beforeByName.get(name);
    if (old === undefined) {
      changes.push(`${name} added`);
      continue;
    }
    for (const key of providerKeyOrder) {
      if (key !== "name" && !jsonEqual(old[key] ?? null, provider[key] ?? null)) {
        changes.push(`${name}: ${key} changed`);
      }
    }
  }
  for (const provider of before) {
    if (!desiredNames.has(String(provider.name))) {
      changes.push(`${String(provider.name)} removed`);
    }
  }
  return changes;
}

// whether a stored value is what a variable holds
function matches(text: string, key: string, stored: SchemaValue | undefined): boolean {
  if (text === "") {
    return false;
  }
  try {
    return jsonEqual(parseEnvValue(key, text, "the variable"), stored ?? null);
  } catch {
    return false;
  }
}

// The file form of a collection's stored providers, for `schema pull` and the
// development write-back. A secret is a reference: the one the file already
// has for the provider, or a generated one. A value that is not a secret keeps
// the file's reference when the variable holds the stored value, and is written
// as its value otherwise (a default is left out). `notes` name the variables
// that must hold the secret, never a value.
export function providersFileForm(
  collection: string,
  stored: readonly SchemaObject[],
  existing: readonly SchemaObject[] | undefined,
  getenv: (name: string) => string,
): { providers: SchemaObject[]; notes: string[] } {
  const notes: string[] = [];
  const providers = stored.map((provider) => {
    const name = String(provider.name);
    const prior = existing?.find((p) => p.name === name);
    const out: SchemaObject = { name };
    for (const key of providerKeyOrder) {
      if (key === "name") {
        continue;
      }
      const priorRef = envReference(prior?.[key]);
      if (secretProviderKeys.includes(key)) {
        const variable = priorRef ?? generatedEnvName(collection, name, key);
        out[key] = { env: variable };
        if (!matches(getenv(variable), key, provider[key])) {
          notes.push(
            `${variable} must hold the ${key} of provider ${name} in ${collection} (the file holds no secret)`,
          );
        }
        continue;
      }
      const value = provider[key] ?? providerDefaults[key] ?? null;
      if (priorRef !== undefined && matches(getenv(priorRef), key, value)) {
        out[key] = { env: priorRef };
      } else if (!jsonEqual(value, providerDefaults[key] ?? null)) {
        out[key] = value;
      }
    }
    return out;
  });
  return { providers, notes };
}

// The writer's guard: every secret of a provider is a reference. A value
// here is an internal error, so it stops the write instead of reaching a file.
export function assertFileProviders(collection: string, providers: readonly SchemaObject[]): void {
  for (const provider of providers) {
    for (const key of secretProviderKeys) {
      if (envReference(provider[key]) === undefined) {
        throw new Error(
          `internal: the ${key} of provider ${String(provider.name)} in ${collection} is not an environment reference`,
        );
      }
    }
  }
}

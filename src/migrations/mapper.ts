// Upstream: plugins/jsvm/mapper.go (convertGoToJSName)
//
// The internal classes already use these names; the mapping is needed for
// the Settings structs, which keep their Go names (src/settings).

const nameExceptions: Readonly<Record<string, string>> = Object.freeze({ OAuth2: "oauth2" });

export function convertGoToJSName(name: string): string {
  if (Object.hasOwn(nameExceptions, name)) {
    return nameExceptions[name] as string;
  }

  let totalStartUppercase = 0;
  for (const c of name) {
    if (c !== "_" && !/^[\p{Lu}\p{Nd}]$/u.test(c)) {
      break;
    }
    totalStartUppercase++;
  }

  // all uppercase eg. "JSON" -> "json"
  if (name.length === totalStartUppercase) {
    return name.toLowerCase();
  }

  // eg. "JSONField" -> "jsonField"
  if (totalStartUppercase > 1) {
    return (
      name.slice(0, totalStartUppercase - 1).toLowerCase() + name.slice(totalStartUppercase - 1)
    );
  }

  // eg. "GetField" -> "getField"
  if (totalStartUppercase === 1) {
    return name.slice(0, 1).toLowerCase() + name.slice(1);
  }

  return name;
}

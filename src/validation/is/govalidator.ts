// Upstream: govalidator a9d515a09cc2 (github.com/asaskevich/govalidator
// v0.0.0-20230301143203-a9d515a09cc2) validator.go (IsEmail, IsURL,
// IsDNSName, IsHost, IsIP, IsHexcolor, IsJSON) and patterns.go (the
// patterns they use).
//
// The patterns are Go regexps (src/tools/regexp), not JS RegExps. url.Parse
// is go-url.ts, net.ParseIP is go-netip.ts. json.Unmarshal into a
// json.RawMessage (encoding/json v1 on v2, as the upstream binary is built)
// only checks the syntax: go-json.ts's decoder with v1 options, where only
// a syntax error makes the text invalid JSON.

import { mustCompile } from "@/tools/regexp/regexp";
import { JSONSyntaxError, anyType, unmarshal } from "@/tools/types/go-json";
import { byteLength, runeCount } from "@/validation/util";
import { Parse } from "@/validation/is/go-url";
import { isParseIP } from "@/validation/is/go-netip";

// Basic regular expressions for validating strings
const Email =
  "^(((([a-zA-Z]|\\d|[!#\\$%&'\\*\\+\\-\\/=\\?\\^_`{\\|}~]|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])+(\\.([a-zA-Z]|\\d|[!#\\$%&'\\*\\+\\-\\/=\\?\\^_`{\\|}~]|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])+)*)|((\\x22)((((\\x20|\\x09)*(\\x0d\\x0a))?(\\x20|\\x09)+)?(([\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]|\\x21|[\\x23-\\x5b]|[\\x5d-\\x7e]|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])|(\\([\\x01-\\x09\\x0b\\x0c\\x0d-\\x7f]|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]))))*(((\\x20|\\x09)*(\\x0d\\x0a))?(\\x20|\\x09)+)?(\\x22)))@((([a-zA-Z]|\\d|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])|(([a-zA-Z]|\\d|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])([a-zA-Z]|\\d|-|\\.|_|~|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])*([a-zA-Z]|\\d|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])))\\.)+(([a-zA-Z]|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])|(([a-zA-Z]|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])([a-zA-Z]|\\d|-|_|~|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])*([a-zA-Z]|[\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}])))\\.?$";
const Hexcolor = "^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$";
const DNSName = String.raw`^([a-zA-Z0-9_]{1}[a-zA-Z0-9_-]{0,62}){1}(\.[a-zA-Z0-9_]{1}[a-zA-Z0-9_-]{0,62})*[\._]?$`;
const IP = String.raw`(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))`;
const URLSchema = String.raw`((ftp|tcp|udp|wss?|https?):\/\/)`;
const URLUsername = String.raw`(\S+(:\S*)?@)`;
const URLPath = String.raw`((\/|\?|#)[^\s]*)`;
const URLPort = String.raw`(:(\d{1,5}))`;
const URLIP = String.raw`([1-9]\d?|1\d\d|2[01]\d|22[0-3]|24\d|25[0-5])(\.(\d{1,2}|1\d\d|2[0-4]\d|25[0-5])){2}(?:\.([0-9]\d?|1\d\d|2[0-4]\d|25[0-5]))`;
const URLSubdomain = String.raw`((www\.)|([a-zA-Z0-9]+([-_\.]?[a-zA-Z0-9])*[a-zA-Z0-9]\.[a-zA-Z0-9]+))`;
const URL =
  String.raw`^` +
  URLSchema +
  String.raw`?` +
  URLUsername +
  String.raw`?` +
  String.raw`((` +
  URLIP +
  String.raw`|(\[` +
  IP +
  String.raw`\])|(([a-zA-Z0-9]([a-zA-Z0-9-_]+)?[a-zA-Z0-9]([-\.][a-zA-Z0-9]+)*)|(` +
  URLSubdomain +
  String.raw`?))?(([a-zA-Z\x{00a1}-\x{ffff}0-9]+-?-?)*[a-zA-Z\x{00a1}-\x{ffff}0-9]+)(?:\.([a-zA-Z\x{00a1}-\x{ffff}]{1,}))?))\.?` +
  URLPort +
  String.raw`?` +
  URLPath +
  String.raw`?$`;

const rxEmail = mustCompile(Email);
const rxHexcolor = mustCompile(Hexcolor);
const rxDNSName = mustCompile(DNSName);
const rxURL = mustCompile(URL);

const maxURLRuneCount = 2083;
const minURLRuneCount = 3;

// IsEmail checks if the string is an email.
export function IsEmail(str: string): boolean {
  // TODO uppercase letters are not supported
  return rxEmail.matchString(str);
}

// IsURL checks if the string is an URL.
export function IsURL(str: string): boolean {
  if (
    str === "" ||
    runeCount(str) >= maxURLRuneCount ||
    byteLength(str) <= minURLRuneCount ||
    str.startsWith(".")
  ) {
    return false;
  }
  let strTemp = str;
  if (str.includes(":") && !str.includes("://")) {
    // support no indicated urlscheme but with colon for port number
    // http:// is appended so url.Parse will succeed, strTemp used so it does not impact rxURL.MatchString
    strTemp = "http://" + str;
  }
  let u: { host: string; path: string };
  try {
    u = Parse(strTemp);
  } catch {
    return false;
  }
  if (u.host.startsWith(".")) {
    return false;
  }
  if (u.host === "" && u.path !== "" && !u.path.includes(".")) {
    return false;
  }
  return rxURL.matchString(str);
}

// IsDNSName will validate the given string as a DNS name
export function IsDNSName(str: string): boolean {
  if (str === "" || byteLength(str.replaceAll(".", "")) > 255) {
    // constraints already violated
    return false;
  }
  return !IsIP(str) && rxDNSName.matchString(str);
}

// IsHost checks if the string is a valid IP (both v4 and v6) or a valid DNS name
export function IsHost(str: string): boolean {
  return IsIP(str) || IsDNSName(str);
}

// IsIP checks if a string is either IP version 4 or 6. Alias for `net.ParseIP`
export function IsIP(str: string): boolean {
  return isParseIP(str);
}

// IsHexcolor checks if the string is a hexadecimal color.
export function IsHexcolor(str: string): boolean {
  return rxHexcolor.matchString(str);
}

// IsJSON checks if the string is valid JSON (note: uses json.Unmarshal).
export function IsJSON(str: string): boolean {
  try {
    unmarshal(str, anyType, { legacy: true });
  } catch (err) {
    return !(err instanceof JSONSyntaxError);
  }
  return true;
}

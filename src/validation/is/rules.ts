// Upstream: ozzo-validation v4.4.1 is/rules.go: Domain, EmailFormat,
// HexColor, Host, JSON and URL, with their errors. The other rules are not
// used by upstream and are not ported.

import { mustCompile } from "@/tools/regexp/regexp";
import { NewError } from "@/validation/error";
import { IsEmail, IsHexcolor, IsHost, IsJSON, IsURL } from "@/validation/is/govalidator";
import { NewStringRuleWithError } from "@/validation/string";
import { byteLength } from "@/validation/util";

// ErrEmail is the error that returns in case of an invalid email.
export const ErrEmail = NewError("validation_is_email", "must be a valid email address");
// ErrURL is the error that returns in case of an invalid URL.
export const ErrURL = NewError("validation_is_url", "must be a valid URL");
// ErrHexColor is the error that returns in case of an invalid hexadecimal color code.
export const ErrHexColor = NewError(
  "validation_is_hex_color",
  "must be a valid hexadecimal color code",
);
// ErrJSON is the error that returns in case of an invalid JSON.
export const ErrJSON = NewError("validation_is_json", "must be in valid JSON format");
// ErrDomain is the error that returns in case of an invalid domain.
export const ErrDomain = NewError("validation_is_domain", "must be a valid domain");
// ErrHost is the error that returns in case of an invalid host.
export const ErrHost = NewError("validation_is_host", "must be a valid IP address or DNS name");

// EmailFormat validates if a string is an email or not. Note that it does
// NOT check if the MX record exists or not.
export const EmailFormat = NewStringRuleWithError(IsEmail, ErrEmail);
// URL validates if a string is a valid URL
export const URL = NewStringRuleWithError(IsURL, ErrURL);
// HexColor validates if a string is a valid hexadecimal color code
export const HexColor = NewStringRuleWithError(IsHexcolor, ErrHexColor);
// JSON validates if a string is in valid JSON format
export const JSON = NewStringRuleWithError(IsJSON, ErrJSON);
// Domain validates if a string is valid domain
export const Domain = NewStringRuleWithError(isDomain, ErrDomain);
// Host validates if a string is a valid IP (both v4 and v6) or a valid DNS name
export const Host = NewStringRuleWithError(IsHost, ErrHost);

// Domain regex source: https://stackoverflow.com/a/7933253
// Slightly modified: Removed 255 max length validation since Go regex does not
// support lookarounds. More info: https://stackoverflow.com/a/38935027
const reDomain = mustCompile(
  String.raw`^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-zA-Z]{1,63}| xn--[a-z0-9]{1,59})$`,
);

function isDomain(value: string): boolean {
  if (byteLength(value) > 255) {
    return false;
  }

  return reDomain.matchString(value);
}

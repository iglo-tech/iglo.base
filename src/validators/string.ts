// Upstream: core/validators/string.go
//
// regexp.Compile is src/tools/regexp's compile (Go RE2 syntax and error
// messages); net/netip's parsers are src/validation/is/go-netip.ts.

import { compile } from "@/tools/regexp/regexp";
import { NewError } from "@/validation/error";
import { ParseAddr, ParsePrefix } from "@/validation/is/go-netip";
import { ErrUnsupportedValueType } from "@/validators/validators";

// IsRegex checks whether the validated value is a valid regular expression
// pattern.
//
// Example:
//
//	Field("pattern", form.pattern, By(IsRegex))
export function IsRegex(value: unknown): Error | null {
  if (typeof value !== "string") {
    return ErrUnsupportedValueType;
  }

  if (value === "") {
    return null; // nothing to check
  }

  try {
    compile(value);
  } catch (err) {
    return NewError("validation_invalid_regex", (err as Error).message);
  }

  return null;
}

// IPOrSubnet checks whether the validated value is an individual IPv4/IPv6
// or CIDR subnet.
export function IPOrSubnet(value: unknown): Error | null {
  if (typeof value !== "string") {
    return ErrUnsupportedValueType;
  }

  if (value === "") {
    return null; // nothing to check
  }

  // subnet
  try {
    ParsePrefix(value);
    return null;
  } catch {
    // not a subnet
  }

  // individual IP
  try {
    ParseAddr(value);
    return null;
  } catch {
    // not an IP
  }

  return NewError("validation_invlaid_ip_or_subnet", "invalid IP or CIDR subnet");
}

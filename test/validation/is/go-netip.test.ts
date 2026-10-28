// Upstream: Go go1.27.2 src/net/netip/netip_test.go (TestParseAddr, TestParsePrefix)
import { expect, test } from "bun:test";
import { ParseAddr, ParsePrefix, isParseIP } from "@/validation/is/go-netip";

// errorMessage returns the message of the error thrown by fn, or "no error".
function errorMessage(fn: () => unknown): string {
  try {
    fn();
    return "no error";
  } catch (err) {
    return (err as Error).message;
  }
}

// validIPs: [in, is4, zone]. is4 is true only for a dotted IPv4 address;
// an IPv4-mapped IPv6 address is an IPv6 address (is4 false).
test.each<[string, boolean, string]>([
  // Basic zero IPv4 address.
  ["0.0.0.0", true, ""],
  // Basic non-zero IPv4 address.
  ["192.168.140.255", true, ""],
  // Basic zero IPv6 address.
  ["::", false, ""],
  // Localhost IPv6.
  ["::1", false, ""],
  // Fully expanded IPv6 address.
  ["fd7a:115c:a1e0:ab12:4843:cd96:626b:430b", false, ""],
  // IPv6 with elided fields in the middle.
  ["fd7a:115c::626b:430b", false, ""],
  // IPv6 with elided fields at the end.
  ["fd7a:115c:a1e0:ab12:4843:cd96::", false, ""],
  // IPv6 with single elided field at the end.
  ["fd7a:115c:a1e0:ab12:4843:cd96:626b::", false, ""],
  // IPv6 with single elided field in the middle.
  ["fd7a:115c:a1e0::4843:cd96:626b:430b", false, ""],
  // IPv6 with the trailing 32 bits written as IPv4 dotted decimal. (4in6)
  ["::ffff:192.168.140.255", false, ""],
  // IPv6 with a zone specifier.
  ["fd7a:115c:a1e0:ab12:4843:cd96:626b:430b%eth0", false, "eth0"],
  // IPv6 with dotted decimal and zone specifier.
  ["1:2::ffff:192.168.140.255%eth1", false, "eth1"],
  // 4-in-6 with zone
  ["::ffff:192.168.140.255%eth1", false, "eth1"],
  // IPv6 with capital letters.
  ["FD9E:1A04:F01D::1", false, ""],
])("TestParseAddr valid %p", (input, is4, zone) => {
  const got = ParseAddr(input);
  expect(got.is4).toBe(is4);
  expect(got.zone).toBe(zone);
  // net.ParseIP accepts only addresses without a zone.
  expect(isParseIP(input)).toBe(zone === "");
});

// validIPs rows whose Go wantErr is set: ParseAddr must fail with that exact message.
test.each<[string, string]>([
  ["010.000.015.001", `ParseAddr("010.000.015.001"): IPv4 field has octet with leading zero`],
  [
    "000001.00000002.00000003.000000004",
    `ParseAddr("000001.00000002.00000003.000000004"): IPv4 field has octet with leading zero`,
  ],
  ["::ffff:1.2.03.4", `ParseAddr("::ffff:1.2.03.4"): IPv4 field has octet with leading zero`],
  ["::ffff:1.2.3.z", `ParseAddr("::ffff:1.2.3.z"): unexpected character (at "z")`],
])("TestParseAddr wantErr %p", (input, wantErr) => {
  expect(errorMessage(() => ParseAddr(input))).toBe(wantErr);
});

test.each<string>([
  // Empty string
  "",
  // Garbage non-IP
  "bad",
  // Single number. Some parsers accept this as an IPv4 address in
  // big-endian uint32 form, but we don't.
  "1234",
  // IPv4 with a zone specifier
  "1.2.3.4%eth0",
  // IPv4 field must have at least one digit
  ".1.2.3",
  "1.2.3.",
  "1..2.3",
  // IPv4 address too long
  "1.2.3.4.5",
  // IPv4 in dotted octal form
  "0300.0250.0214.0377",
  // IPv4 in dotted hex form
  "0xc0.0xa8.0x8c.0xff",
  // IPv4 in class B form
  "192.168.12345",
  // IPv4 in class B form, with a small enough number to be
  // parseable as a regular dotted decimal field.
  "127.0.1",
  // IPv4 in class A form
  "192.1234567",
  // IPv4 in class A form, with a small enough number to be
  // parseable as a regular dotted decimal field.
  "127.1",
  // IPv4 field has value >255
  "192.168.300.1",
  // IPv4 with too many fields
  "192.168.0.1.5.6",
  // IPv6 with not enough fields
  "1:2:3:4:5:6:7",
  // IPv6 with too many fields
  "1:2:3:4:5:6:7:8:9",
  // IPv6 with 8 fields and a :: expander
  "1:2:3:4::5:6:7:8",
  // IPv6 with a field bigger than 2b
  "fe801::1",
  // IPv6 with non-hex values in field
  "fe80:tail:scal:e::",
  // IPv6 with a zone delimiter but no zone.
  "fe80::1%",
  // IPv6 (without ellipsis) with too many fields for trailing embedded IPv4.
  "ffff:ffff:ffff:ffff:ffff:ffff:ffff:192.168.140.255",
  // IPv6 (with ellipsis) with too many fields for trailing embedded IPv4.
  "ffff::ffff:ffff:ffff:ffff:ffff:ffff:192.168.140.255",
  // IPv6 with invalid embedded IPv4.
  "::ffff:192.168.140.bad",
  // IPv6 with multiple ellipsis ::.
  "fe80::1::1",
  // IPv6 with invalid non hex/colon character.
  "fe80:1?:1",
  // IPv6 with truncated bytes after single colon.
  "fe80:",
  // IPv6 with 5 zeros in last group
  "0:0:0:0:0:ffff:0:00000",
  // IPv6 with 5 zeros in one group and embedded IPv4
  "0:0:0:0:00000:ffff:127.1.2.3",
])("TestParseAddr invalid %p", (input) => {
  expect(() => ParseAddr(input)).toThrow();
  expect(isParseIP(input)).toBe(false);
});

// TestPrefix rows: [prefix, bits, addr is4].
test.each<[string, number, boolean]>([
  ["192.168.0.0/24", 24, true],
  ["192.168.1.1/32", 32, true],
  // CGNAT range; prefix not multiple of 8
  ["100.64.0.0/10", 10, true],
  ["2001:db8::/96", 96, false],
  ["0.0.0.0/0", 0, true],
  ["::/0", 0, false],
  ["2000::/3", 3, false],
])("TestPrefix %p", (prefix, bits, is4) => {
  const got = ParsePrefix(prefix);
  expect(got.bits).toBe(bits);
  expect(got.addr.is4).toBe(is4);
});

// TestParsePrefixError rows: [prefix, errstr].
test.each<[string, string]>([
  ["192.168.0.0", "no '/'"],
  ["1.257.1.1/24", "value >255"],
  ["1.1.1.0/q", "bad bits"],
  ["1.1.1.0/-1", "bad bits"],
  ["1.1.1.0/33", "out of range"],
  ["2001::/129", "out of range"],
  // Zones are not allowed: https://go.dev/issue/51899
  ["1.1.1.0%a/24", "unexpected character"],
  ["2001:db8::%a/32", "zones cannot be present"],
  ["1.1.1.0/+32", "bad bits"],
  ["1.1.1.0/-32", "bad bits"],
  ["1.1.1.0/032", "bad bits"],
  ["1.1.1.0/0032", "bad bits"],
])("TestParsePrefixError %p", (prefix, errstr) => {
  expect(errorMessage(() => ParsePrefix(prefix))).toContain(errstr);
});

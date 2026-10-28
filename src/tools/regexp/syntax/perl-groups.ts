// Upstream: Go go1.27.2 src/regexp/syntax/perl_groups.go (generated there
// by make_perl_groups.pl; ported as is).

export interface charGroup {
  sign: number;
  class: readonly number[];
}

// \d
const code1 = [0x30, 0x39];

// \s
const code2 = [0x9, 0xa, 0xc, 0xd, 0x20, 0x20];

// \w
const code3 = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];

// [:alnum:]
const code4 = [0x30, 0x39, 0x41, 0x5a, 0x61, 0x7a];

// [:alpha:]
const code5 = [0x41, 0x5a, 0x61, 0x7a];

// [:ascii:]
const code6 = [0x0, 0x7f];

// [:blank:]
const code7 = [0x9, 0x9, 0x20, 0x20];

// [:cntrl:]
const code8 = [0x0, 0x1f, 0x7f, 0x7f];

// [:digit:]
const code9 = [0x30, 0x39];

// [:graph:]
const code10 = [0x21, 0x7e];

// [:lower:]
const code11 = [0x61, 0x7a];

// [:print:]
const code12 = [0x20, 0x7e];

// [:punct:]
const code13 = [0x21, 0x2f, 0x3a, 0x40, 0x5b, 0x60, 0x7b, 0x7e];

// [:space:]
const code14 = [0x9, 0xd, 0x20, 0x20];

// [:upper:]
const code15 = [0x41, 0x5a];

// [:word:]
const code16 = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];

// [:xdigit:]
const code17 = [0x30, 0x39, 0x41, 0x46, 0x61, 0x66];

export const perlGroup = new Map<string, charGroup>([
  [String.raw`\d`, { sign: 1, class: code1 }],
  [String.raw`\D`, { sign: -1, class: code1 }],
  [String.raw`\s`, { sign: 1, class: code2 }],
  [String.raw`\S`, { sign: -1, class: code2 }],
  [String.raw`\w`, { sign: 1, class: code3 }],
  [String.raw`\W`, { sign: -1, class: code3 }],
]);

export const posixGroup = new Map<string, charGroup>([
  ["[:alnum:]", { sign: 1, class: code4 }],
  ["[:^alnum:]", { sign: -1, class: code4 }],
  ["[:alpha:]", { sign: 1, class: code5 }],
  ["[:^alpha:]", { sign: -1, class: code5 }],
  ["[:ascii:]", { sign: 1, class: code6 }],
  ["[:^ascii:]", { sign: -1, class: code6 }],
  ["[:blank:]", { sign: 1, class: code7 }],
  ["[:^blank:]", { sign: -1, class: code7 }],
  ["[:cntrl:]", { sign: 1, class: code8 }],
  ["[:^cntrl:]", { sign: -1, class: code8 }],
  ["[:digit:]", { sign: 1, class: code9 }],
  ["[:^digit:]", { sign: -1, class: code9 }],
  ["[:graph:]", { sign: 1, class: code10 }],
  ["[:^graph:]", { sign: -1, class: code10 }],
  ["[:lower:]", { sign: 1, class: code11 }],
  ["[:^lower:]", { sign: -1, class: code11 }],
  ["[:print:]", { sign: 1, class: code12 }],
  ["[:^print:]", { sign: -1, class: code12 }],
  ["[:punct:]", { sign: 1, class: code13 }],
  ["[:^punct:]", { sign: -1, class: code13 }],
  ["[:space:]", { sign: 1, class: code14 }],
  ["[:^space:]", { sign: -1, class: code14 }],
  ["[:upper:]", { sign: 1, class: code15 }],
  ["[:^upper:]", { sign: -1, class: code15 }],
  ["[:word:]", { sign: 1, class: code16 }],
  ["[:^word:]", { sign: -1, class: code16 }],
  ["[:xdigit:]", { sign: 1, class: code17 }],
  ["[:^xdigit:]", { sign: -1, class: code17 }],
]);

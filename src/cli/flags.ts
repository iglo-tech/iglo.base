// Upstream: github.com/spf13/pflag v1.0.10 (flag.go, errors.go, bool.go, int.go,
// string_slice.go) and github.com/spf13/cobra v1.10.2 (command.go: Find,
// stripFlags, argsMinusFirstX), which upstream's pocketbase.go and cmd/ use.
//
// Only the semantics the iglo.base CLI needs are ported: long flags
// (--flag=value, --flag value), bool flags (--flag, --flag=false), int,
// string and string slice values, "--" as terminator, the -h/-v shorthands,
// and pflag's error texts. Unknown flags are either an error or skipped the
// way pflag's ParseErrorsAllowlist.UnknownFlags skips them.

export type FlagKind = "string" | "bool" | "int" | "stringSlice";

export type FlagValue = string | boolean | number | string[];

export interface FlagSpec {
  name: string;
  kind: FlagKind;
  shorthand?: string;
  usage: string;
  // Default shown in help output, as pflag prints it (omitted when empty).
  defaultText?: string;
}

export class FlagError extends Error {}

export interface ParsedFlags {
  // Only flags that were set on the command line.
  values: Map<string, FlagValue>;
  // Positional arguments, in order.
  args: string[];
}

export interface ParseOptions {
  allowUnknown: boolean;
}

function isBoolFlag(spec: FlagSpec | undefined): boolean {
  return spec?.kind === "bool";
}

// strconv.ParseBool
function parseBool(value: string): boolean | undefined {
  switch (value) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
    default:
      return undefined;
  }
}

// strconv.ParseInt(s, 0, 64): optional sign, base prefixes 0x, 0o, 0b and a
// leading 0 for octal, underscores only between digits when a prefix is used.
function parseGoInt(value: string): number | undefined {
  const match = /^([+-]?)(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|0[0-7_]*|[1-9][0-9]*)$/.exec(
    value,
  );
  if (!match) {
    return undefined;
  }
  const sign = match[1] === "-" ? -1n : 1n;
  let digits = match[2] ?? "";
  const hasPrefix = digits.length > 1 && digits.startsWith("0");
  if (digits.includes("_")) {
    // underscores must separate digits and are only allowed with a base prefix
    if (!hasPrefix || /__|_$/.test(digits) || /^0[xXoObB]?_?$/.test(digits)) {
      return undefined;
    }
    digits = digits.replaceAll("_", "");
  }
  let parsed: bigint;
  if (/^0[xX]/.test(digits)) {
    parsed = BigInt(`0x${digits.slice(2)}`);
  } else if (/^0[oO]/.test(digits)) {
    parsed = BigInt(`0o${digits.slice(2)}`);
  } else if (/^0[bB]/.test(digits)) {
    parsed = BigInt(`0b${digits.slice(2)}`);
  } else if (digits.length > 1 && digits.startsWith("0")) {
    parsed = BigInt(`0o${digits.slice(1)}`);
  } else {
    parsed = BigInt(digits);
  }
  parsed *= sign;
  if (parsed > 9223372036854775807n || parsed < -9223372036854775808n) {
    return undefined;
  }
  return Number(parsed);
}

// encoding/csv Reader.Read for a single record, as pflag's readAsCSV uses it.
function readAsCSV(value: string): string[] | undefined {
  if (value === "") {
    return [];
  }
  const fields: string[] = [];
  let i = 0;
  for (;;) {
    let field = "";
    if (value[i] === '"') {
      i++;
      for (;;) {
        const quote = value.indexOf('"', i);
        if (quote === -1) {
          return undefined; // extraneous or missing " in quoted-field
        }
        field += value.slice(i, quote);
        i = quote + 1;
        if (value[i] === '"') {
          field += '"';
          i++;
          continue;
        }
        if (i < value.length && value[i] !== ",") {
          return undefined;
        }
        break;
      }
    } else {
      const comma = value.indexOf(",", i);
      const end = comma === -1 ? value.length : comma;
      field = value.slice(i, end);
      if (field.includes('"')) {
        return undefined; // bare " in non-quoted-field
      }
      i = end;
    }
    fields.push(field);
    if (i >= value.length) {
      return fields;
    }
    i++; // skip the comma
  }
}

function setValue(values: Map<string, FlagValue>, spec: FlagSpec, raw: string): void {
  const invalid = (cause: string): FlagError =>
    new FlagError(
      `invalid argument ${JSON.stringify(raw)} for ${JSON.stringify(
        spec.shorthand ? `-${spec.shorthand}, --${spec.name}` : `--${spec.name}`,
      )} flag: ${cause}`,
    );

  switch (spec.kind) {
    case "string":
      values.set(spec.name, raw);
      return;
    case "bool": {
      const parsed = parseBool(raw);
      if (parsed === undefined) {
        throw invalid(`strconv.ParseBool: parsing ${JSON.stringify(raw)}: invalid syntax`);
      }
      values.set(spec.name, parsed);
      return;
    }
    case "int": {
      const parsed = parseGoInt(raw);
      if (parsed === undefined) {
        throw invalid(`strconv.ParseInt: parsing ${JSON.stringify(raw)}: invalid syntax`);
      }
      values.set(spec.name, parsed);
      return;
    }
    case "stringSlice": {
      const parsed = readAsCSV(raw);
      if (parsed === undefined) {
        throw invalid("parse error: invalid quoted field");
      }
      // the first --flag replaces the default, later ones append
      const previous = values.get(spec.name);
      values.set(spec.name, Array.isArray(previous) ? [...previous, ...parsed] : parsed);
      return;
    }
  }
}

// pflag stripUnknownFlagValue
function stripUnknownFlagValue(args: string[]): string[] {
  if (args.length === 0) {
    return args;
  }
  if (args[0]?.startsWith("-")) {
    return args;
  }
  return args.slice(1);
}

// pflag FlagSet.parseArgs with interspersed positional arguments.
export function parseFlags(argv: string[], specs: FlagSpec[], options: ParseOptions): ParsedFlags {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const byShorthand = new Map(
    specs.filter((spec) => spec.shorthand).map((spec) => [spec.shorthand, spec]),
  );
  const values = new Map<string, FlagValue>();
  const positional: string[] = [];

  let args = argv;
  while (args.length > 0) {
    const s = args[0] ?? "";
    args = args.slice(1);

    if (s.length <= 1 || !s.startsWith("-")) {
      positional.push(s);
      continue;
    }

    if (s.startsWith("--")) {
      if (s.length === 2) {
        positional.push(...args);
        break;
      }
      const body = s.slice(2);
      if (body.startsWith("-") || body.startsWith("=")) {
        throw new FlagError(`bad flag syntax: ${s}`);
      }
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const spec = byName.get(name);
      if (!spec) {
        if (options.allowUnknown) {
          if (eq === -1) {
            args = stripUnknownFlagValue(args);
          }
          continue;
        }
        throw new FlagError(`unknown flag: --${name}`);
      }
      let raw: string;
      if (eq !== -1) {
        raw = body.slice(eq + 1);
      } else if (isBoolFlag(spec)) {
        raw = "true";
      } else if (args.length > 0) {
        raw = args[0] ?? "";
        args = args.slice(1);
      } else {
        throw new FlagError(`flag needs an argument: --${name}`);
      }
      setValue(values, spec, raw);
      continue;
    }

    // shorthand flags, possibly combined ("-hv")
    let shorthands = s.slice(1);
    while (shorthands.length > 0) {
      const c = shorthands[0] ?? "";
      const spec = byShorthand.get(c);
      if (!spec) {
        if (options.allowUnknown) {
          if (shorthands.length > 2 && shorthands[1] === "=") {
            shorthands = "";
          } else {
            args = stripUnknownFlagValue(args);
            shorthands = shorthands.slice(1);
          }
          continue;
        }
        throw new FlagError(
          `unknown shorthand flag: ${JSON.stringify(c).replaceAll('"', "'")} in -${shorthands}`,
        );
      }
      let raw: string;
      if (shorthands.length > 2 && shorthands[1] === "=") {
        raw = shorthands.slice(2);
        shorthands = "";
      } else if (isBoolFlag(spec)) {
        raw = "true";
        shorthands = shorthands.slice(1);
      } else if (shorthands.length > 1) {
        raw = shorthands.slice(1);
        shorthands = "";
      } else if (args.length > 0) {
        raw = args[0] ?? "";
        args = args.slice(1);
        shorthands = "";
      } else {
        throw new FlagError(`flag needs an argument: '${c}' in -${shorthands}`);
      }
      setValue(values, spec, raw);
    }
  }

  return { values, args: positional };
}

// cobra stripFlags: the non-flag words of argv, used to find the command.
// It looks only at whether a flag takes a value, the way cobra does, so a
// value-taking flag followed by a word consumes that word.
export function stripFlags(argv: string[], specs: FlagSpec[]): string[] {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const byShorthand = new Map(
    specs.filter((spec) => spec.shorthand).map((spec) => [spec.shorthand, spec]),
  );
  const commands: string[] = [];
  let args = argv;
  while (args.length > 0) {
    const s = args[0] ?? "";
    args = args.slice(1);
    if (s === "--") {
      break;
    }
    const takesNextAsValue =
      (s.startsWith("--") && !s.includes("=") && !isBoolFlag(byName.get(s.slice(2)))) ||
      (s.startsWith("-") &&
        !s.includes("=") &&
        s.length === 2 &&
        !isBoolFlag(byShorthand.get(s.slice(1))));
    if (takesNextAsValue) {
      if (args.length <= 1) {
        break;
      }
      args = args.slice(1);
      continue;
    }
    if (s !== "" && !s.startsWith("-")) {
      commands.push(s);
    }
  }
  return commands;
}

// cobra Command.argsMinusFirstX: argv without the first occurrence of the
// command name, skipping flag values the same way stripFlags does.
export function argsMinusFirst(argv: string[], name: string, specs: FlagSpec[]): string[] {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const byShorthand = new Map(
    specs.filter((spec) => spec.shorthand).map((spec) => [spec.shorthand, spec]),
  );
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i] ?? "";
    if (s === "--") {
      break;
    }
    if (s.startsWith("-")) {
      const takesNextAsValue =
        (s.startsWith("--") && !s.includes("=") && !isBoolFlag(byName.get(s.slice(2)))) ||
        (!s.startsWith("--") &&
          !s.includes("=") &&
          s.length === 2 &&
          !isBoolFlag(byShorthand.get(s.slice(1))));
      if (takesNextAsValue) {
        i++;
      }
      continue;
    }
    if (s === name) {
      return [...argv.slice(0, i), ...argv.slice(i + 1)];
    }
  }
  return argv;
}

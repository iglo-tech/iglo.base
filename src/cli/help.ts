// Upstream: github.com/spf13/cobra v1.10.2 (command.go default help and usage
// templates) and github.com/spf13/pflag v1.0.10 (flag.go FlagUsagesWrapped),
// which format upstream's --help output. Reproduced closely, not byte for byte.

import type { FlagSpec } from "@/cli/flags";

export interface CommandHelp {
  // full command path, e.g. "pocketbase serve"
  path: string;
  // the "Use" line after the command path, e.g. "[domain(s)]"
  use?: string;
  short: string;
  runnable: boolean;
  subcommands: { name: string; short: string }[];
  localFlags: FlagSpec[];
  inheritedFlags: FlagSpec[];
}

function varname(spec: FlagSpec): string {
  switch (spec.kind) {
    case "string":
      return "string";
    case "int":
      return "int";
    case "stringSlice":
      return "strings";
    case "bool":
      return "";
  }
}

export function flagUsages(specs: FlagSpec[]): string {
  const sorted = specs.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines: { head: string; usage: string }[] = [];
  let maxlen = 0;
  for (const spec of sorted) {
    let head = spec.shorthand ? `  -${spec.shorthand}, --${spec.name}` : `      --${spec.name}`;
    const type = varname(spec);
    if (type) {
      head += ` ${type}`;
    }
    maxlen = Math.max(maxlen, head.length);
    let usage = spec.usage;
    if (spec.defaultText !== undefined) {
      usage += ` (default ${spec.defaultText})`;
    }
    lines.push({ head, usage });
  }
  return lines
    .map(({ head, usage }) => {
      const spacing = " ".repeat(maxlen - head.length);
      const wrapped = usage.replaceAll("\n", `\n${" ".repeat(maxlen + 3)}`);
      return `${head}${spacing}   ${wrapped}`.trimEnd();
    })
    .join("\n");
}

export function usageText(cmd: CommandHelp): string {
  let out = "Usage:";
  if (cmd.runnable) {
    out += `\n  ${cmd.path}${cmd.use ? ` ${cmd.use}` : ""} [flags]`;
  }
  if (cmd.subcommands.length > 0) {
    out += `\n  ${cmd.path} [command]`;
    const padding = Math.max(11, ...cmd.subcommands.map((sub) => sub.name.length));
    out += "\n\nAvailable Commands:";
    for (const sub of cmd.subcommands) {
      out += `\n  ${sub.name.padEnd(padding)} ${sub.short}`;
    }
  }
  if (cmd.localFlags.length > 0) {
    out += `\n\nFlags:\n${flagUsages(cmd.localFlags)}`;
  }
  if (cmd.inheritedFlags.length > 0) {
    out += `\n\nGlobal Flags:\n${flagUsages(cmd.inheritedFlags)}`;
  }
  if (cmd.subcommands.length > 0) {
    out += `\n\nUse "${cmd.path} [command] --help" for more information about a command.`;
  }
  return `${out}\n`;
}

export function helpText(cmd: CommandHelp): string {
  return `${cmd.short}\n\n${usageText(cmd)}`;
}

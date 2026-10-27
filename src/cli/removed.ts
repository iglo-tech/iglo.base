// Upstream: examples/base/main.go (the prebuilt binary's plugin flags) and
// plugins/migratecmd, plugins/ghupdate (the migrate and update commands).
// None of them is ported; they are rejected with a message that points to
// docs/design/01-scope.md. The exact texts are recorded there too.

const scopeDoc = "https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md";

const extensionSection = `${scopeDoc}#removed-the-extension-surface`;

export const removedFlags = [
  "hooksDir",
  "hooksWatch",
  "hooksPool",
  "migrationsDir",
  "automigrate",
] as const;

export function removedFlagMessage(name: string): string {
  return `flag --${name} is not supported: iglo.base has no JavaScript hooks or user migrations. See ${extensionSection}`;
}

export function removedCommandMessage(name: string): string | undefined {
  switch (name) {
    case "update":
      return `command "update" is not supported: iglo.base does not replace its own executable; deploy a new release instead. See ${scopeDoc}#removed-the-update-command`;
    case "migrate":
      return `command "migrate" is not supported: iglo.base has no user migrations; system migrations run automatically at startup. See ${extensionSection}`;
    default:
      return undefined;
  }
}

export function ignoredDirsWarning(dirs: string[]): string {
  return `${dirs.join(" and ")} ${dirs.length === 1 ? "is" : "are"} ignored: iglo.base does not run JavaScript hooks or user migrations. See ${extensionSection}`;
}

// The first removed flag in argv, before any "--" terminator.
export function findRemovedFlag(argv: string[]): string | undefined {
  for (const arg of argv) {
    if (arg === "--") {
      return undefined;
    }
    for (const name of removedFlags) {
      if (arg === `--${name}` || arg.startsWith(`--${name}=`)) {
        return name;
      }
    }
  }
  return undefined;
}

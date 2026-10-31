// Upstream: examples/base/main.go (the prebuilt binary's hooks flags) and
// plugins/ghupdate (the update command). Neither is ported; they are
// rejected with a message that points to docs/design/01-scope.md. The exact
// texts are recorded there too.

const scopeDoc = "https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md";

const extensionSection = `${scopeDoc}#removed-the-extension-surface`;

export const removedFlags = ["hooksDir", "hooksWatch", "hooksPool"] as const;

export function removedFlagMessage(name: string): string {
  return `flag --${name} is not supported: iglo.base has no JavaScript hooks. See ${extensionSection}`;
}

export function removedCommandMessage(name: string): string | undefined {
  switch (name) {
    case "update":
      return `command "update" is not supported: iglo.base does not replace its own executable; deploy a new release instead. See ${scopeDoc}#removed-the-update-command`;
    default:
      return undefined;
  }
}

export function ignoredDirWarning(dir: string): string {
  return `${dir} is ignored: iglo.base does not run JavaScript hooks. See ${extensionSection}`;
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

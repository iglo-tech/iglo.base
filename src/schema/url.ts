// The $schema URL the writer puts in the file (D40): the JSON Schema is a
// release asset, next to SHA256SUMS (.github/workflows/release.yml). Not an
// upstream file.

const releases = "https://github.com/iglo-tech/iglo.base/releases";

// the URL of the JSON Schema of a release; a build without a version
// ("(untracked)", see src/cli/root.ts) points at the latest release
export function schemaURL(version: string): string {
  return version === "(untracked)"
    ? `${releases}/latest/download/iglo.schema.json`
    : `${releases}/download/v${version}/iglo.schema.json`;
}

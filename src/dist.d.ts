// The build output src/main.ts embeds (scripts/ui/build.ts and scripts/sqlite-embed.ts), resolved
// through the @dist/* path alias; it does not exist before the build.
declare module "@dist/ui.pack" {
  // the embedded file's path ($bunfs in the compiled executable)
  const path: string;
  export default path;
}

declare module "@dist/libsqlite3.dylib" {
  // the embedded file's path ($bunfs in the compiled executable)
  const path: string;
  export default path;
}

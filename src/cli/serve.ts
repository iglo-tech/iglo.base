// Upstream: cmd/serve.go
//
// Also logs the one warning about pb_hooks and pb_migrations directories,
// which upstream's prebuilt binary would load (examples/base/main.go, jsvm
// defaults "pb_data/../pb_hooks" and "pb_data/../pb_migrations").

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { FlagSpec, FlagValue } from "@/cli/flags";
import { ignoredDirsWarning } from "@/cli/removed";
import type { AppConfig, CliContext } from "@/cli/root";
import { logTime, serve } from "@/server/serve";

export const serveShort =
  "Starts the web server (default to 127.0.0.1:8090 if no domain is specified)";

export const serveUse = "[domain(s)]";

export const serveFlags: FlagSpec[] = [
  {
    name: "origins",
    kind: "stringSlice",
    usage: "CORS allowed domain origins list",
    defaultText: "[*]",
  },
  {
    name: "http",
    kind: "string",
    usage:
      "TCP address to listen for the HTTP server\n(if domain args are specified - default to 0.0.0.0:80, otherwise - default to 127.0.0.1:8090)",
  },
  {
    name: "https",
    kind: "string",
    usage:
      "TCP address to listen for the HTTPS server\n(if domain args are specified - default to 0.0.0.0:443, otherwise - default to empty string, aka. no TLS)\nThe incoming HTTP traffic also will be auto redirected to the HTTPS version",
  },
];

export async function runServeCommand(
  app: AppConfig,
  values: Map<string, FlagValue>,
  domains: string[],
  ctx: CliContext,
): Promise<void> {
  let httpAddr = (values.get("http") as string | undefined) ?? "";
  let httpsAddr = (values.get("https") as string | undefined) ?? "";
  const allowedOrigins = (values.get("origins") as string[] | undefined) ?? ["*"];

  // set default listener addresses if at least one domain is specified
  if (domains.length > 0) {
    if (httpAddr === "") {
      httpAddr = "0.0.0.0:80";
    }
    if (httpsAddr === "") {
      httpsAddr = "0.0.0.0:443";
    }
  } else if (httpAddr === "") {
    httpAddr = "127.0.0.1:8090";
  }

  const ignored = ["pb_hooks", "pb_migrations"]
    .map((name) => join(app.dataDir, "..", name))
    .filter((dir) => existsSync(dir));
  if (ignored.length > 0) {
    ctx.out.stderr(`${logTime(ctx.out.now())} WARN ${ignoredDirsWarning(ignored)}\n`);
  }

  await serve(
    {
      httpAddr,
      httpsAddr,
      certificateDomains: domains,
      allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["*"],
      showStartBanner: true,
    },
    ctx.out,
    ctx.shutdown,
  );
}

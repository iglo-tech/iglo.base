// Upstream: cmd/superuser.go (NewSuperuserCommand: upsert, create, update,
// delete, otp, ips), with cobra's subcommand lookup and help, and the
// bootstrap pocketbase.go's Execute runs before it (skipped for -h,
// --help, -v and --version).

import type { App } from "@/app/app";
import { clearBootstrap } from "@/app/bootstrap";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import {
  argsMinusFirst,
  FlagError,
  parseFlags,
  stripFlags,
  type FlagSpec,
  type FlagValue,
} from "@/cli/flags";
import { helpText, usageText, type CommandHelp } from "@/cli/help";
import type { AppConfig, CliContext } from "@/cli/root";
import { bootstrapApp } from "@/cli/serve";
import { newOTP, saveOTP } from "@/records/otp-model";
import { newRecord } from "@/records/record-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import { findAuthRecordByEmail } from "@/records/record-query";
import { deleteRecord, saveRecord } from "@/records/record-save";
import { saveSettings } from "@/settings/settings-query";
import { randomStringWithAlphabet } from "@/tools/security/random";
import { goQuote } from "@/fields/field";
import { EmailFormat } from "@/validation/is/rules";

export const superuserShort = "Manage superusers";

// A command error: printed by log.Fatal, with the usage first when set.
export class CommandError extends Error {
  constructor(
    message: string,
    readonly usage?: string,
  ) {
    super(message);
  }
}

interface Subcommand {
  name: string;
  example: string;
  short: string;
  run(app: App, args: string[], ctx: CliContext): Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function invalidEmail(email: string | undefined): boolean {
  return email === undefined || email === "" || EmailFormat.validate(email) !== null;
}

// fatih/color output: the color codes wrap the whole text, newline included
function colored(ctx: CliContext, codes: string, text: string): void {
  ctx.out.stdout(ctx.out.color ? `\x1b[${codes}m${text}\x1b[0m` : text);
}

// color.Green / color.Yellow append a newline to the format
export const green = (ctx: CliContext, text: string): void => colored(ctx, "32", `${text}\n`);
const yellow = (ctx: CliContext, text: string): void => colored(ctx, "33", `${text}\n`);

const subcommands: Subcommand[] = [
  {
    name: "upsert",
    example: "superuser upsert test@example.com 1234567890",
    short: "Creates, or updates if email exists, a single superuser",
    async run(app, args, ctx) {
      if (args.length !== 2) {
        throw new CommandError("missing email and password arguments");
      }
      const [email = "", password = ""] = args;

      if (invalidEmail(email)) {
        throw new CommandError("missing or invalid email address");
      }

      let superusersCol;
      try {
        superusersCol = findCachedCollectionByNameOrId(app, CollectionNameSuperusers);
      } catch (err) {
        throw new CommandError(
          `failed to fetch ${goQuote(CollectionNameSuperusers)} collection: ${errorMessage(err)}`,
        );
      }

      let superuser;
      try {
        superuser = findAuthRecordByEmail(app, superusersCol, email);
      } catch {
        superuser = newRecord(superusersCol);
      }

      superuser.setEmail(email);
      superuser.setPassword(password);

      try {
        await saveRecord(app, superuser);
      } catch (err) {
        throw new CommandError(`failed to upsert superuser account: ${errorMessage(err)}`);
      }

      green(ctx, `Successfully saved superuser ${goQuote(superuser.email())}!`);
    },
  },
  {
    name: "create",
    example: "superuser create test@example.com 1234567890",
    short: "Creates a new superuser",
    async run(app, args, ctx) {
      if (args.length !== 2) {
        throw new CommandError("missing email and password arguments");
      }
      const [email = "", password = ""] = args;

      if (invalidEmail(email)) {
        throw new CommandError("missing or invalid email address");
      }

      let superusersCol;
      try {
        superusersCol = findCachedCollectionByNameOrId(app, CollectionNameSuperusers);
      } catch (err) {
        throw new CommandError(
          `failed to fetch ${goQuote(CollectionNameSuperusers)} collection: ${errorMessage(err)}`,
        );
      }

      const superuser = newRecord(superusersCol);
      superuser.setEmail(email);
      superuser.setPassword(password);

      try {
        await saveRecord(app, superuser);
      } catch (err) {
        throw new CommandError(`failed to create new superuser account: ${errorMessage(err)}`);
      }

      green(ctx, `Successfully created new superuser ${goQuote(superuser.email())}!`);
    },
  },
  {
    name: "update",
    example: "superuser update test@example.com 1234567890",
    short: "Changes the password of a single superuser",
    async run(app, args, ctx) {
      if (args.length !== 2) {
        throw new CommandError("missing email and password arguments");
      }
      const [email = "", password = ""] = args;

      if (invalidEmail(email)) {
        throw new CommandError("missing or invalid email address");
      }

      let superuser;
      try {
        superuser = findAuthRecordByEmail(app, CollectionNameSuperusers, email);
      } catch {
        throw new CommandError(`superuser with email ${goQuote(email)} doesn't exist`);
      }

      superuser.setPassword(password);

      try {
        await saveRecord(app, superuser);
      } catch (err) {
        throw new CommandError(
          `failed to change superuser ${goQuote(superuser.email())} password: ${errorMessage(err)}`,
        );
      }

      green(ctx, `Successfully changed superuser ${goQuote(superuser.email())} password!`);
    },
  },
  {
    name: "delete",
    example: "superuser delete test@example.com",
    short: "Deletes an existing superuser",
    async run(app, args, ctx) {
      const [email] = args;
      if (invalidEmail(email) || email === undefined) {
        throw new CommandError("invalid or missing email address");
      }

      let superuser;
      try {
        superuser = findAuthRecordByEmail(app, CollectionNameSuperusers, email);
      } catch {
        yellow(ctx, `superuser ${goQuote(email)} is missing or already deleted`);
        return;
      }

      try {
        await deleteRecord(app, superuser);
      } catch (err) {
        throw new CommandError(
          `failed to delete superuser ${goQuote(superuser.email())}: ${errorMessage(err)}`,
        );
      }

      green(ctx, `Successfully deleted superuser ${goQuote(superuser.email())}!`);
    },
  },
  {
    name: "otp",
    example: "superuser otp test@example.com",
    short: "Creates a new OTP for the specified superuser",
    async run(app, args, ctx) {
      const [email] = args;
      if (invalidEmail(email) || email === undefined) {
        throw new CommandError("invalid or missing email address");
      }

      let superuser;
      try {
        superuser = findAuthRecordByEmail(app, CollectionNameSuperusers, email);
      } catch {
        throw new CommandError(`superuser with email ${goQuote(email)} doesn't exist`);
      }

      const otpConfig = superuser.collection().otp;
      if (!otpConfig.enabled) {
        throw new CommandError("OTP auth is not enabled for the _superusers collection");
      }

      const pass = randomStringWithAlphabet(Number(otpConfig.length), "1234567890");

      const otp = newOTP(app);
      otp.setCollectionRef(superuser.collection().id);
      otp.setRecordRef(superuser.id);
      otp.setPassword(pass);

      try {
        await saveOTP(app, otp);
      } catch (err) {
        throw new CommandError(`failed to create OTP: ${errorMessage(err)}`);
      }

      colored(
        ctx,
        "42;30",
        `Successfully created OTP for superuser ${goQuote(superuser.email())}:`,
      );
      green(ctx, `\n├─ Id:    ${otp.id}`);
      green(ctx, `├─ Pass:  ${pass}`);
      colored(ctx, "32", `└─ Valid: ${otpConfig.duration}s\n\n`);
    },
  },
  {
    name: "ips",
    example: "superuser ips 127.0.0.1 10.0.0.0/24",
    short:
      "Updates the superuser IPs whitelist setting (the IPs/subnets arguments must be space separated; leave empty to clear the whitelist restriction)",
    async run(app, args, ctx) {
      const settings = app.settings;
      // a nil slice when there are no arguments
      settings.settings.SuperuserIPs = args.length > 0 ? args : null;

      await saveSettings(app, settings);

      if (args.length === 0) {
        green(ctx, "Successfully cleared SuperuserIPs setting!");
      } else {
        // Println: the text is colored, the newline is not
        ctx.out.stdout(
          `${ctx.out.color ? "\x1b[42;30mSuccessfully updated SuperuserIPs setting:\x1b[0m" : "Successfully updated SuperuserIPs setting:"}\n`,
        );
        const superuserIPs = app.settings.settings.SuperuserIPs ?? [];
        superuserIPs.forEach((ip, i) => {
          green(ctx, i === superuserIPs.length - 1 ? `└─ ${ip}` : `├─ ${ip}`);
        });
      }
    },
  },
];

// cobra lists the subcommands sorted by name
const sortedSubcommands = subcommands.toSorted((a, b) => (a.name < b.name ? -1 : 1));

function helpFlag(cmd: string): FlagSpec {
  return { name: "help", kind: "bool", shorthand: "h", usage: `help for ${cmd}` };
}

const bootstrapSkipFlags = new Set(["-h", "--help", "-v", "--version"]);

// Runs `superuser ...`; ctx.args still starts with the command words.
//
// resolveConfig gives the app config for the persistent flags set on the
// command line.
export async function runSuperuserCommand(
  resolveConfig: (values: Map<string, FlagValue>) => AppConfig,
  persistent: FlagSpec[],
  ctx: CliContext,
  name: string,
): Promise<void> {
  const rest = argsMinusFirst(ctx.args, "superuser", persistent);
  // cobra Command.Find: the first argument that is not a flag (or a flag's value)
  const [subName] = stripFlags(rest, [helpFlag("superuser"), ...persistent]);
  const sub =
    subName === undefined ? undefined : subcommands.find((command) => command.name === subName);

  // pocketbase.go eagerParseFlags: the persistent flags, before the command
  // runs (a flag error is reported by the command's own parse below)
  let config: AppConfig;
  try {
    config = resolveConfig(parseFlags(ctx.args, persistent, { allowUnknown: true }).values);
  } catch {
    config = resolveConfig(new Map());
  }

  // the bootstrap runs before the command (pocketbase.go skipBootstrap)
  const skipBootstrap = ctx.args.some((arg) => bootstrapSkipFlags.has(arg));
  let app: App | undefined;
  if (!skipBootstrap) {
    app = await bootstrapApp(config, ctx);
  }

  try {
    if (sub === undefined) {
      const local = [helpFlag("superuser")];
      const help: CommandHelp = {
        path: `${name} superuser`,
        short: superuserShort,
        runnable: false,
        subcommands: sortedSubcommands.map((command) => ({
          name: command.name,
          short: command.short,
        })),
        localFlags: local,
        inheritedFlags: persistent,
      };
      try {
        parseFlags(rest, [...local, ...persistent], { allowUnknown: false });
      } catch (err) {
        if (err instanceof FlagError) {
          throw new CommandError(err.message, usageText(help));
        }
        throw err;
      }
      // a command without its own action prints its help
      ctx.out.stdout(helpText(help));
      return;
    }

    const local = [helpFlag(sub.name)];
    let parsed;
    try {
      parsed = parseFlags(argsMinusFirst(rest, sub.name, persistent), [...local, ...persistent], {
        allowUnknown: false,
      });
    } catch (err) {
      if (err instanceof FlagError) {
        // SilenceUsage: no usage for the subcommands' errors
        throw new CommandError(err.message);
      }
      throw err;
    }
    if (parsed.values.get("help") === true) {
      ctx.out.stdout(
        helpText({
          path: `${name} superuser ${sub.name}`,
          short: sub.short,
          example: sub.example,
          runnable: true,
          subcommands: [],
          localFlags: local,
          inheritedFlags: persistent,
        }),
      );
      return;
    }

    if (app === undefined) {
      app = await bootstrapApp(config, ctx);
    }
    await sub.run(app, parsed.args, ctx);
  } finally {
    if (app !== undefined) {
      await clearBootstrap(app);
    }
  }
}

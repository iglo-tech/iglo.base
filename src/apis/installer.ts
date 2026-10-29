// Upstream: apis/installer.go (DefaultInstallerFunc, loadInstaller,
// needInstallerSuperuser, findOrCreateInstallerSuperuser, executablePath),
// with the fatih/color output it prints.
//
// Serve runs it after the start banner (upstream starts it in a goroutine
// before the banner, and its database work ends after the banner is
// printed). Launching the browser (osutils.LaunchURL) is passed in by
// main.ts; errors of the launch are ignored, as upstream's.

import type { App } from "@/app/app";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import { HashExp, NotExp } from "@/db/dbx/expression";
import { isNoRowsError } from "@/db/dbx/rows";
import { newRecord, type Record } from "@/records/record-model";
import { CollectionNameSuperusers, DefaultInstallerEmail } from "@/records/record-model-superusers";
import { countRecords, findAuthRecordByEmail } from "@/records/record-query";
import { saveRecord } from "@/records/record-save";
import { newStaticAuthToken } from "@/records/record-tokens";

export interface InstallerOptions {
  // whether the dashboard is embedded (ui.DistDirFS != nil)
  hasDashboard: boolean;
  // os.Args[0], or how the program runs from source
  executablePath: string;
  // osutils.LaunchURL: opens the url in a browser when possible
  launchURL(url: string): void;
  stdout(text: string): void;
  color: boolean;
}

// 30 minutes, in nanoseconds
const installerTokenDuration = 30n * 60n * 1_000_000_000n;

function paint(color: boolean, codes: string, text: string): string {
  return color ? `\x1b[${codes}m${text}\x1b[0m` : text;
}

// DefaultInstallerFunc is the default PocketBase installer function.
//
// It will attempt to open a link in the browser (with a short-lived auth
// token for the systemSuperuser) to the installer UI so that users can
// create their own custom superuser record.
export function defaultInstallerFunc(
  app: App,
  systemSuperuser: Record,
  baseURL: string,
  options: InstallerOptions,
): void {
  const { stdout, color } = options;
  if (!options.hasDashboard) {
    stdout(
      paint(
        color,
        "35",
        `You can create your first superuser by running: ${options.executablePath} superuser upsert EMAIL PASS\n`,
      ),
    );
    return;
  }

  const token = newStaticAuthToken(systemSuperuser, installerTokenDuration, app.clock);

  // launch url (ignore errors and always print a help text as fallback)
  const url = `${baseURL.replace(/\/+$/, "")}/_/#/pbinstall/${token}`;
  try {
    options.launchURL(url);
  } catch {
    // ignored
  }
  stdout(
    paint(
      color,
      "35",
      "\n(!) Launch the URL below in the browser if it hasn't been open already to create your first superuser account:\n",
    ),
  );
  stdout(`${paint(color, "1;36", url)}\n`);
  stdout(
    paint(
      color,
      "90;3",
      `(you can also create your first superuser by running: ${options.executablePath} superuser upsert EMAIL PASS)\n\n`,
    ),
  );
}

export async function loadInstaller(
  app: App,
  baseURL: string,
  options: InstallerOptions,
): Promise<void> {
  if (!needInstallerSuperuser(app)) {
    return;
  }

  const superuser = await findOrCreateInstallerSuperuser(app);

  defaultInstallerFunc(app, superuser, baseURL, options);
}

function needInstallerSuperuser(app: App): boolean {
  try {
    const total = countRecords(
      app,
      CollectionNameSuperusers,
      new NotExp(new HashExp({ email: DefaultInstallerEmail })),
    );
    return total === 0;
  } catch {
    return false;
  }
}

async function findOrCreateInstallerSuperuser(app: App): Promise<Record> {
  const col = findCachedCollectionByNameOrId(app, CollectionNameSuperusers);

  try {
    return findAuthRecordByEmail(app, col, DefaultInstallerEmail);
  } catch (err) {
    if (!isNoRowsError(err)) {
      throw err;
    }
  }

  const record = newRecord(col);
  record.setEmail(DefaultInstallerEmail);
  record.setRandomPassword();

  await saveRecord(app, record);

  return record;
}

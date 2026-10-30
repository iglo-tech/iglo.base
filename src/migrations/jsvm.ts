// Upstream: plugins/jsvm/jsvm.go (registerMigrations, filesContent) and the
// goja_nodejs console, process, buffer and require modules it enables
//
// Each migration file runs in its own node:vm context, as upstream gives
// each file its own goja runtime. The file sees its bindings as globals of
// that context, and nothing of the process: no global of the app is set or
// read, an undeclared variable stays in the file's context, and it has no
// Bun, fetch or timers, as in goja. A function scope would not give that.
//
// `.js` and `.ts` files get the same treatment (no transpile), as upstream.
// The file text runs when it is loaded, for every command, also when it is
// already applied, so an error in any file stops the start; upstream panics
// there (PanicError). up and down run later, in the runner's transaction.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import type { App } from "@/app/app";
import { bindAll, type BindConfig } from "@/migrations/binds";
import { AppBinding, type RunTxFunc } from "@/migrations/binds-app";
import type { Membrane } from "@/migrations/membrane";
import { addMigration, type Migration, type MigrationFunc } from "@/migrations/migrations-runner";

// defaultScriptPath
const scriptName = "pb.js";

const migrationsFilesPattern = /^.*(\.js|\.ts)$/;

// A failed load: upstream's jsvm.MustRegister panics.
export class PanicError extends Error {}

export interface JsvmConfig extends BindConfig {
  migrationsDir: string;
  hooksDir: string;
  environ: Record<string, string>;
  // the line console.log prints (with the time, on standard output)
  log(line: string): void;
}

// registerMigrations: the migrations of all files of the directory, sorted
// by file name.
export function registerMigrations(config: JsvmConfig): Migration[] {
  const list: Migration[] = [];

  let files: [string, string][];
  try {
    files = filesContent(config.migrationsDir);
  } catch (err) {
    throw new PanicError(`registerMigrations: ${(err as Error).message}`);
  }

  for (const [file, content] of files) {
    try {
      runFile(config, file, content, list);
    } catch (err) {
      throw new PanicError(
        `registerMigrations: failed to run migration ${file}: ${describeError(err, config.cwd)}`,
      );
    }
  }

  return list;
}

// filesContent: the direct files of the directory and their content, by
// file name; none when the directory is missing.
function filesContent(dirPath: string): [string, string][] {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return entries
    .filter((f) => !f.isDirectory() && migrationsFilesPattern.test(f.name))
    .map((f): [string, string] => [f.name, readFileSync(path.join(dirPath, f.name), "utf8")])
    .toSorted(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function runFile(config: JsvmConfig, file: string, content: string, list: Migration[]): void {
  const sandbox: Record<string, unknown> = {};
  const context = vm.createContext(sandbox);
  const m = bindAll(sandbox, context, config);

  sandbox.console = newConsole(config);
  sandbox.process = { env: { ...config.environ } };
  sandbox.Buffer = Buffer;
  sandbox.require = newRequire(config, context, sandbox, m);
  // oxlint-disable-next-line no-underscore-dangle
  sandbox.__hooks = path.resolve(config.cwd, config.hooksDir);

  const filename = path.join(config.cwd, scriptName);

  const toMigrationFunc = (fn: unknown, i: number): MigrationFunc | null => {
    if (fn === undefined || fn === null) {
      return null;
    }
    if (typeof fn !== "function") {
      throw new TypeError(
        `could not convert function call parameter ${i}: could not convert ${String(fn)} to func(core.App) error`,
      );
    }
    return (txApp) => {
      try {
        runMigrationFunc(fn, txApp, m);
      } catch (err) {
        throw normalizeException(err, m, config.cwd);
      }
    };
  };

  sandbox.migrate = (up: unknown, down: unknown): void => {
    addMigration(list, {
      file,
      up: toMigrationFunc(up, 0),
      down: toMigrationFunc(down, 1),
    });
  };

  let script: vm.Script;
  try {
    script = new vm.Script(content, { filename });
  } catch (err) {
    throw new SyntaxError(`SyntaxError: ${filename}: ${(err as Error).message}`);
  }
  script.runInContext(context);
}

// Runs an up, a down or a runInTransaction callback of a migration file. An
// exception passes through as it is. The result follows goja's conversion
// to Go's `error`: null and undefined are no error. A promise is an error
// too: bindings are synchronous, and nothing runs after the transaction,
// because the app given to it is closed when it returns.
function runMigrationFunc(fn: unknown, txApp: App, m: Membrane): void {
  const runTxFunc: RunTxFunc = (nested, nestedApp) => {
    runMigrationFunc(nested, nestedApp, m);
  };

  const binding = new AppBinding(txApp, runTxFunc);

  try {
    const result = (fn as (app: unknown) => unknown)(m.toVm(binding));

    if (result === undefined || result === null) {
      return;
    }

    const hostError = m.targetOf(result) ?? result;
    if (hostError instanceof Error) {
      throw hostError;
    }

    if (isPromise(result)) {
      // the promise still settles; its outcome no longer matters
      result.then(undefined, () => {});
      throw new Error(
        "could not convert [object Promise] to error: up and down must be synchronous, not async and not returning a promise",
      );
    }

    throw new Error(`could not convert ${String(result)} to error`);
  } finally {
    binding.close();
  }
}

function isPromise(v: unknown): v is Promise<unknown> {
  return Object.prototype.toString.call(v) === "[object Promise]";
}

// normalizeException: a thrown binding error is the original error; any
// other exception is goja's text for it.
function normalizeException(err: unknown, m: Membrane, cwd: string): Error {
  if (err instanceof Error) {
    return err; // an error of the binding or of the result check
  }
  return m.hostError(err) ?? new Error(describeError(err, cwd));
}

function describeError(err: unknown, cwd: string): string {
  if (err instanceof SyntaxError && err.message.startsWith("SyntaxError: ")) {
    return `SyntaxError: ${err.message}`;
  }

  if (typeof err !== "object" || err === null) {
    return String(err);
  }

  const e = err as { name?: unknown; message?: unknown; stack?: unknown };
  if (typeof e.message !== "string") {
    return String(err);
  }

  // JSC's texts for what goja words differently
  const missingVariable = /^Can't find variable: (.+)$/.exec(e.message);
  const message =
    missingVariable !== null ? `${String(missingVariable[1])} is not defined` : e.message;

  const text = `${String(e.name)}: ${message}`;

  const file = path.join(cwd, scriptName);
  const frame = typeof e.stack === "string" ? firstFrame(e.stack, file) : undefined;
  return frame === undefined ? text : `${text} at ${frame}`;
}

// the file:line:column of the stack's first frame in the migration file
function firstFrame(stack: string, file: string): string | undefined {
  for (const line of stack.split("\n")) {
    if (line.trimStart().startsWith("at ")) {
      const i = line.indexOf(file);
      if (i !== -1) {
        const match = /^[^:)\s]*:\d+:\d+/.exec(line.slice(i));
        return match?.[0];
      }
    }
  }
  return undefined;
}

// console (goja_nodejs util.Format); every method prints the same way
function newConsole(config: JsvmConfig): Record<string, unknown> {
  const write = (...args: unknown[]): void => {
    config.log(formatLog(args));
  };
  return { log: write, error: write, warn: write, info: write, debug: write };
}

function formatLog(args: unknown[]): string {
  const rest = [...args];

  let text = "";
  const [first] = rest;
  if (typeof first === "string") {
    rest.shift();
    text = first.replace(/%([sdj%])/g, (directive, verb: string) => {
      if (verb === "%") {
        return "%";
      }
      if (rest.length === 0) {
        return directive;
      }
      const value = rest.shift();
      switch (verb) {
        case "d":
          return String(Number(value));
        case "j":
          return JSON.stringify(value) ?? "undefined";
        default:
          return String(value);
      }
    });
    if (rest.length === 0) {
      return text;
    }
    text += " ";
  }

  return text + rest.map((arg) => String(arg)).join(" ");
}

// goja_nodejs require: a relative name is relative to the requiring module,
// and to the working directory in a migration file; other names are
// node_modules packages and upstream's native modules. Modules run in the
// file's context, so they see the same globals.
function newRequire(
  config: JsvmConfig,
  context: vm.Context,
  sandbox: Record<string, unknown>,
  m: Membrane,
): (name: string) => unknown {
  const cache = new Map<string, { exports: unknown }>();

  const invalidModule = (): Error => new m.vm.GoError("Invalid module");

  const load = (filename: string): unknown => {
    const cached = cache.get(filename);
    if (cached !== undefined) {
      return cached.exports;
    }

    const text = readFileSync(filename, "utf8");

    const moduleObject = m.vm.object();
    moduleObject.exports = m.vm.object();
    cache.set(filename, moduleObject as { exports: unknown });

    if (filename.endsWith(".json")) {
      moduleObject.exports = m.vm.parse(text);
      return moduleObject.exports;
    }

    const wrapper = vm.runInContext(
      `(function (exports, require, module, __filename, __dirname) {${text}\n})`,
      context,
      { filename },
    ) as (...args: unknown[]) => unknown;
    wrapper(
      moduleObject.exports,
      requireFrom(path.dirname(filename)),
      moduleObject,
      filename,
      path.dirname(filename),
    );

    return moduleObject.exports;
  };

  const requireFrom =
    (dir: string) =>
    (name: string): unknown => {
      const native = nativeModule(name, sandbox, m);
      if (native !== undefined) {
        return native;
      }
      const filename = resolveModule(name, dir);
      if (filename === undefined) {
        throw invalidModule();
      }
      return load(filename);
    };

  return requireFrom(config.cwd);
}

function nativeModule(name: string, sandbox: Record<string, unknown>, m: Membrane): unknown {
  switch (name) {
    case "console":
      return sandbox.console;
    case "process":
      return sandbox.process;
    case "buffer": {
      const buffer = m.vm.object();
      buffer.Buffer = sandbox.Buffer;
      return buffer;
    }
    case "util":
      return m.vm.object();
    default:
      return undefined;
  }
}

function resolveModule(name: string, dir: string): string | undefined {
  if (name === "") {
    return undefined;
  }

  if (name.startsWith("./") || name.startsWith("../") || name.startsWith("/")) {
    return resolvePath(path.resolve(dir, name));
  }

  for (let current = dir; ; current = path.dirname(current)) {
    const found = resolvePath(path.join(current, "node_modules", name));
    if (found !== undefined) {
      return found;
    }
    if (current === path.dirname(current)) {
      return undefined;
    }
  }
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

function resolvePath(base: string): string | undefined {
  for (const candidate of [base, `${base}.js`, `${base}.json`]) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  const packageFile = path.join(base, "package.json");
  if (isFile(packageFile)) {
    const main = (JSON.parse(readFileSync(packageFile, "utf8")) as { main?: unknown }).main;
    if (typeof main === "string") {
      const found = resolvePath(path.resolve(base, main));
      if (found !== undefined) {
        return found;
      }
    }
  }

  for (const candidate of ["index.js", "index.json"]) {
    const file = path.join(base, candidate);
    if (isFile(file)) {
      return file;
    }
  }

  return undefined;
}

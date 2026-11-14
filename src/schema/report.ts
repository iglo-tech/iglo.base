// The report of a schema apply and of `schema plan` (D40, S.3). Not an
// upstream file. The text is the plan's format: the changes, the migrations,
// the data that would be lost and every problem, with its next step.
//
// A problem reads the way the issue's example does:
//
//	posts.author: required, 312 records empty. Add a migration that fills it, or make the field optional.
//	  examples: 0x1, 0x2

import type { CollectionChange, FieldChange, IndexChange, SchemaChanges } from "@/schema/diff";

// One thing that stops the apply (or would, for the plan).
export interface Problem {
  // where it is: a collection, or collection.field
  where: string;
  message: string;
  // up to five record ids, for a problem about records
  examples?: string[];
  // the next step to take
  next?: string;
}

// The values or rows that the apply removes, for a collection or a field.
export interface LostValues {
  collection: string;
  field?: string;
  rows: number;
  // set for a select, file or relation that becomes single-valued: the rows
  // hold more than one value, and the extra values go
  becomesSingle?: boolean;
}

// A declared rename (S.5): a field of a collection, or a collection. The rate
// limit rules that a collection rename relabels are listed with it.
export interface RenameItem {
  kind: "field" | "collection";
  collection?: string;
  from: string;
  to: string;
  // the migration file that declares it
  file: string;
  rateLimits: { from: string; to: string }[];
}

export interface ApplyReport {
  mode: "apply" | "plan";
  allowDataLoss: boolean;
  changes: SchemaChanges;
  // the JavaScript and TypeScript migrations that ran (or would run) in the
  // transaction, in run order
  migrations: string[];
  // the declared renames that ran (or would run), before the changes
  renames: RenameItem[];
  lost: LostValues[];
  problems: Problem[];
  // the name of the backup made before the apply, when one was made
  backup?: string;
  // whether the change was committed
  committed: boolean;
}

export function newReport(mode: "apply" | "plan", allowDataLoss: boolean): ApplyReport {
  return {
    mode,
    allowDataLoss,
    changes: { collections: [] },
    migrations: [],
    renames: [],
    lost: [],
    problems: [],
    committed: false,
  };
}

// whether the change applies (plan) or applied (apply) without a problem
export function reportIsOK(report: ApplyReport): boolean {
  return report.problems.length === 0;
}

// whether the report has any change to show
export function reportChanged(report: ApplyReport): boolean {
  return (
    report.changes.collections.length > 0 ||
    report.migrations.length > 0 ||
    report.renames.length > 0
  );
}

const fieldMarks: Record<FieldChange["kind"], string> = {
  added: "+",
  removed: "-",
  changed: "~",
  replaced: "!",
};

function fieldLine(change: FieldChange): string {
  const mark = fieldMarks[change.kind];
  switch (change.kind) {
    case "added":
      return `${mark} ${change.name} (${change.type})`;
    case "removed":
      return `${mark} ${change.name} (${change.type})`;
    case "replaced":
      return `${mark} ${change.name}: the type changes, so the field is removed and added again`;
    case "changed":
      return `${mark} ${change.name}: ${change.details.join(", ")}`;
  }
}

function indexLine(change: IndexChange): string {
  const rows = change.rows === undefined ? "" : ` (${change.rows} records in the table)`;
  return `index ${change.kind}: ${change.statement}${rows}`;
}

function collectionLines(change: CollectionChange): string[] {
  const lines: string[] = [];
  const header =
    change.kind === "added"
      ? `+ ${change.name} (${change.type})`
      : change.kind === "removed"
        ? `- ${change.name} (${change.type})`
        : `~ ${change.name} (${change.type})`;
  lines.push(`  ${header}`);
  // the implied system fields of a new or removed collection are not news
  for (const field of change.fields) {
    if (!(change.kind !== "changed" && field.system)) {
      lines.push(`      ${fieldLine(field)}`);
    }
  }
  if (change.fieldOrder) {
    lines.push("      the fields are in another order");
  }
  if (change.rules.length > 0) {
    lines.push(`      rules: ${change.rules.join(", ")}`);
  }
  if (change.options.length > 0) {
    lines.push(`      options: ${change.options.join(", ")}`);
  }
  for (const index of change.indexes) {
    lines.push(`      ${indexLine(index)}`);
  }
  return lines;
}

// The report's text, one block after another; the last line says the result.
export function formatReport(report: ApplyReport): string {
  const lines: string[] = [];

  if (report.changes.collections.length === 0) {
    lines.push("collections: no changes");
  } else {
    lines.push("collections:");
    for (const change of report.changes.collections) {
      lines.push(...collectionLines(change));
    }
  }

  if (report.renames.length > 0) {
    lines.push(`renames ${report.mode === "plan" ? "that would run" : "run"}:`);
    for (const rename of report.renames) {
      const what =
        rename.kind === "field"
          ? `field ${rename.collection}.${rename.from} -> ${rename.to}`
          : `collection ${rename.from} -> ${rename.to}`;
      lines.push(`  ${what} (${rename.file})`);
      for (const rule of rename.rateLimits) {
        lines.push(`    rate limit rule ${rule.from} -> ${rule.to}`);
      }
    }
  }

  if (report.migrations.length > 0) {
    lines.push(
      `migrations ${report.mode === "plan" ? "that would run" : "run"}:`,
      ...report.migrations.map((file) => `  ${file}`),
    );
  }

  if (report.lost.length > 0) {
    lines.push("data that would be lost:");
    for (const item of report.lost) {
      const where = item.field === undefined ? item.collection : `${item.collection}.${item.field}`;
      const what =
        item.becomesSingle === true
          ? "records hold more than one value"
          : item.field === undefined
            ? "records"
            : "values";
      const allowed = report.allowDataLoss ? " (allowed by --allow-data-loss)" : "";
      lines.push(`  ${where}: ${item.rows} ${what}${allowed}`);
    }
  }

  if (report.problems.length > 0) {
    lines.push("problems:");
    for (const problem of report.problems) {
      lines.push(
        `  ${problem.where}: ${problem.message}${problem.next ? `. ${problem.next}` : ""}`,
      );
      if (problem.examples !== undefined && problem.examples.length > 0) {
        lines.push(`    examples: ${problem.examples.join(", ")}`);
      }
    }
  }

  if (report.problems.length > 0) {
    const count = report.problems.length;
    lines.push(
      report.mode === "plan"
        ? `the schema would not apply: ${count} problem${count === 1 ? "" : "s"}`
        : `the schema is not applied: ${count} problem${count === 1 ? "" : "s"}`,
    );
  } else if (!reportChanged(report)) {
    lines.push("the schema is up to date: nothing would change");
  } else if (report.mode === "plan") {
    lines.push("the schema would apply");
  } else {
    lines.push("the schema is applied");
  }

  return lines.join("\n") + "\n";
}

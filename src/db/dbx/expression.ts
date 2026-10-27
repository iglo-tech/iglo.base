// Upstream: pocketbase/dbx v1.13.0 expression.go
//
// `In` is a reserved word in JavaScript, so dbx's In() is inExp() here.

import type { DB } from "@/db/dbx/db";
import type { Params } from "@/db/dbx/query";

// Expression represents a DB expression that can be embedded in a SQL statement.
export interface Expression {
  // Build converts an expression into a SQL fragment.
  // If the expression contains binding parameters, they will be added to the given Params.
  build(db: DB, params: Params): string;
}

export function isExpression(value: unknown): value is Expression {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { build?: unknown }).build === "function"
  );
}

function paramsLen(params: Params): number {
  return Object.keys(params).length;
}

// Go's sort.Strings (byte order for the ASCII names the builder sorts)
export function sortStrings(names: string[]): string[] {
  return names.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// NewExp generates an expression with the specified SQL fragment and the optional binding parameters.
export function newExp(e: string, params?: Params): Exp {
  return new Exp(e, params ?? null);
}

// Not generates a NOT expression which prefixes "NOT" to the specified expression.
export function not(e: Expression): Expression {
  return new NotExp(e);
}

// And generates an AND expression which concatenates the given expressions with "AND".
export function and(...exps: (Expression | null | undefined)[]): Expression {
  return new AndOrExp(exps, "AND");
}

// Or generates an OR expression which concatenates the given expressions with "OR".
export function or(...exps: (Expression | null | undefined)[]): Expression {
  return new AndOrExp(exps, "OR");
}

// In generates an IN expression for the specified column and the list of allowed values.
// If values is empty, a SQL "0=1" will be generated which represents a false expression.
export function inExp(col: string, ...values: unknown[]): Expression {
  return new InExp(col, values, false);
}

// NotIn generates an NOT IN expression for the specified column and the list of disallowed values.
// If values is empty, an empty string will be returned indicating a true expression.
export function notIn(col: string, ...values: unknown[]): Expression {
  return new InExp(col, values, true);
}

// DefaultLikeEscape specifies the default special character escaping for LIKE expressions
// The strings at 2i positions are the special characters to be escaped while those at 2i+1 positions
// are the corresponding escaped versions.
export const defaultLikeEscape: readonly string[] = Object.freeze([
  "\\",
  "\\\\",
  "%",
  "\\%",
  "_",
  "\\_",
]);

// Like generates a LIKE expression for the specified column and the possible strings that the column should be like.
// If multiple values are present, the column should be like *all* of them. For example, Like("name", "key", "word")
// will generate a SQL expression: "name" LIKE "%key%" AND "name" LIKE "%word%".
//
// By default, each value will be surrounded by "%" to enable partial matching. If a value contains special characters
// such as "%", "\", "_", they will also be properly escaped.
//
// You may call Escape() and/or Match() to change the default behavior. For example, Like("name", "key").Match(false, true)
// generates "name" LIKE "key%".
export function like(col: string, ...values: string[]): LikeExp {
  return new LikeExp(col, values, false, "LIKE");
}

// NotLike generates a NOT LIKE expression.
export function notLike(col: string, ...values: string[]): LikeExp {
  return new LikeExp(col, values, false, "NOT LIKE");
}

// OrLike generates an OR LIKE expression.
// This is similar to Like() except that the column should be like one of the possible values.
export function orLike(col: string, ...values: string[]): LikeExp {
  return new LikeExp(col, values, true, "LIKE");
}

// OrNotLike generates an OR NOT LIKE expression.
export function orNotLike(col: string, ...values: string[]): LikeExp {
  return new LikeExp(col, values, true, "NOT LIKE");
}

// Exists generates an EXISTS expression by prefixing "EXISTS" to the given expression.
export function exists(exp: Expression): Expression {
  return new ExistsExp(exp, false);
}

// NotExists generates an EXISTS expression by prefixing "NOT EXISTS" to the given expression.
export function notExists(exp: Expression): Expression {
  return new ExistsExp(exp, true);
}

// Between generates a BETWEEN expression.
// For example, Between("age", 10, 30) generates: "age" BETWEEN 10 AND 30
export function between(col: string, from: unknown, to: unknown): Expression {
  return new BetweenExp(col, from, to, false);
}

// NotBetween generates a NOT BETWEEN expression.
// For example, NotBetween("age", 10, 30) generates: "age" NOT BETWEEN 10 AND 30
export function notBetween(col: string, from: unknown, to: unknown): Expression {
  return new BetweenExp(col, from, to, true);
}

// Enclose surrounds the provided nonempty expression with parenthesis "()".
export function enclose(exp: Expression): Expression {
  return new EncloseExp(exp);
}

// Exp represents an expression with a SQL fragment and a list of optional binding parameters.
export class Exp implements Expression {
  constructor(
    private readonly e: string,
    private readonly params: Params | null,
  ) {}

  build(_db: DB, params: Params): string {
    if (this.params === null || paramsLen(this.params) === 0) {
      return this.e;
    }
    Object.assign(params, this.params);
    return this.e;
  }
}

// HashExp represents a hash expression.
//
// A hash expression is a map whose keys are DB column names which need to be filtered according
// to the corresponding values. For example, HashExp{"level": 2, "dept": 10} will generate
// the SQL: "level"=2 AND "dept"=10.
//
// HashExp also handles nil values and slice values. For example, HashExp{"level": []interface{}{1, 2}, "dept": nil}
// will generate: "level" IN (1, 2) AND "dept" IS NULL.
export class HashExp implements Expression {
  constructor(readonly values: Readonly<Record<string, unknown>>) {}

  build(db: DB, params: Params): string {
    // ensure the hash exp generates the same SQL for different runs
    const names = sortStrings(Object.keys(this.values));
    if (names.length === 0) {
      return "";
    }

    const parts: string[] = [];
    for (const name of names) {
      const value = this.values[name];
      if (value === null || value === undefined) {
        parts.push(db.quoteColumnName(name) + " IS NULL");
      } else if (isExpression(value)) {
        const sql = value.build(db, params);
        if (sql !== "") {
          parts.push("(" + sql + ")");
        }
      } else if (Array.isArray(value)) {
        const sql = inExp(name, ...value).build(db, params);
        if (sql !== "") {
          parts.push(sql);
        }
      } else {
        const pn = `p${paramsLen(params)}`;
        parts.push(db.quoteColumnName(name) + "={:" + pn + "}");
        params[pn] = value;
      }
    }
    if (parts.length === 1) {
      return parts[0]!;
    }
    return parts.join(" AND ");
  }
}

// NotExp represents an expression that should prefix "NOT" to a specified expression.
export class NotExp implements Expression {
  constructor(private readonly e: Expression) {}

  build(db: DB, params: Params): string {
    const sql = this.e.build(db, params);
    if (sql !== "") {
      return "NOT (" + sql + ")";
    }
    return "";
  }
}

// AndOrExp represents an expression that concatenates multiple expressions using either "AND" or "OR".
export class AndOrExp implements Expression {
  constructor(
    private readonly exps: (Expression | null | undefined)[],
    private readonly op: string,
  ) {}

  build(db: DB, params: Params): string {
    if (this.exps.length === 0) {
      return "";
    }

    const parts: string[] = [];
    for (const a of this.exps) {
      if (a === null || a === undefined) {
        continue;
      }
      const sql = a.build(db, params);
      if (sql !== "") {
        parts.push(sql);
      }
    }
    if (parts.length === 1) {
      return parts[0]!;
    }
    // Go joins a nil slice to "" and wraps it, so no parts gives "()"
    return "(" + parts.join(") " + this.op + " (") + ")";
  }
}

// InExp represents an "IN" or "NOT IN" expression.
export class InExp implements Expression {
  constructor(
    private readonly col: string,
    private readonly values: unknown[],
    private readonly isNot: boolean,
  ) {}

  build(db: DB, params: Params): string {
    if (this.values.length === 0) {
      if (this.isNot) {
        return "";
      }
      return "0=1";
    }

    const values: string[] = [];
    for (const value of this.values) {
      if (value === null || value === undefined) {
        values.push("NULL");
      } else if (isExpression(value)) {
        values.push(value.build(db, params));
      } else {
        const name = `p${paramsLen(params)}`;
        params[name] = value;
        values.push("{:" + name + "}");
      }
    }
    const col = db.quoteColumnName(this.col);
    if (values.length === 1) {
      if (this.isNot) {
        return col + "<>" + values[0];
      }
      return col + "=" + values[0];
    }
    const op = this.isNot ? "NOT IN" : "IN";
    return `${col} ${op} (${values.join(", ")})`;
  }
}

// LikeExp represents a variant of LIKE expressions.
export class LikeExp implements Expression {
  private left = true;
  private right = true;
  private escapeChars: readonly string[] = defaultLikeEscape;

  constructor(
    private readonly col: string,
    private readonly values: string[],
    private readonly isOr: boolean,
    // Like stores the LIKE operator. It can be "LIKE", "NOT LIKE".
    // It may also be customized as something like "ILIKE".
    public likeOp: string,
  ) {}

  // Escape specifies how a LIKE expression should be escaped.
  // Each string at position 2i represents a special character and the string at position 2i+1 is
  // the corresponding escaped version.
  escape(...chars: string[]): this {
    this.escapeChars = chars;
    return this;
  }

  // Match specifies whether to do wildcard matching on the left and/or right of given strings.
  match(left: boolean, right: boolean): this {
    this.left = left;
    this.right = right;
    return this;
  }

  build(db: DB, params: Params): string {
    if (this.values.length === 0) {
      return "";
    }

    if (this.escapeChars.length % 2 !== 0) {
      throw new Error("LikeExp.Escape must be a slice of even number of strings");
    }

    const parts: string[] = [];
    const col = db.quoteColumnName(this.col);
    for (let value of this.values) {
      const name = `p${paramsLen(params)}`;
      for (let i = 0; i < this.escapeChars.length; i += 2) {
        value = value.replaceAll(this.escapeChars[i]!, this.escapeChars[i + 1]!);
      }
      if (this.left) {
        value = "%" + value;
      }
      if (this.right) {
        value += "%";
      }
      params[name] = value;
      parts.push(`${col} ${this.likeOp} {:${name}}`);
    }

    if (this.isOr) {
      return parts.join(" OR ");
    }
    return parts.join(" AND ");
  }
}

// ExistsExp represents an EXISTS or NOT EXISTS expression.
export class ExistsExp implements Expression {
  constructor(
    private readonly exp: Expression,
    private readonly isNot: boolean,
  ) {}

  build(db: DB, params: Params): string {
    const sql = this.exp.build(db, params);
    if (sql === "") {
      if (this.isNot) {
        return "";
      }
      return "0=1";
    }
    if (this.isNot) {
      return "NOT EXISTS (" + sql + ")";
    }
    return "EXISTS (" + sql + ")";
  }
}

// BetweenExp represents a BETWEEN or a NOT BETWEEN expression.
export class BetweenExp implements Expression {
  constructor(
    private readonly col: string,
    private readonly from: unknown,
    private readonly to: unknown,
    private readonly isNot: boolean,
  ) {}

  build(db: DB, params: Params): string {
    const op = this.isNot ? "NOT BETWEEN" : "BETWEEN";
    const len = paramsLen(params);
    const name1 = `p${len}`;
    const name2 = `p${len + 1}`;
    params[name1] = this.from;
    params[name2] = this.to;
    const col = db.quoteColumnName(this.col);
    return `${col} ${op} {:${name1}} AND {:${name2}}`;
  }
}

// EncloseExp represents a parenthesis enclosed expression.
export class EncloseExp implements Expression {
  constructor(private readonly exp: Expression) {}

  build(db: DB, params: Params): string {
    const str = this.exp.build(db, params);
    if (str === "") {
      return "";
    }
    return "(" + str + ")";
  }
}

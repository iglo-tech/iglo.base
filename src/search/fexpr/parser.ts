// Translated from fexpr v0.7.0 (ganigeorgiev.com/fexpr), whose license follows:
//
// BSD 3-Clause License
//
// Copyright (c) 2022-present, Gani Georgiev
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// 3. Neither the name of the copyright holder nor the names of its
//    contributors may be used to endorse or promote products derived from
//    this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

// Upstream: fexpr v0.7.0 parser.go

import {
  JoinAnd,
  JoinOr,
  type JoinOp,
  newScanner,
  type SignOp,
  type Token,
  TokenComment,
  TokenEOF,
  TokenFunction,
  TokenGroup,
  TokenIdentifier,
  TokenJoin,
  TokenNumber,
  TokenSign,
  TokenText,
  TokenWS,
} from "@/search/fexpr/scanner";
import { goQuote } from "@/fields/field";

export const ErrEmpty = new Error("empty filter expression");
export const ErrIncomplete = new Error("invalid or incomplete filter expression");
// (ErrInvalidComment, declared here upstream, is in scanner.ts, which returns it.)

// Expr represents an individual tokenized expression consisting
// of left operand, operator and a right operand.
export interface Expr {
  left: Token;
  op: SignOp;
  right: Token;
}

// IsZero checks if the current Expr has zero-valued props.
export function exprIsZero(e: Expr): boolean {
  return (
    e.op === "" &&
    e.left.literal === "" &&
    e.left.type === "" &&
    e.right.literal === "" &&
    e.right.type === ""
  );
}

// ExprGroup represents a wrapped expression and its join type.
//
// The group's Item could be either an `Expr` instance or `[]ExprGroup` slice (for nested expressions).
export interface ExprGroup {
  item: Expr | ExprGroup | ExprGroup[];
  join: JoinOp;
}

// parser's state machine steps
const stepBeforeSign = 0;
const stepSign = 1;
const stepAfterSign = 2;
const StepJoin = 3;

function zeroToken(): Token {
  return { meta: null, type: "", literal: "" };
}

// Parse parses the provided text and returns its processed AST
// in the form of `ExprGroup` slice(s).
//
// Comments and whitespaces are ignored.
export function parse(text: string): ExprGroup[] {
  const result: ExprGroup[] = [];
  const scanner = newScanner(text);
  let step = stepBeforeSign;
  let join: JoinOp = JoinAnd;

  let expr: Expr = { left: zeroToken(), op: "", right: zeroToken() };

  for (;;) {
    const [t, err] = scanner.scan();
    if (err !== undefined) {
      throw err;
    }

    if (t.type === TokenEOF) {
      break;
    }

    if (t.type === TokenWS || t.type === TokenComment) {
      continue;
    }

    if (t.type === TokenGroup) {
      const groupResult = parse(t.literal);

      // append only if non-empty group
      if (groupResult.length > 0) {
        result.push({ join, item: groupResult });
      }

      step = StepJoin;
      continue;
    }

    switch (step) {
      case stepBeforeSign:
        if (
          t.type !== TokenIdentifier &&
          t.type !== TokenText &&
          t.type !== TokenNumber &&
          t.type !== TokenFunction
        ) {
          throw new Error(
            `expected left operand (identifier, function, text or number), got ${goQuote(t.literal)} (${t.type})`,
          );
        }

        expr = { left: t, op: "", right: zeroToken() };

        step = stepSign;
        break;
      case stepSign:
        if (t.type !== TokenSign) {
          throw new Error(`expected a sign operator, got ${goQuote(t.literal)} (${t.type})`);
        }

        expr.op = t.literal;
        step = stepAfterSign;
        break;
      case stepAfterSign:
        if (
          t.type !== TokenIdentifier &&
          t.type !== TokenText &&
          t.type !== TokenNumber &&
          t.type !== TokenFunction
        ) {
          throw new Error(
            `expected right operand (identifier, function text or number), got ${goQuote(t.literal)} (${t.type})`,
          );
        }

        expr.right = t;
        result.push({ join, item: expr });

        step = StepJoin;
        break;
      case StepJoin:
        if (t.type !== TokenJoin) {
          throw new Error(`expected && or ||, got ${goQuote(t.literal)} (${t.type})`);
        }

        join = JoinAnd;
        if (t.literal === "||") {
          join = JoinOr;
        }

        step = stepBeforeSign;
        break;
    }
  }

  if (step !== StepJoin) {
    if (result.length === 0 && exprIsZero(expr)) {
      throw ErrEmpty;
    }

    throw ErrIncomplete;
  }

  return result;
}

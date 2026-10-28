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

// Upstream: fexpr v0.7.0 scanner.go
//
// The scanned data is a Go string in the form of src/tools/unicode/utf8.ts
// (an invalid UTF-8 byte is a lone surrogate), read rune by rune as Go's
// utf8.DecodeRune does: an invalid byte is U+FFFD of size 1. Positions are
// UTF-16 offsets into that string; they are internal only.

import { trimSpace } from "@/collections/go-strings";
import { goQuote } from "@/fields/field";
import { IsPrint } from "@/tools/unicode/letter";
import { DecodeRuneInString, goString, RuneError } from "@/tools/unicode/utf8";

// eof represents a marker rune for the end of the reader.
const eof = 0;

// JoinOp represents a join type operator.
export type JoinOp = "&&" | "||";

// supported join type operators
export const JoinAnd: JoinOp = "&&";
export const JoinOr: JoinOp = "||";

// SignOp represents an expression sign operator.
export type SignOp = string;

// supported expression sign operators
export const SignEq: SignOp = "=";
export const SignNeq: SignOp = "!=";
export const SignLike: SignOp = "~";
export const SignNlike: SignOp = "!~";
export const SignLt: SignOp = "<";
export const SignLte: SignOp = "<=";
export const SignGt: SignOp = ">";
export const SignGte: SignOp = ">=";

// array/any operators
export const SignAnyEq: SignOp = "?=";
export const SignAnyNeq: SignOp = "?!=";
export const SignAnyLike: SignOp = "?~";
export const SignAnyNlike: SignOp = "?!~";
export const SignAnyLt: SignOp = "?<";
export const SignAnyLte: SignOp = "?<=";
export const SignAnyGt: SignOp = "?>";
export const SignAnyGte: SignOp = "?>=";

// TokenType represents a Token type.
export type TokenType = string;

// token type constants
export const TokenUnexpected: TokenType = "unexpected";
export const TokenEOF: TokenType = "eof";
export const TokenWS: TokenType = "whitespace";
export const TokenJoin: TokenType = "join";
export const TokenSign: TokenType = "sign";
export const TokenIdentifier: TokenType = "identifier"; // variable, column name, placeholder, etc.
export const TokenFunction: TokenType = "function"; // function
export const TokenNumber: TokenType = "number";
export const TokenText: TokenType = "text"; // ' or " quoted string
export const TokenGroup: TokenType = "group"; // groupped/nested tokens
export const TokenComment: TokenType = "comment";

// Token represents a single scanned literal (one or more combined runes).
//
// meta is Go's `Meta interface{}`: the argument tokens of a function token
// (an empty array for Go's nil []Token), null (a nil interface) otherwise.
export interface Token {
  meta: Token[] | null;
  type: TokenType;
  literal: string;
}

// a Go error result; undefined is nil
export type ScanResult = [token: Token, err: Error | undefined];

// ErrInvalidComment is defined in parser.go upstream; it lives here so the
// scanner does not import the parser.
export const ErrInvalidComment = new Error("invalid comment");

function token(type: TokenType, literal: string, meta: Token[] | null = null): Token {
  return { meta, type, literal };
}

// NewScanner creates and returns a new scanner instance loaded with the specified data.
export function newScanner(data: string | Uint8Array): Scanner {
  return new Scanner(goString(data));
}

// Scanner represents a filter and lexical scanner.
export class Scanner {
  private pos = 0;
  private readonly maxFuncDepth = 3;
  private lastRuneSize = -1; // -1 means invalid

  constructor(private readonly data: string) {}

  // Scan reads and returns the next available token value from the scanner's buffer.
  scan(): ScanResult {
    const ch = this.read();

    if (ch === eof) {
      return [token(TokenEOF, ""), undefined];
    }

    if (isWhitespaceRune(ch)) {
      this.unreadOnce();
      return this.scanWhitespace();
    }

    if (isGroupStartRune(ch)) {
      this.unreadOnce();
      return this.scanGroup();
    }

    if (isIdentifierStartRune(ch)) {
      this.unreadOnce();
      return this.scanIdentifier(this.maxFuncDepth);
    }

    if (isNumberStartRune(ch)) {
      this.unreadOnce();
      return this.scanNumber();
    }

    if (isTextStartRune(ch)) {
      this.unreadOnce();
      return this.scanText(false);
    }

    if (isSignStartRune(ch)) {
      this.unreadOnce();
      return this.scanSign();
    }

    if (isJoinStartRune(ch)) {
      this.unreadOnce();
      return this.scanJoin();
    }

    if (isCommentStartRune(ch)) {
      this.unreadOnce();
      return this.scanComment();
    }

    return [
      token(TokenUnexpected, String.fromCodePoint(ch)),
      new Error(`unexpected character ${quoteRune(ch)}`),
    ];
  }

  // scanWhitespace consumes all contiguous whitespace runes.
  private scanWhitespace(): ScanResult {
    let buf = "";

    // Reads every subsequent whitespace character into the buffer.
    // Non-whitespace runes and EOF will cause the loop to exit.
    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      if (!isWhitespaceRune(ch)) {
        this.unreadOnce();
        break;
      }

      // write the whitespace rune
      buf += String.fromCodePoint(ch);
    }

    return [token(TokenWS, buf), undefined];
  }

  // scanNumber consumes all contiguous digit runes
  // (complex numbers and scientific notations are not supported).
  private scanNumber(): ScanResult {
    let buf = "";

    let hadDot = false;

    // Read every subsequent digit rune into the buffer.
    // Non-digit runes and EOF will cause the loop to exit.
    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      // not a digit rune
      if (
        !isDigitRune(ch) &&
        // minus sign but not at the beginning
        (ch !== 0x2d || buf.length !== 0) &&
        // dot but there was already another dot
        (ch !== 0x2e || hadDot)
      ) {
        this.unreadOnce();
        break;
      }

      // write the rune
      buf += String.fromCodePoint(ch);

      if (ch === 0x2e) {
        hadDot = true;
      }
    }

    const total = buf.length;
    const literal = buf;

    let err: Error | undefined;
    // only "-" or starts with "." or ends with "."
    if ((total === 1 && literal[0] === "-") || literal[0] === "." || literal[total - 1] === ".") {
      err = new Error(`invalid number ${goQuote(literal)}`);
    }

    return [token(TokenNumber, buf), err];
  }

  // scanText consumes all contiguous quoted text runes.
  private scanText(preserveQuotes: boolean): ScanResult {
    let buf = "";

    // read the first rune to determine the quotes type
    const firstCh = this.read();

    if (preserveQuotes) {
      buf += String.fromCodePoint(firstCh);
    }

    let escapeNext = false;
    let hasMatchingQuotes = false;

    // Read every subsequent text rune into the buffer.
    // EOF and matching unescaped ending quote will cause the loop to exit.
    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      if (escapeNext) {
        // reset escape state
        escapeNext = false;

        if (!preserveQuotes) {
          switch (ch) {
            case 0x6e: // 'n'
              buf += "\n";
              break;
            case 0x74: // 't'
              buf += "\t";
              break;
            case 0x72: // 'r'
              buf += "\r";
              break;
            case 0x5c: // '\\'
            case 0x27: // '\''
            case 0x22: // '"'
              buf += String.fromCodePoint(ch);
              break;
            default:
              // escape regular literal
              // (note: the backslash is added because we've skipped it in
              // the escape start check to avoid back-and-forth mutation of the slice)
              buf += "\\" + String.fromCodePoint(ch);
          }
        } else {
          buf += String.fromCodePoint(ch);
        }
      } else if (ch === 0x5c) {
        // escape next char
        escapeNext = true;
        if (preserveQuotes) {
          buf += "\\";
        }
      } else if (ch === firstCh) {
        // unescaped matching quote, aka. the end
        hasMatchingQuotes = true;
        if (preserveQuotes) {
          buf += String.fromCodePoint(ch);
        }

        break;
      } else {
        buf += String.fromCodePoint(ch);
      }
    }

    let literal = buf;

    let err: Error | undefined;
    if (!hasMatchingQuotes) {
      // concatenated the initially skipped quote to allow easier debugging
      if (!preserveQuotes) {
        literal = String.fromCodePoint(firstCh) + literal;
      }

      err = new Error(`invalid quoted text ${goQuote(literal)}`);
    }

    return [token(TokenText, literal), err];
  }

  // scanComment consumes all contiguous single line comment runes until
  // a new character (\n) or EOF is reached.
  private scanComment(): ScanResult {
    let buf = "";

    // Read the first 2 characters without writting them to the buffer.
    if (!isCommentStartRune(this.read()) || !isCommentStartRune(this.read())) {
      return [token(TokenComment, ""), ErrInvalidComment];
    }

    // Read every subsequent comment text rune into the buffer.
    // \n and EOF will cause the loop to exit.
    for (;;) {
      const ch = this.read();

      if (ch === eof || ch === 0x0a) {
        break;
      }

      buf += String.fromCodePoint(ch);
    }

    return [token(TokenComment, trimSpace(buf)), undefined];
  }

  // scanIdentifier consumes all contiguous ident runes.
  private scanIdentifier(funcDepth: number): ScanResult {
    // read the first rune in case it is a special start identifier character
    let buf = String.fromCodePoint(this.read());

    // Read every subsequent identifier rune into the buffer.
    // Non-ident runes and EOF will cause the loop to exit.
    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      // func
      if (ch === 0x28) {
        const funcName = buf;
        if (funcDepth <= 0) {
          return [
            token(TokenFunction, funcName),
            new Error(`max nested function arguments reached (max: ${this.maxFuncDepth})`),
          ];
        }
        if (!isValidIdentifier(funcName)) {
          return [
            token(TokenFunction, funcName),
            new Error(`invalid function name ${goQuote(funcName)}`),
          ];
        }
        this.unreadOnce();
        return this.scanFunctionArgs(funcName, funcDepth);
      }

      // not an identifier character
      if (!isLetterRune(ch) && !isDigitRune(ch) && !isIdentifierCombineRune(ch) && ch !== 0x5f) {
        this.unreadOnce();
        break;
      }

      // write the identifier rune
      buf += String.fromCodePoint(ch);
    }

    const literal = buf;

    let err: Error | undefined;
    if (!isValidIdentifier(literal)) {
      err = new Error(`invalid identifier ${goQuote(literal)}`);
    }

    return [token(TokenIdentifier, literal), err];
  }

  // scanSign consumes all contiguous sign operator runes.
  private scanSign(): ScanResult {
    let buf = "";

    // Read every subsequent sign rune into the buffer.
    // Non-sign runes and EOF will cause the loop to exit.
    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      if (!isSignStartRune(ch)) {
        this.unreadOnce();
        break;
      }

      // write the sign rune
      buf += String.fromCodePoint(ch);
    }

    const literal = buf;

    let err: Error | undefined;
    if (!isSignOperator(literal)) {
      err = new Error(`invalid sign operator ${goQuote(literal)}`);
    }

    return [token(TokenSign, literal), err];
  }

  // scanJoin consumes all contiguous join operator runes.
  private scanJoin(): ScanResult {
    let buf = "";

    // Read every subsequent join operator rune into the buffer.
    // Non-join runes and EOF will cause the loop to exit.
    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      if (!isJoinStartRune(ch)) {
        this.unreadOnce();
        break;
      }

      // write the join operator rune
      buf += String.fromCodePoint(ch);
    }

    const literal = buf;

    let err: Error | undefined;
    if (!isJoinOperator(literal)) {
      err = new Error(`invalid join operator ${goQuote(literal)}`);
    }

    return [token(TokenJoin, literal), err];
  }

  // scanGroup consumes all runes within a group/parenthesis.
  private scanGroup(): ScanResult {
    let buf = "";

    // read the first group bracket without writing it to the buffer
    const firstChar = this.read();
    let openGroups = 1;

    // Read every subsequent text rune into the buffer.
    // EOF and parenthesis end will cause the loop to exit.
    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      if (isGroupStartRune(ch)) {
        // nested group
        openGroups++;
        buf += String.fromCodePoint(ch);
      } else if (isTextStartRune(ch)) {
        this.unreadOnce();
        const [t, err] = this.scanText(true); // with quotes to preserve the exact text start/end runes
        if (err !== undefined) {
          // write the errored literal as it is
          buf += t.literal;
          return [token(TokenGroup, buf), err];
        }

        buf += t.literal;
      } else if (ch === 0x29) {
        openGroups--;

        if (openGroups <= 0) {
          // main group end
          break;
        } else {
          buf += String.fromCodePoint(ch);
        }
      } else {
        buf += String.fromCodePoint(ch);
      }
    }

    const literal = buf;

    let err: Error | undefined;
    if (!isGroupStartRune(firstChar) || openGroups > 0) {
      err = new Error(`invalid formatted group - missing ${openGroups} closing bracket(s)`);
    }

    return [token(TokenGroup, literal), err];
  }

  // scanFunctionArgs consumes all contiguous function call runes to
  // extract its arguments and returns a function token with the found
  // Token arguments loaded in Token.Meta.
  private scanFunctionArgs(funcName: string, funcDepth: number): ScanResult {
    const args: Token[] = [];

    let expectComma = false;
    let isComma = false;
    let isClosed = false;

    const start = this.read();
    if (start !== 0x28) {
      return [
        token(TokenFunction, funcName),
        new Error(`invalid or incomplete function call ${goQuote(funcName)}`),
      ];
    }

    const fn = (): Token => token(TokenFunction, funcName, args);

    // Read every subsequent rune until ')' or EOF has been reached.
    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      if (ch === 0x29) {
        isClosed = true;
        break;
      }

      // skip whitespaces
      if (isWhitespaceRune(ch)) {
        // (scanWhitespace never fails)
        this.scanWhitespace();
        continue;
      }

      // skip comments
      if (isCommentStartRune(ch)) {
        this.unreadOnce();
        const [, err] = this.scanComment();
        if (err !== undefined) {
          return [
            fn(),
            new Error(`failed to scan comment in function ${goQuote(funcName)}: ${err.message}`, {
              cause: err,
            }),
          ];
        }
        continue;
      }

      isComma = ch === 0x2c;

      if (expectComma && !isComma) {
        return [
          fn(),
          new Error(`expected comma after the last argument in function ${goQuote(funcName)}`),
        ];
      }

      if (!expectComma && isComma) {
        return [fn(), new Error(`unexpected comma in function ${goQuote(funcName)}`)];
      }

      expectComma = false; // reset

      if (isComma) {
        continue;
      }

      if (isIdentifierStartRune(ch)) {
        this.unreadOnce();
        const [t, err] = this.scanIdentifier(funcDepth - 1);
        if (err !== undefined) {
          return [
            fn(),
            new Error(
              `invalid identifier argument ${goQuote(t.literal)} in function ${goQuote(funcName)}: ${err.message}`,
              { cause: err },
            ),
          ];
        }
        args.push(t);
        expectComma = true;
      } else if (isNumberStartRune(ch)) {
        this.unreadOnce();
        const [t, err] = this.scanNumber();
        if (err !== undefined) {
          return [
            fn(),
            new Error(
              `invalid number argument ${goQuote(t.literal)} in function ${goQuote(funcName)}: ${err.message}`,
              { cause: err },
            ),
          ];
        }
        args.push(t);
        expectComma = true;
      } else if (isTextStartRune(ch)) {
        this.unreadOnce();
        const [t, err] = this.scanText(false);
        if (err !== undefined) {
          return [
            fn(),
            new Error(
              `invalid text argument ${goQuote(t.literal)} in function ${goQuote(funcName)}: ${err.message}`,
              { cause: err },
            ),
          ];
        }
        args.push(t);
        expectComma = true;
      } else {
        return [
          fn(),
          new Error(
            `unsupported argument character ${quoteRune(ch)} in function ${goQuote(funcName)}`,
          ),
        ];
      }
    }

    if (!isClosed) {
      return [
        fn(),
        new Error(`invalid or incomplete function ${goQuote(funcName)} (expected ')')`),
      ];
    }

    return [fn(), undefined];
  }

  // unread unreads the last character and revert the position exactly 1 step back.
  //
  // This method is no-op if called more than once without read.
  private unreadOnce(): void {
    if (this.lastRuneSize < 0 || this.pos < this.lastRuneSize) {
      return;
    }

    this.pos -= this.lastRuneSize;
    this.lastRuneSize = -1;
  }

  // read reads the next rune and moves the position forward.
  private read(): number {
    if (this.pos >= this.data.length) {
      this.lastRuneSize = -1;
      return eof;
    }

    const [ch, n] = DecodeRuneInString(this.data.slice(this.pos, this.pos + 2));
    this.lastRuneSize = n;
    this.pos += n;

    return ch;
  }
}

// Lexical helpers:
// -------------------------------------------------------------------

// isWhitespaceRune checks if a rune is a space, tab, or newline.
function isWhitespaceRune(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a;
}

// isLetterRune checks if a rune is a letter.
function isLetterRune(ch: number): boolean {
  return (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x41 && ch <= 0x5a);
}

// isDigitRune checks if a rune is a digit.
function isDigitRune(ch: number): boolean {
  return ch >= 0x30 && ch <= 0x39;
}

// isTextStartRune checks if a rune is a valid quoted text first character
// (aka. single or double quote).
function isTextStartRune(ch: number): boolean {
  return ch === 0x27 || ch === 0x22;
}

// isNumberStartRune checks if a rune is a valid number start character (aka. digit).
function isNumberStartRune(ch: number): boolean {
  return ch === 0x2d || isDigitRune(ch);
}

// isSignStartRune checks if a rune is a valid sign operator start character.
function isSignStartRune(ch: number): boolean {
  return (
    ch === 0x3d || // =
    ch === 0x3f || // ?
    ch === 0x21 || // !
    ch === 0x3e || // >
    ch === 0x3c || // <
    ch === 0x7e // ~
  );
}

// isJoinStartRune checks if a rune is a valid join type start character.
function isJoinStartRune(ch: number): boolean {
  return ch === 0x26 || ch === 0x7c;
}

// isGroupStartRune checks if a rune is a valid group/parenthesis start character.
function isGroupStartRune(ch: number): boolean {
  return ch === 0x28;
}

// isCommentStartRune checks if a rune is a valid comment start character.
function isCommentStartRune(ch: number): boolean {
  return ch === 0x2f;
}

// isIdentifierStartRune checks if a rune is valid identifier's first character.
function isIdentifierStartRune(ch: number): boolean {
  return isLetterRune(ch) || isIdentifierSpecialStartRune(ch);
}

// isIdentifierSpecialStartRune checks if a rune is valid identifier's first special character.
function isIdentifierSpecialStartRune(ch: number): boolean {
  return ch === 0x40 || ch === 0x5f || ch === 0x23; // @ _ #
}

// isIdentifierCombineRune checks if a rune is valid identifier's combine character.
function isIdentifierCombineRune(ch: number): boolean {
  return ch === 0x2e || ch === 0x3a; // . :
}

const signOperators: ReadonlySet<string> = new Set([
  SignEq,
  SignNeq,
  SignLt,
  SignLte,
  SignGt,
  SignGte,
  SignLike,
  SignNlike,
  SignAnyEq,
  SignAnyNeq,
  SignAnyLike,
  SignAnyNlike,
  SignAnyLt,
  SignAnyLte,
  SignAnyGt,
  SignAnyGte,
]);

// isSignOperator checks if a literal is a valid sign operator.
function isSignOperator(literal: string): boolean {
  return signOperators.has(literal);
}

// isJoinOperator checks if a literal is a valid join type operator.
function isJoinOperator(literal: string): boolean {
  return literal === JoinAnd || literal === JoinOr;
}

// isValidIdentifier validates the literal against common identifier requirements.
function isValidIdentifier(literal: string): boolean {
  const length = literal.length;

  // (identifier runes are ASCII, so the last and first UTF-16 units are
  // the last and first bytes)
  return (
    length > 0 &&
    // doesn't end with combine rune
    !isIdentifierCombineRune(literal.charCodeAt(length - 1)) &&
    // is not just a special start rune
    (length !== 1 || !isIdentifierSpecialStartRune(literal.charCodeAt(0)))
  );
}

// strconv.QuoteRune (fmt's %q for a rune): a single-quoted Go character
// literal; non-printable runes (unicode.IsPrint) are escaped.
function quoteRune(r: number): string {
  if (r > 0x10ffff || (r >= 0xd800 && r <= 0xdfff)) {
    r = RuneError;
  }
  switch (r) {
    case 0x27:
      return "'\\''";
    case 0x5c:
      return "'\\\\'";
  }
  if (IsPrint(r)) {
    return "'" + String.fromCodePoint(r) + "'";
  }
  switch (r) {
    case 0x07:
      return "'\\a'";
    case 0x08:
      return "'\\b'";
    case 0x0c:
      return "'\\f'";
    case 0x0a:
      return "'\\n'";
    case 0x0d:
      return "'\\r'";
    case 0x09:
      return "'\\t'";
    case 0x0b:
      return "'\\v'";
  }
  if (r < 0x20 || r === 0x7f) {
    return "'\\x" + r.toString(16).padStart(2, "0") + "'";
  }
  if (r < 0x10000) {
    return "'\\u" + r.toString(16).padStart(4, "0") + "'";
  }
  return "'\\U" + r.toString(16).padStart(8, "0") + "'";
}

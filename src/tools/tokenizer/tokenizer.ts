// Upstream: tools/tokenizer/tokenizer.go
//
// Package tokenizer implements a rudimentary tokens parser of a string
// while respecting quotes and parenthesis boundaries.
//
// Example
//
//	const tk = Tokenizer.fromString("a, b, (c, d)");
//	const result = tk.scanAll(); // ["a", "b", "(c, d)"]
//
// Go reads runes from a bufio.Reader; here the reader is the string. A NUL
// rune reads as Go's eof marker, as upstream's read() returns rune(0), and
// an invalid UTF-8 byte (a lone surrogate, see go-json's bytesToText) reads
// as U+FFFD, as Go's ReadRune does. Go's io.EOF is a null token from scan().

import { goQuote } from "@/fields/field";

// eof represents a marker rune for the end of the reader.
const eof = 0;

// DefaultSeparators is a list with the default token separator characters.
export const DefaultSeparators: readonly string[] = Object.freeze([","]);

const whitespaceChars = ["\t", "\n", "\v", "\f", "\r", " ", "\u0085", " "];

// Tokenizer defines a struct that parses a string into tokens while
// respecting quotes and parenthesis boundaries.
export class Tokenizer {
  private pos = 0;
  private lastSize = -1;

  private trimCutset = "";
  private separators: string[] = [];
  private keepSeparatorState = false;
  private keepEmptyTokensState = false;
  private ignoreParenthesisState = false;

  // New creates new Tokenizer from the provided string with
  // DefaultSeparators.
  constructor(private readonly r: string) {
    this.setSeparators(...DefaultSeparators);
  }

  // NewFromString creates new Tokenizer from the provided string.
  static fromString(str: string): Tokenizer {
    return new Tokenizer(str);
  }

  // Separators defines the provided separatos of the current Tokenizer.
  setSeparators(...separators: string[]): void {
    this.separators = separators;

    this.rebuildTrimCutset();
  }

  // KeepSeparator defines whether to keep the separator rune as part
  // of the token (default to false).
  keepSeparator(state: boolean): void {
    this.keepSeparatorState = state;
  }

  // KeepEmptyTokens defines whether to keep empty tokens on Scan() (default to false).
  keepEmptyTokens(state: boolean): void {
    this.keepEmptyTokensState = state;
  }

  // IgnoreParenthesis defines whether to ignore the parenthesis boundaries
  // and to treat the '(' and ')' as regular characters.
  ignoreParenthesis(state: boolean): void {
    this.ignoreParenthesisState = state;
  }

  // Scan reads and returns the next available token from the Tokenizer's buffer (trimmed!).
  //
  // Empty tokens are skipped if keepEmptyTokens is not set (which is the default).
  //
  // Returns null (Go's io.EOF) when there are no more tokens to scan and
  // throws on an unbalanced token.
  scan(): string | null {
    for (;;) {
      const ch = this.read();
      if (ch === eof) {
        return null;
      }
      this.unread();

      const token = this.readToken();

      if (!this.keepEmptyTokensState && token === "") {
        continue;
      }

      return token;
    }
  }

  // ScanAll reads the entire Tokenizer's buffer and return all found tokens.
  scanAll(): string[] {
    const tokens: string[] = [];

    for (;;) {
      const token = this.scan();
      if (token === null) {
        break;
      }

      tokens.push(token);
    }

    return tokens;
  }

  // readToken reads a single token from the buffer and returns it.
  private readToken(): string {
    let buf = "";
    let parenthesis = 0;
    let quoteCh = eof;
    let prevCh = eof;

    for (;;) {
      const ch = this.read();

      if (ch === eof) {
        break;
      }

      if (!this.isEscapeRune(prevCh)) {
        if (!this.ignoreParenthesisState && ch === 0x28 && quoteCh === eof) {
          parenthesis++; // opening parenthesis
        } else if (
          !this.ignoreParenthesisState &&
          ch === 0x29 &&
          parenthesis > 0 &&
          quoteCh === eof
        ) {
          parenthesis--; // closing parenthesis
        } else if (this.isQuoteRune(ch)) {
          switch (quoteCh) {
            case ch:
              quoteCh = eof; // closing quote
              break;
            case eof:
              quoteCh = ch; // opening quote
              break;
          }
        }
      }

      if (this.isSeperatorRune(ch) && parenthesis === 0 && quoteCh === eof) {
        if (this.keepSeparatorState) {
          buf += String.fromCodePoint(ch);
        }
        break;
      }

      prevCh = ch;
      buf += String.fromCodePoint(ch);
    }

    if (parenthesis > 0 || quoteCh !== eof) {
      throw new Error(`unbalanced parenthesis or quoted expression: ${goQuote(buf)}`);
    }

    return trim(buf, this.trimCutset);
  }

  // read reads the next rune from the string.
  // Returns the `rune(0)` at the end of the string.
  private read(): number {
    if (this.pos >= this.r.length) {
      this.lastSize = -1;
      return eof;
    }

    let ch = this.r.codePointAt(this.pos) as number;
    const size = ch > 0xffff ? 2 : 1;
    if (ch >= 0xd800 && ch <= 0xdfff) {
      ch = 0xfffd; // an invalid UTF-8 byte
    }
    this.pos += size;
    this.lastSize = size;

    return ch;
  }

  // unread places the previously read rune back on the reader.
  private unread(): void {
    if (this.lastSize > 0) {
      this.pos -= this.lastSize;
      this.lastSize = -1;
    }
  }

  // rebuildTrimCutset rebuilds the tokenizer trimCutset based on its separator runes.
  private rebuildTrimCutset(): void {
    let cutset = "";

    for (const w of whitespaceChars) {
      if (this.isSeperatorRune(w.codePointAt(0) as number)) {
        continue;
      }
      cutset += w;
    }

    this.trimCutset = cutset;
  }

  // isSeperatorRune checks if a rune is a token part separator.
  private isSeperatorRune(ch: number): boolean {
    for (const r of this.separators) {
      if (ch === r.codePointAt(0)) {
        return true;
      }
    }

    return false;
  }

  // isQuoteRune checks if a rune is a quote.
  private isQuoteRune(ch: number): boolean {
    return ch === 0x27 || ch === 0x22 || ch === 0x60;
  }

  // isEscapeRune checks if a rune is an escape character.
  private isEscapeRune(ch: number): boolean {
    return ch === 0x5c;
  }
}

// strings.Trim: s without the leading and trailing runes in cutset
function trim(s: string, cutset: string): string {
  const set = new Set(cutset);
  const chars = [...s];
  let start = 0;
  let end = chars.length;
  while (start < end && set.has(chars[start] as string)) {
    start++;
  }
  while (end > start && set.has(chars[end - 1] as string)) {
    end--;
  }
  return chars.slice(start, end).join("");
}

// Upstream: golang.org/x/net v0.61.0 html/token.go
//
// The tokenizer works on the complete input as a Uint8Array, the way the Go
// tokenizer works on its buffer. Spans are absolute offsets into that buffer,
// so the Go buffer-compaction bookkeeping in readByte has no equivalent here.
// Buffered() is not ported: it depends on how an io.Reader chunks its input.
// SetMaxBuf's byte limit is kept.

import { toLower } from "@/collections/go-strings";
import { lookup } from "@/tools/html/atom";
import {
  decodeUTF8,
  encodeUTF8,
  escape,
  escapeCommentString,
  lower,
  unescape,
} from "@/tools/html/escape";

// A TokenType is the type of a Token.
export type TokenType = number;

// ErrorToken means that an error occurred during tokenization.
export const ErrorToken = 0;
// TextToken means a text node.
export const TextToken = 1;
// A StartTagToken looks like <a>.
export const StartTagToken = 2;
// An EndTagToken looks like </a>.
export const EndTagToken = 3;
// A SelfClosingTagToken tag looks like <br/>.
export const SelfClosingTagToken = 4;
// A CommentToken looks like <!--x-->.
export const CommentToken = 5;
// A DoctypeToken looks like <!DOCTYPE x>
export const DoctypeToken = 6;

// EOF is io.EOF: the error reported once the input is exhausted.
export const EOF = new Error("EOF");

// ErrBufferExceeded means that the buffering limit was exceeded.
export const ErrBufferExceeded = new Error("max buffer exceeded");

// tokenTypeString returns a string representation of the TokenType.
export function tokenTypeString(t: TokenType): string {
  switch (t) {
    case ErrorToken:
      return "Error";
    case TextToken:
      return "Text";
    case StartTagToken:
      return "StartTag";
    case EndTagToken:
      return "EndTag";
    case SelfClosingTagToken:
      return "SelfClosingTag";
    case CommentToken:
      return "Comment";
    case DoctypeToken:
      return "Doctype";
  }
  return "Invalid(" + t + ")";
}

// An Attribute is an attribute namespace-key-value triple. Namespace is
// non-empty for foreign attributes like xlink, Key is alphabetic (and hence
// does not contain escapable characters like '&', '<' or '>'), and Val is
// unescaped (it looks like "a<b" rather than "a&lt;b").
//
// Namespace is only used by the parser, not the tokenizer.
export interface Attribute {
  namespace: string;
  key: string;
  val: string;
}

// A Token consists of a TokenType and some Data (tag name for start and end
// tags, content for text, comments and doctypes). A tag Token may also contain
// a slice of Attributes. Data is unescaped for all Tokens (it looks like "a<b"
// rather than "a&lt;b"). For tag Tokens, dataAtom is the atom for data, or ""
// if data is not a known tag name.
export interface Token {
  type: TokenType;
  dataAtom: string;
  data: string;
  attr: Attribute[];
}

// tagString returns a string representation of a tag Token's Data and Attr.
function tagString(t: Token): string {
  if (t.attr.length === 0) {
    return t.data;
  }
  let s = t.data;
  for (const a of t.attr) {
    s += " " + a.key + '="' + escape(a.val) + '"';
  }
  return s;
}

// tokenString returns a string representation of the Token.
export function tokenString(t: Token): string {
  switch (t.type) {
    case ErrorToken:
      return "";
    case TextToken:
      return escape(t.data);
    case StartTagToken:
      return "<" + tagString(t) + ">";
    case EndTagToken:
      return "</" + tagString(t) + ">";
    case SelfClosingTagToken:
      return "<" + tagString(t) + "/>";
    case CommentToken:
      return "<!--" + escapeCommentString(t.data) + "-->";
    case DoctypeToken:
      return "<!DOCTYPE " + escape(t.data) + ">";
  }
  return "Invalid(" + t.type + ")";
}

// span is a range of bytes in a Tokenizer's buffer. The start is inclusive,
// the end is exclusive.
interface span {
  start: number;
  end: number;
}

function newSpan(): span {
  return { start: 0, end: 0 };
}

// A Tokenizer returns a stream of HTML Tokens.
export class Tokenizer {
  // tt is the TokenType of the current token.
  private tt: TokenType = ErrorToken;
  // lastErr is the first error encountered during tokenization. It is possible
  // for tt != Error && lastErr != null to hold: this means that next returned a
  // valid token but the subsequent next call will return an error token.
  // For example, if the HTML text input was just "plain", then the first
  // next call would set lastErr to EOF but return a TextToken, and all
  // subsequent next calls would return an ErrorToken.
  // lastErr is never reset. Once it becomes non-null, it stays non-null.
  private lastErr: Error | null = null;
  // raw.start:raw.end holds the raw bytes of the current token.
  // raw.end:... is buffered input that will yield future tokens.
  private raw: span = newSpan();
  private buf: Uint8Array;
  // maxBuf limits the data buffered for the current token. A value of 0 means unlimited.
  private maxBuf = 0;
  // buf[data.start:data.end] holds the raw bytes of the current token's data:
  // a text token's text, a tag token's tag name, etc.
  private data: span = newSpan();
  // pendingAttr is the attribute key and value currently being tokenized.
  // When complete, pendingAttr is pushed onto attr. nAttrReturned is
  // incremented on each call to tagAttr.
  private pendingAttr: [span, span] = [newSpan(), newSpan()];
  private attr: [span, span][] = [];
  private attrNames = new Set<string>();
  private nAttrReturned = 0;
  // rawTag is the "script" in "</script>" that closes the next token. If
  // non-empty, the subsequent call to next will return a raw or RCDATA text
  // token: one that treats "<p>" as text instead of an element.
  // rawTag's contents are lower-cased.
  private rawTag = "";
  // textIsRaw is whether the current text token's data is not escaped.
  private textIsRaw = false;
  // convertNUL is whether NUL bytes in the current token's data should
  // be converted into � replacement characters.
  private convertNUL = false;
  // cdataAllowed is whether CDATA sections are allowed in the current context.
  private cdataAllowed = false;

  // The input is assumed to be UTF-8 encoded. contextTag is the tag of an
  // existing element whose InnerHTML is being tokenized, or "".
  constructor(input: Uint8Array, contextTag = "") {
    this.buf = input;
    if (contextTag !== "") {
      // Per the "Parsing HTML Fragments" portion of the spec:
      //    For performance reasons, an implementation that does not report errors
      //    and that uses the actual state machine described in this specification
      //    directly could use the PLAINTEXT state instead of the RAWTEXT and script
      //    data states where those are mentioned in the list above. Except for
      //    rules regarding parse errors, they are equivalent, since there is no
      //    appropriate end tag token in the fragment case, yet they involve far
      //    fewer state transitions.
      //
      // As such we just set everything to plaintext, which makes some complex parsing
      // cases somewhat simpler.
      const s = toLower(contextTag);
      switch (s) {
        case "title":
        case "textarea":
          this.rawTag = s;
          break;
        case "style":
        case "xmp":
        case "iframe":
        case "noembed":
        case "noframes":
        case "script":
        case "noscript":
        case "plaintext":
          this.rawTag = "plaintext";
          break;
      }
    }
  }

  // setAllowCDATA sets whether or not the tokenizer recognizes <![CDATA[foo]]> as
  // the text "foo". The default value is false, which means to recognize it as
  // a bogus comment "<!-- [CDATA[foo]] -->" instead.
  //
  // Strictly speaking, an HTML5 compliant tokenizer should allow CDATA if and
  // only if tokenizing foreign content, such as MathML and SVG. However,
  // tracking foreign-contentness is difficult to do purely in the tokenizer,
  // as opposed to the parser, due to HTML integration points: an <svg> element
  // can contain a <foreignObject> that is foreign-to-SVG but not foreign-to-
  // HTML. For strict compliance with the HTML5 tokenization algorithm, it is the
  // responsibility of the user of a tokenizer to call setAllowCDATA as appropriate.
  setAllowCDATA(allowCDATA: boolean): void {
    this.cdataAllowed = allowCDATA;
  }

  // nextIsNotRawText instructs the tokenizer that the next token should not be
  // considered as 'raw text'. Some elements, such as script and title elements,
  // normally require the next token after the opening tag to be 'raw text' that
  // has no child elements. For example, tokenizing "<title>a<b>c</b>d</title>"
  // yields a start tag token for "<title>", a text token for "a<b>c</b>d", and
  // an end tag token for "</title>". There are no distinct start tag or end tag
  // tokens for the "<b>" and "</b>".
  //
  // This tokenizer implementation will generally look for raw text at the right
  // times. For strict compliance with the HTML5 tokenization algorithm, it is the
  // responsibility of the user of a tokenizer to call nextIsNotRawText as
  // appropriate.
  nextIsNotRawText(): void {
    this.rawTag = "";
  }

  // error returns the error associated with the most recent ErrorToken token.
  // This is typically EOF, meaning the end of tokenization.
  error(): Error | null {
    if (this.tt !== ErrorToken) {
      return null;
    }
    return this.lastErr;
  }

  // setMaxBuf sets a limit on the amount of data buffered during tokenization.
  // A value of 0 means unlimited.
  setMaxBuf(n: number): void {
    this.maxBuf = n;
  }

  // readByte returns the next byte from the input stream, or 0 and sets
  // lastErr when the input is exhausted or the buffering limit is exceeded.
  // Pre-condition: lastErr == null.
  private readByte(): number {
    if (this.raw.end >= this.buf.length) {
      // The whole input is in memory, so reaching its end is io.EOF.
      this.lastErr = EOF;
      return 0;
    }
    const x = this.buf[this.raw.end]!;
    this.raw.end++;
    if (this.maxBuf > 0 && this.raw.end - this.raw.start >= this.maxBuf) {
      this.lastErr = ErrBufferExceeded;
      return 0;
    }
    return x;
  }

  // skipWhiteSpace skips past any white space.
  private skipWhiteSpace(): void {
    if (this.lastErr !== null) {
      return;
    }
    for (;;) {
      const c = this.readByte();
      if (this.lastErr !== null) {
        return;
      }
      switch (c) {
        case 0x20: // ' '
        case 0x0a: // '\n'
        case 0x0d: // '\r'
        case 0x09: // '\t'
        case 0x0c: // '\f'
          // No-op.
          break;
        default:
          this.raw.end--;
          return;
      }
    }
  }

  // readRawOrRCDATA reads until the next "</foo>", where "foo" is this.rawTag and
  // is typically something like "script" or "textarea".
  private readRawOrRCDATA(): void {
    if (this.rawTag === "script") {
      this.readScript();
      this.textIsRaw = true;
      this.rawTag = "";
      return;
    }
    loop: for (;;) {
      let c = this.readByte();
      if (this.lastErr !== null) {
        break loop;
      }
      if (c !== 0x3c /* < */) {
        continue loop;
      }
      c = this.readByte();
      if (this.lastErr !== null) {
        break loop;
      }
      if (c !== 0x2f /* / */) {
        this.raw.end--;
        continue loop;
      }
      if (this.readRawEndTag() || this.lastErr !== null) {
        break loop;
      }
    }
    this.data.end = this.raw.end;
    // A textarea's or title's RCDATA can contain escaped entities.
    this.textIsRaw = this.rawTag !== "textarea" && this.rawTag !== "title";
    this.rawTag = "";
  }

  // readRawEndTag attempts to read a tag like "</foo>", where "foo" is this.rawTag.
  // If it succeeds, it backs up the input position to reconsume the tag and
  // returns true. Otherwise it returns false. The opening "</" has already been
  // consumed.
  private readRawEndTag(): boolean {
    for (let i = 0; i < this.rawTag.length; i++) {
      const c = this.readByte();
      if (this.lastErr !== null) {
        return false;
      }
      const want = this.rawTag.charCodeAt(i);
      if (c !== want && c !== want - ("a".charCodeAt(0) - "A".charCodeAt(0))) {
        this.raw.end--;
        return false;
      }
    }
    const c = this.readByte();
    if (this.lastErr !== null) {
      return false;
    }
    switch (c) {
      case 0x20: // ' '
      case 0x0a: // '\n'
      case 0x0d: // '\r'
      case 0x09: // '\t'
      case 0x0c: // '\f'
      case 0x2f: // '/'
      case 0x3e: // '>'
        // The 3 is 2 for the leading "</" plus 1 for the trailing character c.
        this.raw.end -= 3 + this.rawTag.length;
        return true;
    }
    this.raw.end--;
    return false;
  }

  // readScript reads until the next </script> tag, following the byzantine
  // rules for escaping/hiding the closing tag.
  //
  // Go's gotos are the transitions of a state machine: each label is a state,
  // and "goto L" is `state = L; continue`.
  private readScript(): void {
    try {
      let c = 0;
      let state = "scriptData";

      loop: for (;;) {
        switch (state) {
          case "scriptData":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            if (c === 0x3c /* < */) {
              state = "scriptDataLessThanSign";
              continue loop;
            }
            state = "scriptData";
            continue loop;

          case "scriptDataLessThanSign":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            switch (c) {
              case 0x2f: // '/'
                state = "scriptDataEndTagOpen";
                continue loop;
              case 0x21: // '!'
                state = "scriptDataEscapeStart";
                continue loop;
            }
            this.raw.end--;
            state = "scriptData";
            continue loop;

          case "scriptDataEndTagOpen":
            if (this.readRawEndTag() || this.lastErr !== null) {
              return;
            }
            state = "scriptData";
            continue loop;

          case "scriptDataEscapeStart":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            if (c === 0x2d /* - */) {
              state = "scriptDataEscapeStartDash";
              continue loop;
            }
            this.raw.end--;
            state = "scriptData";
            continue loop;

          case "scriptDataEscapeStartDash":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            if (c === 0x2d /* - */) {
              state = "scriptDataEscapedDashDash";
              continue loop;
            }
            this.raw.end--;
            state = "scriptData";
            continue loop;

          case "scriptDataEscaped":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            switch (c) {
              case 0x2d: // '-'
                state = "scriptDataEscapedDash";
                continue loop;
              case 0x3c: // '<'
                state = "scriptDataEscapedLessThanSign";
                continue loop;
            }
            state = "scriptDataEscaped";
            continue loop;

          case "scriptDataEscapedDash":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            switch (c) {
              case 0x2d: // '-'
                state = "scriptDataEscapedDashDash";
                continue loop;
              case 0x3c: // '<'
                state = "scriptDataEscapedLessThanSign";
                continue loop;
            }
            state = "scriptDataEscaped";
            continue loop;

          case "scriptDataEscapedDashDash":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            switch (c) {
              case 0x2d: // '-'
                state = "scriptDataEscapedDashDash";
                continue loop;
              case 0x3c: // '<'
                state = "scriptDataEscapedLessThanSign";
                continue loop;
              case 0x3e: // '>'
                state = "scriptData";
                continue loop;
            }
            state = "scriptDataEscaped";
            continue loop;

          case "scriptDataEscapedLessThanSign":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            if (c === 0x2f /* / */) {
              state = "scriptDataEscapedEndTagOpen";
              continue loop;
            }
            if ((0x61 <= c && c <= 0x7a) || (0x41 <= c && c <= 0x5a)) {
              state = "scriptDataDoubleEscapeStart";
              continue loop;
            }
            this.raw.end--;
            state = "scriptData";
            continue loop;

          case "scriptDataEscapedEndTagOpen":
            if (this.readRawEndTag() || this.lastErr !== null) {
              return;
            }
            state = "scriptDataEscaped";
            continue loop;

          case "scriptDataDoubleEscapeStart":
            this.raw.end--;
            for (let i = 0; i < "script".length; i++) {
              c = this.readByte();
              if (this.lastErr !== null) {
                return;
              }
              if (c !== "script".charCodeAt(i) && c !== "SCRIPT".charCodeAt(i)) {
                this.raw.end--;
                state = "scriptDataEscaped";
                continue loop;
              }
            }
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            switch (c) {
              case 0x20: // ' '
              case 0x0a: // '\n'
              case 0x0d: // '\r'
              case 0x09: // '\t'
              case 0x0c: // '\f'
              case 0x2f: // '/'
              case 0x3e: // '>'
                state = "scriptDataDoubleEscaped";
                continue loop;
            }
            this.raw.end--;
            state = "scriptDataEscaped";
            continue loop;

          case "scriptDataDoubleEscaped":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            switch (c) {
              case 0x2d: // '-'
                state = "scriptDataDoubleEscapedDash";
                continue loop;
              case 0x3c: // '<'
                state = "scriptDataDoubleEscapedLessThanSign";
                continue loop;
            }
            state = "scriptDataDoubleEscaped";
            continue loop;

          case "scriptDataDoubleEscapedDash":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            switch (c) {
              case 0x2d: // '-'
                state = "scriptDataDoubleEscapedDashDash";
                continue loop;
              case 0x3c: // '<'
                state = "scriptDataDoubleEscapedLessThanSign";
                continue loop;
            }
            state = "scriptDataDoubleEscaped";
            continue loop;

          case "scriptDataDoubleEscapedDashDash":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            switch (c) {
              case 0x2d: // '-'
                state = "scriptDataDoubleEscapedDashDash";
                continue loop;
              case 0x3c: // '<'
                state = "scriptDataDoubleEscapedLessThanSign";
                continue loop;
              case 0x3e: // '>'
                state = "scriptData";
                continue loop;
            }
            state = "scriptDataDoubleEscaped";
            continue loop;

          case "scriptDataDoubleEscapedLessThanSign":
            c = this.readByte();
            if (this.lastErr !== null) {
              return;
            }
            if (c === 0x2f /* / */) {
              state = "scriptDataDoubleEscapeEnd";
              continue loop;
            }
            this.raw.end--;
            state = "scriptDataDoubleEscaped";
            continue loop;

          case "scriptDataDoubleEscapeEnd":
            if (this.readRawEndTag()) {
              this.raw.end += "</script>".length;
              state = "scriptDataEscaped";
              continue loop;
            }
            if (this.lastErr !== null) {
              return;
            }
            state = "scriptDataDoubleEscaped";
            continue loop;
        }
      }
    } finally {
      this.data.end = this.raw.end;
    }
  }

  // readComment reads the next comment token starting with "<!--". The opening
  // "<!--" has already been consumed.
  private readComment(): void {
    // When modifying this function, consider manually increasing the
    // maxSuffixLen constant in func TestComments, from 6 to e.g. 9 or more.
    // That increase should only be temporary, not committed, as it
    // exponentially affects the test running time.

    this.data.start = this.raw.end;
    try {
      let dashCount = 0;
      let beginning = true;
      for (;;) {
        let c = this.readByte();
        if (this.lastErr !== null) {
          this.data.end = this.calculateAbruptCommentDataEnd();
          return;
        }
        switch (c) {
          case 0x2d: // '-'
            dashCount++;
            continue;
          case 0x3e: // '>'
            if (dashCount >= 2 || beginning) {
              this.data.end = this.raw.end - "-->".length;
              return;
            }
            break;
          case 0x21: // '!'
            if (dashCount >= 2) {
              c = this.readByte();
              if (this.lastErr !== null) {
                this.data.end = this.calculateAbruptCommentDataEnd();
                return;
              } else if (c === 0x3e) {
                this.data.end = this.raw.end - "--!>".length;
                return;
              } else if (c === 0x2d) {
                dashCount = 1;
                beginning = false;
                continue;
              }
            }
            break;
        }
        dashCount = 0;
        beginning = false;
      }
    } finally {
      if (this.data.end < this.data.start) {
        // It's a comment with no data, like <!-->.
        this.data.end = this.data.start;
      }
    }
  }

  private calculateAbruptCommentDataEnd(): number {
    let raw = this.rawBytes();
    const prefixLen = "<!--".length;
    if (raw.length >= prefixLen) {
      raw = raw.subarray(prefixLen);
      if (hasSuffix(raw, "--!")) {
        return this.raw.end - 3;
      } else if (hasSuffix(raw, "--")) {
        return this.raw.end - 2;
      } else if (hasSuffix(raw, "-")) {
        return this.raw.end - 1;
      }
    }
    return this.raw.end;
  }

  // readUntilCloseAngle reads until the next ">".
  private readUntilCloseAngle(): void {
    this.data.start = this.raw.end;
    for (;;) {
      const c = this.readByte();
      if (this.lastErr !== null) {
        this.data.end = this.raw.end;
        return;
      }
      if (c === 0x3e /* > */) {
        this.data.end = this.raw.end - ">".length;
        return;
      }
    }
  }

  // readMarkupDeclaration reads the next token starting with "<!". It might be
  // a "<!--comment-->", a "<!DOCTYPE foo>", a "<![CDATA[section]]>" or
  // "<!a bogus comment". The opening "<!" has already been consumed.
  private readMarkupDeclaration(): TokenType {
    this.data.start = this.raw.end;
    const c = [0, 0];
    for (let i = 0; i < 2; i++) {
      c[i] = this.readByte();
      if (this.lastErr !== null) {
        // bogus comment
        this.data.end = this.raw.end;
        if (i === 1 && c[0] === 0x3e /* > */) {
          this.data.end--;
        }
        return CommentToken;
      }
    }
    if (c[0] === 0x2d && c[1] === 0x2d) {
      this.readComment();
      return CommentToken;
    }
    this.raw.end -= 2;
    if (this.readDoctype()) {
      return DoctypeToken;
    }
    if (this.cdataAllowed && this.readCDATA()) {
      this.convertNUL = true;
      return TextToken;
    }
    // It's a bogus comment.
    this.readUntilCloseAngle();
    return CommentToken;
  }

  // readDoctype attempts to read a doctype declaration and returns true if
  // successful. The opening "<!" has already been consumed.
  private readDoctype(): boolean {
    const s = "DOCTYPE";
    for (let i = 0; i < s.length; i++) {
      const c = this.readByte();
      if (this.lastErr !== null) {
        if (this.lastErr === EOF) {
          // Back up to read the fragment of "DOCTYPE" again, reset
          // lastErr to signal EOF on the next call
          this.raw.end = this.data.start;
          this.lastErr = null;
          return false;
        }
        this.data.end = this.raw.end;
        return false;
      }
      if (
        c !== s.charCodeAt(i) &&
        c !== s.charCodeAt(i) + ("a".charCodeAt(0) - "A".charCodeAt(0))
      ) {
        // Back up to read the fragment of "DOCTYPE" again.
        this.raw.end = this.data.start;
        return false;
      }
    }
    this.skipWhiteSpace();
    if (this.lastErr !== null) {
      this.data.start = this.raw.end;
      this.data.end = this.raw.end;
      return true;
    }
    this.readUntilCloseAngle();
    return true;
  }

  // readCDATA attempts to read a CDATA section and returns true if
  // successful. The opening "<!" has already been consumed.
  private readCDATA(): boolean {
    const s = "[CDATA[";
    for (let i = 0; i < s.length; i++) {
      const c = this.readByte();
      if (this.lastErr !== null) {
        if (this.lastErr === EOF) {
          // Back up to read the fragment of "[CDATA[" again, reset
          // lastErr to signal EOF on the next call
          this.raw.end = this.data.start;
          this.lastErr = null;
          return false;
        }
        this.data.end = this.raw.end;
        return false;
      }
      if (c !== s.charCodeAt(i)) {
        // Back up to read the fragment of "[CDATA[" again.
        this.raw.end = this.data.start;
        return false;
      }
    }
    this.data.start = this.raw.end;
    let brackets = 0;
    for (;;) {
      const c = this.readByte();
      if (this.lastErr !== null) {
        this.data.end = this.raw.end;
        return true;
      }
      switch (c) {
        case 0x5d: // ']'
          brackets++;
          break;
        case 0x3e: // '>'
          if (brackets >= 2) {
            this.data.end = this.raw.end - "]]>".length;
            return true;
          }
          brackets = 0;
          break;
        default:
          brackets = 0;
      }
    }
  }

  // startTagIn returns whether the start tag in buf[data.start:data.end]
  // case-insensitively matches any element of ss.
  private startTagIn(...ss: string[]): boolean {
    loop: for (const s of ss) {
      if (this.data.end - this.data.start !== s.length) {
        continue loop;
      }
      for (let i = 0; i < s.length; i++) {
        let c = this.buf[this.data.start + i]!;
        if (0x41 <= c && c <= 0x5a) {
          c += 0x20;
        }
        if (c !== s.charCodeAt(i)) {
          continue loop;
        }
      }
      return true;
    }
    return false;
  }

  // readStartTag reads the next start tag token. The opening "<a" has already
  // been consumed, where 'a' means anything in [A-Za-z].
  private readStartTag(): TokenType {
    this.readTag(true);
    if (this.lastErr !== null) {
      return ErrorToken;
    }
    // Several tags flag the tokenizer's next token as raw.
    let c = this.buf[this.data.start]!;
    let raw = false;
    if (0x41 <= c && c <= 0x5a) {
      c += 0x20;
    }
    switch (c) {
      case 0x69: // 'i'
        raw = this.startTagIn("iframe");
        break;
      case 0x6e: // 'n'
        raw = this.startTagIn("noembed", "noframes", "noscript");
        break;
      case 0x70: // 'p'
        raw = this.startTagIn("plaintext");
        break;
      case 0x73: // 's'
        raw = this.startTagIn("script", "style");
        break;
      case 0x74: // 't'
        raw = this.startTagIn("textarea", "title");
        break;
      case 0x78: // 'x'
        raw = this.startTagIn("xmp");
        break;
    }
    if (raw) {
      this.rawTag = toLower(decodeUTF8(this.buf.subarray(this.data.start, this.data.end)));
    }
    // Look for a self-closing token (e.g. <br/>).
    //
    // Originally, we did this by just checking that the last character of the
    // tag (ignoring the closing bracket) was a solidus (/) character, but this
    // is not always accurate.
    //
    // We need to be careful that we don't misinterpret a non-self-closing tag
    // as self-closing, as can happen if the tag contains unquoted attribute
    // values (i.e. <p a=/>).
    //
    // To avoid this, we check that the last non-bracket character of the tag
    // (raw.end-2) isn't the same character as the last non-quote character of
    // the last attribute of the tag (pendingAttr[1].end-1), if the tag has
    // attributes.
    const nAttrs = this.attr.length;
    if (
      this.lastErr === null &&
      this.buf[this.raw.end - 2] === 0x2f /* / */ &&
      (nAttrs === 0 || this.raw.end - 2 !== this.attr[nAttrs - 1]![1].end - 1)
    ) {
      return SelfClosingTagToken;
    }
    return StartTagToken;
  }

  // readTag reads the next tag token and its attributes. If saveAttr, those
  // attributes are saved in attr, otherwise attr is set to an empty slice.
  // The opening "<a" or "</a" has already been consumed, where 'a' means anything
  // in [A-Za-z].
  private readTag(saveAttr: boolean): void {
    this.attr = [];
    this.nAttrReturned = 0;
    this.attrNames.clear();
    // Read the tag name and attribute key/value pairs.
    this.readTagName();
    this.skipWhiteSpace();
    if (this.lastErr !== null) {
      return;
    }
    for (;;) {
      const c = this.readByte();
      if (this.lastErr !== null || c === 0x3e /* > */) {
        break;
      }
      this.raw.end--;
      this.readTagAttrKey();
      this.readTagAttrVal();
      // Save pendingAttr if saveAttr and that attribute has a non-empty key, and the key hasn't been seen before.
      const key = decodeUTF8(
        lower(this.buf.slice(this.pendingAttr[0].start, this.pendingAttr[0].end)),
      );
      if (
        saveAttr &&
        this.pendingAttr[0].start !== this.pendingAttr[0].end &&
        !this.attrNames.has(key)
      ) {
        this.attr.push([{ ...this.pendingAttr[0] }, { ...this.pendingAttr[1] }]);
        this.attrNames.add(key);
      }
      this.skipWhiteSpace();
      if (this.lastErr !== null) {
        break;
      }
    }
  }

  // readTagName sets data to the "div" in "<div k=v>". The reader (raw.end)
  // is positioned such that the first byte of the tag name (the "d" in "<div")
  // has already been consumed.
  private readTagName(): void {
    this.data.start = this.raw.end - 1;
    for (;;) {
      const c = this.readByte();
      if (this.lastErr !== null) {
        this.data.end = this.raw.end;
        return;
      }
      switch (c) {
        case 0x20: // ' '
        case 0x0a: // '\n'
        case 0x0d: // '\r'
        case 0x09: // '\t'
        case 0x0c: // '\f'
          this.data.end = this.raw.end - 1;
          return;
        case 0x2f: // '/'
        case 0x3e: // '>'
          this.raw.end--;
          this.data.end = this.raw.end;
          return;
      }
    }
  }

  // readTagAttrKey sets pendingAttr[0] to the "k" in "<div k=v>".
  // Precondition: lastErr == null.
  private readTagAttrKey(): void {
    this.pendingAttr[0].start = this.raw.end;
    for (;;) {
      const c = this.readByte();
      if (this.lastErr !== null) {
        this.pendingAttr[0].end = this.raw.end;
        return;
      }
      if (c === 0x3d /* = */ && this.pendingAttr[0].start + 1 === this.raw.end) {
        // WHATWG 13.2.5.32, if we see an equals sign before the attribute name
        // begins, we treat it as a character in the attribute name and continue.
        continue;
      }
      switch (c) {
        case 0x3d: // '='
        case 0x20: // ' '
        case 0x0a: // '\n'
        case 0x0d: // '\r'
        case 0x09: // '\t'
        case 0x0c: // '\f'
        case 0x2f: // '/'
        case 0x3e: // '>'
          // WHATWG 13.2.5.33 Attribute name state
          // We need to reconsume the char in the after attribute name state to support the / character
          this.raw.end--;
          this.pendingAttr[0].end = this.raw.end;
          return;
      }
    }
  }

  // readTagAttrVal sets pendingAttr[1] to the "v" in "<div k=v>".
  private readTagAttrVal(): void {
    this.pendingAttr[1].start = this.raw.end;
    this.pendingAttr[1].end = this.raw.end;
    this.skipWhiteSpace();
    if (this.lastErr !== null) {
      return;
    }
    let c = this.readByte();
    if (this.lastErr !== null) {
      return;
    }
    if (c === 0x2f /* / */) {
      // WHATWG 13.2.5.34 After attribute name state
      // U+002F SOLIDUS (/) - Switch to the self-closing start tag state.
      return;
    }
    if (c !== 0x3d /* = */) {
      this.raw.end--;
      return;
    }
    this.skipWhiteSpace();
    if (this.lastErr !== null) {
      return;
    }
    const quote = this.readByte();
    if (this.lastErr !== null) {
      return;
    }
    switch (quote) {
      case 0x3e: // '>'
        this.raw.end--;
        return;

      case 0x27: // '\''
      case 0x22: // '"'
        this.pendingAttr[1].start = this.raw.end;
        for (;;) {
          c = this.readByte();
          if (this.lastErr !== null) {
            this.pendingAttr[1].end = this.raw.end;
            return;
          }
          if (c === quote) {
            this.pendingAttr[1].end = this.raw.end - 1;
            return;
          }
        }

      default:
        this.pendingAttr[1].start = this.raw.end - 1;
        for (;;) {
          c = this.readByte();
          if (this.lastErr !== null) {
            this.pendingAttr[1].end = this.raw.end;
            return;
          }
          switch (c) {
            case 0x20: // ' '
            case 0x0a: // '\n'
            case 0x0d: // '\r'
            case 0x09: // '\t'
            case 0x0c: // '\f'
              this.pendingAttr[1].end = this.raw.end - 1;
              return;
            case 0x3e: // '>'
              this.raw.end--;
              this.pendingAttr[1].end = this.raw.end;
              return;
          }
        }
    }
  }

  // next scans the next token and returns its type.
  next(): TokenType {
    this.raw.start = this.raw.end;
    this.data.start = this.raw.end;
    this.data.end = this.raw.end;
    if (this.lastErr !== null) {
      this.tt = ErrorToken;
      return this.tt;
    }
    if (this.rawTag !== "") {
      if (this.rawTag === "plaintext") {
        // Read everything up to EOF.
        while (this.lastErr === null) {
          this.readByte();
        }
        this.data.end = this.raw.end;
        this.textIsRaw = true;
      } else {
        this.readRawOrRCDATA();
      }
      if (this.data.end > this.data.start) {
        this.tt = TextToken;
        this.convertNUL = true;
        return this.tt;
      }
    }
    this.textIsRaw = false;
    this.convertNUL = false;

    loop: for (;;) {
      let c = this.readByte();
      if (this.lastErr !== null) {
        break loop;
      }
      if (c !== 0x3c /* < */) {
        continue loop;
      }

      // Check if the '<' we have just read is part of a tag, comment
      // or doctype. If not, it's part of the accumulated text token.
      c = this.readByte();
      if (this.lastErr !== null) {
        break loop;
      }
      let tokenType: TokenType;
      if ((0x61 <= c && c <= 0x7a) || (0x41 <= c && c <= 0x5a)) {
        tokenType = StartTagToken;
      } else if (c === 0x2f /* / */) {
        tokenType = EndTagToken;
      } else if (c === 0x21 /* ! */ || c === 0x3f /* ? */) {
        // We use CommentToken to mean any of "<!--actual comments-->",
        // "<!DOCTYPE declarations>" and "<?xml processing instructions?>".
        tokenType = CommentToken;
      } else {
        // Reconsume the current character.
        this.raw.end--;
        continue;
      }

      // We have a non-text token, but we might have accumulated some text
      // before that. If so, we return the text first, and return the non-
      // text token on the subsequent call to next.
      const x = this.raw.end - "<a".length;
      if (this.raw.start < x) {
        this.raw.end = x;
        this.data.end = x;
        this.tt = TextToken;
        return this.tt;
      }
      switch (tokenType) {
        case StartTagToken:
          this.tt = this.readStartTag();
          return this.tt;
        case EndTagToken:
          c = this.readByte();
          if (this.lastErr !== null) {
            break loop;
          }
          if (c === 0x3e /* > */) {
            // "</>" does not generate a token at all. Generate an empty comment
            // to allow passthrough clients to pick up the data using Raw.
            // Reset the tokenizer state and start again.
            this.tt = CommentToken;
            return this.tt;
          }
          if ((0x61 <= c && c <= 0x7a) || (0x41 <= c && c <= 0x5a)) {
            this.readTag(false);
            this.tt = this.lastErr !== null ? ErrorToken : EndTagToken;
            return this.tt;
          }
          this.raw.end--;
          this.readUntilCloseAngle();
          this.tt = CommentToken;
          return this.tt;
        case CommentToken:
          if (c === 0x21 /* ! */) {
            this.tt = this.readMarkupDeclaration();
            return this.tt;
          }
          this.raw.end--;
          this.readUntilCloseAngle();
          this.tt = CommentToken;
          return this.tt;
      }
    }
    if (this.raw.start < this.raw.end) {
      this.data.end = this.raw.end;
      this.tt = TextToken;
      return this.tt;
    }
    this.tt = ErrorToken;
    return this.tt;
  }

  // rawBytes returns the unmodified text of the current token. Calling next,
  // token, text, tagName or tagAttr may change the contents of the returned
  // slice.
  //
  // The token stream's raw bytes partition the byte stream (up until an
  // ErrorToken). There are no overlaps or gaps between two consecutive token's
  // raw bytes. One implication is that the byte offset of the current token is
  // the sum of the lengths of all previous tokens' raw bytes.
  rawBytes(): Uint8Array {
    return this.buf.subarray(this.raw.start, this.raw.end);
  }

  // text returns the unescaped text of a text, comment or doctype token. The
  // contents of the returned slice may change on the next call to next.
  text(): Uint8Array {
    switch (this.tt) {
      case TextToken:
      case CommentToken:
      case DoctypeToken: {
        let s = this.buf.subarray(this.data.start, this.data.end);
        this.data.start = this.raw.end;
        this.data.end = this.raw.end;
        s = convertNewlines(s);
        if ((this.convertNUL || this.tt === CommentToken) && s.includes(nul)) {
          s = replaceNUL(s);
        }
        if (!this.textIsRaw) {
          s = unescape(s, false);
        }
        return s;
      }
    }
    return new Uint8Array(0);
  }

  // tagName returns the lower-cased name of a tag token (the `img` out of
  // `<IMG SRC="foo">`) and whether the tag has attributes.
  // The contents of the returned slice may change on the next call to next.
  tagName(): [Uint8Array, boolean] {
    if (this.data.start < this.data.end) {
      switch (this.tt) {
        case StartTagToken:
        case EndTagToken:
        case SelfClosingTagToken: {
          const s = replaceNUL(this.buf.slice(this.data.start, this.data.end));
          this.data.start = this.raw.end;
          this.data.end = this.raw.end;
          return [lower(s), this.nAttrReturned < this.attr.length];
        }
      }
    }
    return [new Uint8Array(0), false];
  }

  // tagAttr returns the lower-cased key and unescaped value of the next unparsed
  // attribute for the current tag token and whether there are more attributes.
  // The contents of the returned slices may change on the next call to next.
  tagAttr(): [Uint8Array, Uint8Array, boolean] {
    if (this.nAttrReturned < this.attr.length) {
      switch (this.tt) {
        case StartTagToken:
        case SelfClosingTagToken: {
          const x = this.attr[this.nAttrReturned]!;
          this.nAttrReturned++;
          const key = replaceNUL(this.buf.slice(x[0].start, x[0].end));
          const val = replaceNUL(this.buf.slice(x[1].start, x[1].end));
          return [
            lower(key),
            unescape(convertNewlines(val), true),
            this.nAttrReturned < this.attr.length,
          ];
        }
      }
    }
    return [new Uint8Array(0), new Uint8Array(0), false];
  }

  // token returns the current Token. The result's data and attr values remain
  // valid after subsequent next calls.
  token(): Token {
    const t: Token = { type: this.tt, dataAtom: "", data: "", attr: [] };
    switch (this.tt) {
      case TextToken:
      case CommentToken:
      case DoctypeToken:
        t.data = decodeUTF8(this.text());
        break;
      case StartTagToken:
      case SelfClosingTagToken:
      case EndTagToken: {
        const [name, firstMore] = this.tagName();
        let moreAttr = firstMore;
        while (moreAttr) {
          const [key, val, more] = this.tagAttr();
          moreAttr = more;
          t.attr.push({ namespace: "", key: decodeUTF8(key), val: decodeUTF8(val) });
        }
        const a = lookup(decodeUTF8(name));
        t.dataAtom = a;
        t.data = a !== "" ? a : decodeUTF8(name);
        break;
      }
    }
    return t;
  }
}

// hasSuffix reports whether b ends with the ASCII suffix.
function hasSuffix(b: Uint8Array, suffix: string): boolean {
  if (b.length < suffix.length) {
    return false;
  }
  const tail = b.subarray(b.length - suffix.length);
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] !== suffix.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

// convertNewlines converts "\r" and "\r\n" in s to "\n".
// The conversion happens in place, but the resulting slice may be shorter.
function convertNewlines(s: Uint8Array): Uint8Array {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== 0x0d) {
      continue;
    }

    let src = i + 1;
    if (src >= s.length || s[src] !== 0x0a) {
      s[i] = 0x0a;
      continue;
    }

    let dst = i;
    while (src < s.length) {
      if (s[src] === 0x0d) {
        if (src + 1 < s.length && s[src + 1] === 0x0a) {
          src++;
        }
        s[dst] = 0x0a;
      } else {
        s[dst] = s[src]!;
      }
      src++;
      dst++;
    }
    return s.subarray(0, dst);
  }
  return s;
}

const nul = 0x00;
const replacement = encodeUTF8("�");

// replaceNUL is bytes.ReplaceAll(s, "\x00", "�"). It returns a new buffer,
// as bytes.ReplaceAll does.
function replaceNUL(s: Uint8Array): Uint8Array {
  if (!s.includes(nul)) {
    return s.slice();
  }
  const out: number[] = [];
  for (const c of s) {
    if (c === nul) {
      out.push(...replacement);
    } else {
      out.push(c);
    }
  }
  return Uint8Array.from(out);
}

// newTokenizer returns a new HTML Tokenizer for the given input.
export function newTokenizer(input: Uint8Array): Tokenizer {
  return new Tokenizer(input, "");
}

// newTokenizerFragment returns a new HTML Tokenizer for the given input, for
// tokenizing an existing element's InnerHTML fragment. contextTag is that
// element's tag, such as "div" or "iframe".
export function newTokenizerFragment(input: Uint8Array, contextTag: string): Tokenizer {
  return new Tokenizer(input, contextTag);
}

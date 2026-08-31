// Arithmetic in the number fields: "333030*2", "/2", "x 2", "(1+2)/3". Fields
// hold values like 1.5e11, and the interesting edits are relative — double this
// mass, halve that velocity.
//
// A recursive-descent parser rather than a regex or `eval`: `eval` on a text
// input is a script-injection hole, and a regex can't nest parens or get
// precedence right ("1e-3" looks exactly like a subtraction to anything that
// splits on operators).
//
// Accepts only what a calculator keypad offers: literals, + - * / ^, unary
// minus, parens. No identifiers or constants — an unknown character is a parse
// failure, never a silent zero.

/** Multiplication and division spelled the way people actually type them. */
const OPERATOR_ALIASES: Record<string, string> = {
  x: '*',
  X: '*',
  '×': '*',
  '·': '*',
  '÷': '/',
  '−': '-', // U+2212 minus, what some keyboards and pasted text produce
  '–': '-', // en dash
};

/** Characters that make a string arithmetic rather than a literal. */
const OPERATOR_CHARS = /[+\-*/^xX×·÷−–()]/;

/**
 * Consumed as part of a number literal. The decimal point is included so a
 * malformed "1.2.3" reaches `Number` intact and fails there; `,` and `_` are
 * stripped before parsing.
 */
const SEPARATORS = new Set(['.', ',', '_']);

/**
 * A leading operator applies to what's already in the field: `/2` halves it.
 * `-` is excluded — "-5" almost always means negative five, not "subtract
 * five", and the two are indistinguishable. `+` is included: nobody types a
 * unary plus on a literal, so it always reads as an addition.
 */
const RELATIVE_OPERATORS = ['+', '*', '/', '^'];

/** Tokens: a number literal, one of the operators, or a paren. */
type Token =
  | { kind: 'number'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '^' }
  | { kind: 'paren'; value: '(' | ')' };

class ParseError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const raw = input[i];

    if (raw === ' ' || raw === '\t') {
      i += 1;
      continue;
    }

    // "0x…" is a hex literal, not zero-times-something: it would otherwise
    // tokenize as 0 * 16 and commit a plausible-looking wrong value. Only a
    // lone leading 0 is a hex prefix; "10x2" still reads as 10 × 2.
    if ((raw === 'x' || raw === 'X') && input[i - 1] === '0' && !isDigit(input[i - 2])) {
      throw new ParseError(`unexpected "${raw}"`);
    }

    const char = OPERATOR_ALIASES[raw] ?? raw;

    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '^') {
      tokens.push({ kind: 'op', value: char });
      i += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', value: char });
      i += 1;
      continue;
    }

    if (isDigit(char) || char === '.') {
      const start = i;
      // `,` and `_` are absorbed here rather than skipped globally, so they
      // only group digits ("1,000,000") and can't glue two operands into one.
      while (i < input.length && (isDigit(input[i]) || SEPARATORS.has(input[i]))) i += 1;
      // Exponent only when it really is one ("1e5", "1e-5", "2E+3"); a
      // trailing "1e" is half-typed and must not swallow the 'e'.
      if (i < input.length && (input[i] === 'e' || input[i] === 'E')) {
        let j = i + 1;
        if (j < input.length && (input[j] === '+' || input[j] === '-')) j += 1;
        if (isDigit(input[j])) {
          while (j < input.length && isDigit(input[j])) j += 1;
          i = j;
        }
      }
      const text = input.slice(start, i).replace(/[,_]/g, '');
      const value = Number(text);
      // Catches "1.2.3" and ".", which slice out fine but aren't numbers.
      if (text === '.' || !Number.isFinite(value)) throw new ParseError(`bad number "${text}"`);
      tokens.push({ kind: 'number', value });
      continue;
    }

    throw new ParseError(`unexpected "${raw}"`);
  }

  return tokens;
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/**
 * Grammar, lowest precedence first. Right-associative `^` binds tighter than
 * unary minus so `-2^2` is -4, matching every calculator and spreadsheet.
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/') unary)*
 *   unary  := ('+' | '-') unary | power
 *   power  := primary ('^' unary)?
 *   primary := number | '(' expr ')'
 */
class Parser {
  private at = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expr();
    if (this.at < this.tokens.length) throw new ParseError('trailing input');
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private eatOp(...ops: string[]): string | null {
    const token = this.peek();
    if (token?.kind === 'op' && ops.includes(token.value)) {
      this.at += 1;
      return token.value;
    }
    return null;
  }

  private expr(): number {
    let left = this.term();
    for (;;) {
      const op = this.eatOp('+', '-');
      if (!op) return left;
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
  }

  private term(): number {
    let left = this.unary();
    for (;;) {
      const op = this.eatOp('*', '/');
      if (!op) return left;
      const right = this.unary();
      left = op === '*' ? left * right : left / right;
    }
  }

  private unary(): number {
    const op = this.eatOp('+', '-');
    if (op) {
      const value = this.unary();
      return op === '-' ? -value : value;
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (this.eatOp('^')) return base ** this.unary();
    return base;
  }

  private primary(): number {
    const token = this.peek();
    if (token === undefined) throw new ParseError('unexpected end');

    if (token.kind === 'number') {
      this.at += 1;
      return token.value;
    }

    if (token.kind === 'paren' && token.value === '(') {
      this.at += 1;
      const value = this.expr();
      const close = this.peek();
      if (close?.kind !== 'paren' || close.value !== ')') throw new ParseError('missing )');
      this.at += 1;
      return value;
    }

    throw new ParseError(`unexpected "${token.value}"`);
  }
}

/**
 * True when `input` is arithmetic rather than a plain number. Decides whether a
 * committed field *rewrites* itself with the result: "333030*2" becomes
 * "666060", while "1.50" is left as typed. "1e5" is a literal, not math.
 */
export function looksLikeExpression(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === '') return false;
  // A leading relative operator is math by definition.
  const first = OPERATOR_ALIASES[trimmed[0]] ?? trimmed[0];
  if (RELATIVE_OPERATORS.includes(first)) return true;
  // A plain literal — sign, digits, exponent — is not math, even though
  // "1e-3" and "-3" contain operator characters.
  if (/^[-−–]?[\d.,_]+([eE][+-]?\d+)?$/.test(trimmed)) return false;
  return OPERATOR_CHARS.test(trimmed);
}

/**
 * Evaluate what the user typed, in display units. `current` is the field's
 * present value, used only for the relative forms (`*2`, `/2`, `+2`, `^2`).
 * Null means "not a complete, finite expression" — the caller's cue to leave
 * the value alone, since mid-typing states like "333030*" land here on every
 * keystroke.
 */
export function evaluateExpression(input: string, current?: number): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // Resolve the relative forms by prepending the current value, so `/2` parses
  // as `<current>/2` and shares one code path with everything else.
  const first = OPERATOR_ALIASES[trimmed[0]] ?? trimmed[0];
  let text = trimmed;
  if (RELATIVE_OPERATORS.includes(first)) {
    if (current === undefined || !Number.isFinite(current)) return null;
    // Parenthesized so a negative current value keeps its sign against `^`
    // and so `-1 + 2` can't reassociate: (-1)+2, never -(1+2).
    text = `(${current})${trimmed}`;
  }

  try {
    const value = new Parser(tokenize(text)).parse();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

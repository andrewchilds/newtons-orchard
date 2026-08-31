import { describe, expect, it } from 'vitest';
import { evaluateExpression, looksLikeExpression } from './expression';

describe('evaluateExpression', () => {
  it('passes plain numbers through, including the forms a field produces', () => {
    expect(evaluateExpression('42')).toBe(42);
    expect(evaluateExpression('-1.5')).toBe(-1.5);
    expect(evaluateExpression('.5')).toBe(0.5);
    expect(evaluateExpression('1.989e30')).toBe(1.989e30);
    expect(evaluateExpression('1e-3')).toBe(1e-3);
    expect(evaluateExpression('2E+3')).toBe(2000);
    expect(evaluateExpression('  7  ')).toBe(7);
  });

  it('does the four operations', () => {
    expect(evaluateExpression('333030*2')).toBe(666060);
    expect(evaluateExpression('10 - 4')).toBe(6);
    expect(evaluateExpression('1 + 2')).toBe(3);
    expect(evaluateExpression('9/2')).toBe(4.5);
  });

  it('accepts x and the typographic operators as multiply/divide', () => {
    expect(evaluateExpression('5 x 3')).toBe(15);
    expect(evaluateExpression('5X3')).toBe(15);
    expect(evaluateExpression('5 × 3')).toBe(15);
    expect(evaluateExpression('6 ÷ 3')).toBe(2);
    expect(evaluateExpression('5 − 3')).toBe(2);
  });

  it('respects precedence and parentheses', () => {
    expect(evaluateExpression('1 + 2 * 3')).toBe(7);
    expect(evaluateExpression('(1 + 2) * 3')).toBe(9);
    expect(evaluateExpression('2 * (3 + (4 - 1))')).toBe(12);
    expect(evaluateExpression('100 / 10 / 2')).toBe(5); // left-associative
    expect(evaluateExpression('10 - 3 - 2')).toBe(5);
  });

  it('exponentiates right-associatively, binding tighter than unary minus', () => {
    expect(evaluateExpression('2^10')).toBe(1024);
    expect(evaluateExpression('2^3^2')).toBe(512);
    expect(evaluateExpression('-2^2')).toBe(-4);
  });

  it('handles stacked unary signs', () => {
    expect(evaluateExpression('--5')).toBe(5);
    expect(evaluateExpression('3 * -2')).toBe(-6);
    expect(evaluateExpression('3 * +2')).toBe(6);
  });

  it('ignores thousands separators pasted in from a readout', () => {
    expect(evaluateExpression('1,000,000')).toBe(1e6);
    expect(evaluateExpression('1_000 * 2')).toBe(2000);
  });

  // --- relative forms ----------------------------------------------------

  it('applies a leading operator to the current value', () => {
    expect(evaluateExpression('*2', 50)).toBe(100);
    expect(evaluateExpression('/2', 50)).toBe(25);
    expect(evaluateExpression(' + 2', 50)).toBe(52);
    expect(evaluateExpression('+8', 50)).toBe(58);
    expect(evaluateExpression('x 2', 50)).toBe(100);
    expect(evaluateExpression('÷ 4', 50)).toBe(12.5);
    expect(evaluateExpression('^2', 5)).toBe(25);
  });

  it('reads a leading minus as a negative literal, not a subtraction', () => {
    // Otherwise there is no way to type a negative velocity component.
    expect(evaluateExpression('-5', 50)).toBe(-5);
  });

  it('keeps the sign of a negative current value under a relative edit', () => {
    expect(evaluateExpression('/2', -50)).toBe(-25);
    expect(evaluateExpression('^2', -3)).toBe(9);
  });

  it('composes a relative edit with the rest of the expression', () => {
    expect(evaluateExpression('*2 + 1', 10)).toBe(21);
    expect(evaluateExpression('/(2*2)', 40)).toBe(10);
  });

  it('needs a current value for the relative forms', () => {
    expect(evaluateExpression('*2')).toBeNull();
    expect(evaluateExpression('+8')).toBeNull();
    expect(evaluateExpression('/2', Number.NaN)).toBeNull();
  });

  // --- rejection ---------------------------------------------------------

  it('returns null for empty and whitespace-only input', () => {
    expect(evaluateExpression('')).toBeNull();
    expect(evaluateExpression('   ')).toBeNull();
  });

  it('returns null mid-typing rather than committing a partial value', () => {
    for (const partial of ['333030*', '1 +', '(1 + 2', '1e', '2^', '1..2', '1.2.3']) {
      expect(evaluateExpression(partial, 10), partial).toBeNull();
    }
  });

  it('refuses anything that is not calculator arithmetic', () => {
    for (const bad of [
      'abc',
      '2 + foo',
      'Math.PI',
      'alert(1)',
      '1; 2',
      '2 ** 3',
      '5 % 2',
      '0x10',
      'Infinity',
      'NaN',
      '1)2(',
    ]) {
      expect(evaluateExpression(bad, 10), bad).toBeNull();
    }
  });

  it('returns null for a non-finite result instead of NaN or Infinity', () => {
    expect(evaluateExpression('1/0')).toBeNull();
    expect(evaluateExpression('0/0')).toBeNull();
    expect(evaluateExpression('1e308 * 10')).toBeNull();
  });
});

describe('looksLikeExpression', () => {
  it('is false for plain literals, so the field keeps the text as typed', () => {
    for (const plain of ['', '42', '1.50', '-3', '1.989e30', '1e-3', '  7 ']) {
      expect(looksLikeExpression(plain), plain).toBe(false);
    }
  });

  it('is true for anything with an operator or paren', () => {
    for (const math of [
      '333030*2',
      '/2',
      ' + 2',
      '+8', // leading + is always a relative nudge, never unary plus
      'x 2',
      '2^10',
      '(1+2)/3',
      '10 - 4',
      '5 ÷ 2',
    ]) {
      expect(looksLikeExpression(math), math).toBe(true);
    }
  });
});

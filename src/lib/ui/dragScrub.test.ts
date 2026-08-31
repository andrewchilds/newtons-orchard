import { describe, expect, it } from 'vitest';
import { dragValue, modifierScale, DRAG_THRESHOLD } from './dragScrub';

describe('modifierScale', () => {
  it('is 1 with nothing held', () => {
    expect(modifierScale({})).toBe(1);
  });

  it('coarsens with shift and refines with alt', () => {
    expect(modifierScale({ shift: true })).toBe(10);
    expect(modifierScale({ alt: true })).toBeCloseTo(0.1);
  });

  it('cancels out when both are held', () => {
    expect(modifierScale({ shift: true, alt: true })).toBeCloseTo(1);
  });
});

describe('dragValue', () => {
  it('does not move the value inside the click threshold', () => {
    for (const dx of [0, 1, -1, DRAG_THRESHOLD, -DRAG_THRESHOLD]) {
      expect(dragValue(100, dx)).toBe(100);
    }
  });

  it('increases dragging right and decreases dragging left', () => {
    expect(dragValue(100, 40)).toBeGreaterThan(100);
    expect(dragValue(100, -40)).toBeLessThan(100);
  });

  it('is symmetric in ratio: equal drags either way round-trip', () => {
    const out = dragValue(100, 40);
    // Dragging back from the new value by the same distance returns to start.
    const back = dragValue(out, -40);
    expect(back).toBeCloseTo(100, 6);
  });

  it('scales proportionally, so the felt sensitivity is scale-free', () => {
    const smallRatio = dragValue(0.5, 30) / 0.5;
    const hugeRatio = dragValue(1.5e11, 30) / 1.5e11;
    expect(smallRatio).toBeCloseTo(hugeRatio, 6);
  });

  it('moves toward zero on a right-drag of a negative value', () => {
    const out = dragValue(-100, 40);
    expect(out).toBeGreaterThan(-100);
    expect(out).toBeLessThan(0);
  });

  it('mirrors magnitude changes across the sign', () => {
    expect(dragValue(-100, -40)).toBeCloseTo(-dragValue(100, 40), 6);
  });

  it('never crosses zero under proportional stepping', () => {
    expect(dragValue(100, -100000)).toBeGreaterThan(0);
    expect(dragValue(-100, 100000)).toBeLessThan(0);
  });

  it('escapes zero with a fixed step rather than sticking', () => {
    expect(dragValue(0, 100)).toBeGreaterThan(0);
    expect(dragValue(0, -100)).toBeLessThan(0);
  });

  it('steps linearly when the caller supplies a step', () => {
    // 20px past the threshold at 0.01/px.
    expect(dragValue(0.5, 20 + DRAG_THRESHOLD, {}, 0.01)).toBeCloseTo(0.7, 9);
    expect(dragValue(0.5, -(20 + DRAG_THRESHOLD), {}, 0.01)).toBeCloseTo(0.3, 9);
  });

  it('crosses zero freely with an explicit step', () => {
    expect(dragValue(0.1, 100 + DRAG_THRESHOLD, {}, 0.01)).toBeCloseTo(1.1, 9);
    expect(dragValue(0.1, -(100 + DRAG_THRESHOLD), {}, 0.01)).toBeCloseTo(-0.9, 9);
  });

  it('applies modifiers to both stepping modes', () => {
    const px = 20 + DRAG_THRESHOLD;
    expect(dragValue(0.5, px, { shift: true }, 0.01)).toBeCloseTo(0.5 + 20 * 0.1, 9);
    expect(dragValue(0.5, px, { alt: true }, 0.01)).toBeCloseTo(0.5 + 20 * 0.001, 9);

    // Proportional: shift is a bigger ratio, alt a smaller one.
    const plain = dragValue(100, px) / 100;
    expect(dragValue(100, px, { shift: true }) / 100).toBeGreaterThan(plain);
    expect(dragValue(100, px, { alt: true }) / 100).toBeLessThan(plain);
  });

  it('treats a non-finite start as zero rather than propagating NaN', () => {
    expect(Number.isFinite(dragValue(NaN, 50))).toBe(true);
  });

  it('ignores a zero or negative step and falls back to proportional', () => {
    expect(dragValue(100, 40, {}, 0)).toBe(dragValue(100, 40));
    expect(dragValue(100, 40, {}, -1)).toBe(dragValue(100, 40));
  });
});

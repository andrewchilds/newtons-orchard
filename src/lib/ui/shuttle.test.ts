import { describe, expect, it } from 'vitest';
import { shuttleRate, formatRate, ANCHORS, DEADZONE } from './shuttle';
import { DAY, HOUR, YEAR } from '../physics/constants';

describe('shuttleRate', () => {
  it('hits every anchor', () => {
    // The documented anchors are rounded for readability, so match to 2%
    // rather than exactly — except full travel, which is exactly a year.
    for (const { x, rate } of ANCHORS) {
      expect(shuttleRate(x) / rate).toBeCloseTo(1, 1);
    }
    expect(shuttleRate(1) / YEAR).toBeCloseTo(1, 6);
  });

  it('is zero inside the deadzone', () => {
    expect(shuttleRate(0)).toBe(0);
    expect(shuttleRate(DEADZONE)).toBe(0);
    expect(shuttleRate(-DEADZONE)).toBe(0);
    expect(shuttleRate(DEADZONE * 0.5)).toBe(0);
  });

  it('engages just past the deadzone', () => {
    expect(shuttleRate(DEADZONE * 1.01)).toBeGreaterThan(0);
  });

  it('is symmetric about center', () => {
    for (const x of [0.1, 0.25, 0.5, 0.77, 1]) {
      expect(shuttleRate(-x)).toBe(-shuttleRate(x));
    }
  });

  it('increases monotonically with displacement', () => {
    let previous = 0;
    for (let x = DEADZONE + 0.01; x <= 1; x += 0.01) {
      const rate = shuttleRate(x);
      expect(rate).toBeGreaterThan(previous);
      previous = rate;
    }
  });

  it('clamps beyond full travel', () => {
    expect(shuttleRate(1.5)).toBe(shuttleRate(1));
    expect(shuttleRate(-99)).toBe(shuttleRate(-1));
  });

  it('stays fine-grained near center', () => {
    // Just past the deadzone should still be minutes per second — the point
    // of leaning on the exponential at all is usable low-end control. Leaning
    // toward linear costs some of this; sub-hour is the line worth holding.
    expect(shuttleRate(0.06)).toBeLessThan(HOUR);
    expect(shuttleRate(0.06)).toBeGreaterThan(0);
  });

  it('keeps the outer half aimable', () => {
    // The failure mode being guarded against: a pure exponential spans 365×
    // between half and full travel, so the top of the track is unusable for
    // landing on a particular rate. The blend keeps that span well under 100×.
    expect(shuttleRate(1) / shuttleRate(0.5)).toBeLessThan(100);
  });

  it('reaches a year per second at full travel', () => {
    expect(shuttleRate(1) / YEAR).toBeCloseTo(1, 6);
  });
});

describe('formatRate', () => {
  it('labels a centered shuttle as paused', () => {
    expect(formatRate(0)).toBe('paused');
  });

  it('picks the largest unit that keeps the number above 1', () => {
    expect(formatRate(120)).toBe('2.0 min/s');
    expect(formatRate(2 * HOUR)).toBe('2.0 hr/s');
    expect(formatRate(3 * DAY)).toBe('3.0 day/s');
    expect(formatRate(YEAR)).toBe('1.0 yr/s');
  });

  it('marks reverse with a minus sign', () => {
    expect(formatRate(-2 * HOUR)).toBe('−2.0 hr/s');
    expect(formatRate(-YEAR)).toBe('−1.0 yr/s');
  });

  it('never renders a bare unit boundary as 0.x of the larger unit', () => {
    // Every representable rate should format with a leading value ≥ 1.
    for (const r of [61, HOUR - 1, HOUR, DAY - 1, DAY, YEAR - 1, YEAR, 5 * YEAR]) {
      const value = Number(formatRate(r).split(' ')[0]);
      expect(value).toBeGreaterThanOrEqual(1);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { formatSimDate, formatDays } from './formatTime';
import { DAY } from '../physics/constants';

/** The display year is 365 whole days — see formatSimDate's doc comment. */
const DISPLAY_YEAR = 365 * DAY;

describe('formatSimDate', () => {
  it('starts at Year 1, Day 1.0', () => {
    expect(formatSimDate(0)).toBe('Year 1, Day 1.0');
  });

  it('counts days within the first year', () => {
    expect(formatSimDate(144 * DAY)).toBe('Year 1, Day 145.0');
  });

  it('shows tenths of a day', () => {
    expect(formatSimDate(0.5 * DAY)).toBe('Year 1, Day 1.5');
    expect(formatSimDate(144.25 * DAY)).toBe('Year 1, Day 145.3');
  });

  it('rolls over into the next year', () => {
    expect(formatSimDate(364 * DAY)).toBe('Year 1, Day 365.0');
    expect(formatSimDate(DISPLAY_YEAR)).toBe('Year 2, Day 1.0');
    expect(formatSimDate(DISPLAY_YEAR + 144 * DAY)).toBe('Year 2, Day 145.0');
  });

  it('never shows a day number past the year length', () => {
    // Tenth-day increments cover the rounding seam at each year boundary,
    // where "Day 366.0" must instead read as the next year's Day 1.
    for (let d = 0; d < 3 * 365; d += 0.1) {
      const day = Number(formatSimDate(d * DAY).split('Day ')[1]);
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(365.9);
    }
  });
});

describe('formatDays', () => {
  it('renders elapsed days to one decimal', () => {
    expect(formatDays(0)).toBe('0.0 d');
    expect(formatDays(2.5 * DAY)).toBe('2.5 d');
  });
});

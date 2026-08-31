// Sim-time display formatting. Pure functions.

import { DAY } from '../physics/constants';

/** Days per display year. See `formatSimDate` for why this isn't 365.25. */
const DISPLAY_YEAR_DAYS = 365;

/**
 * Calendar-style readout for a sim time in seconds, e.g. "Year 2, Day 145.3".
 *
 * The display year is 365 whole days, not the Julian 365.25 the physics uses:
 * a fractional year length drifts the year boundary a quarter day annually, so
 * "Day 366" appears in some years. Formatting only — physics is unaffected, and
 * `formatDays` shows exact elapsed time. Both counters are 1-based; the day
 * carries one decimal so slow warps visibly move the clock.
 */
export function formatSimDate(seconds: number): string {
  const days = seconds / DAY;
  let year = Math.floor(days / DISPLAY_YEAR_DAYS) + 1;
  let day = Math.round((days - (year - 1) * DISPLAY_YEAR_DAYS + 1) * 10) / 10;
  // Rounding the last tenth-day of a year would read "Day 366.0"; show the
  // rollover instead.
  if (day >= DISPLAY_YEAR_DAYS + 1) {
    year += 1;
    day = 1;
  }
  return `Year ${year}, Day ${day.toFixed(1)}`;
}

/** Raw elapsed days, e.g. "1,204.3 d". */
export function formatDays(seconds: number): string {
  const days = seconds / DAY;
  return `${days.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} d`;
}

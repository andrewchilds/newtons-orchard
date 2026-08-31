// Shuttle rate curve: handle displacement → sim-seconds per wall-second.
// Pure functions, unit-tested; the component owns pointer handling and
// spring-back.

import { DAY, HOUR, YEAR } from '../physics/constants';

/**
 * Displacement below this reads as centered — without it a handle released a
 * pixel off center would creep the sim forever.
 */
export const DEADZONE = 0.04;

/**
 * Rate at the edge of the deadzone. Sets the low end independently of
 * LINEARITY; raising it mostly coarsens the first few pixels of travel.
 */
const MIN_RATE = 2 * 60;

/** Rate at full travel. */
const MAX_RATE = YEAR;

/**
 * How far the curve leans from pure exponential (0) toward linear (1).
 *
 * Pure exponential puts a 365× range in the outer half alone — unaimable. The
 * blend trades low-end resolution for an outer half spanning only ~88×.
 */
const LINEARITY = 0.35;

/** Rate anchors, for tests: ¼ travel ≈ 9 hr/s, ½ ≈ 4 day/s, full = 1 yr/s. */
export const ANCHORS: readonly { x: number; rate: number }[] = [
  { x: 0.25, rate: 9.1 * HOUR },
  { x: 0.5, rate: 4.1 * DAY },
  { x: 1, rate: YEAR },
];

/**
 * Signed scrub rate for a normalized handle displacement `x` ∈ [-1, 1],
 * in sim-seconds per wall-second. Returns 0 inside the deadzone.
 *
 * A geometric blend of an exponential and a linear ramp, both spanning
 * MIN_RATE→MAX_RATE over the travel outside the deadzone. Symmetric.
 */
export function shuttleRate(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude <= DEADZONE) return 0;

  // Re-normalize so the curve starts at MIN_RATE where the deadzone ends,
  // rather than jumping to whatever the raw curve reads there.
  const t = (Math.min(1, magnitude) - DEADZONE) / (1 - DEADZONE);

  const exponential = MIN_RATE * Math.exp(t * Math.log(MAX_RATE / MIN_RATE));
  const linear = MIN_RATE + t * (MAX_RATE - MIN_RATE);
  const rate = Math.exp(
    (1 - LINEARITY) * Math.log(exponential) + LINEARITY * Math.log(linear),
  );

  return x < 0 ? -rate : rate;
}

/**
 * Human-readable rate, e.g. "1.0 day/s" or "paused". Picks the largest unit
 * that keeps the number above 1.
 */
export function formatRate(rate: number): string {
  if (rate === 0) return 'paused';

  const sign = rate < 0 ? '−' : '';
  const r = Math.abs(rate);
  const MONTH = 30 * DAY;

  if (r < HOUR) return `${sign}${(r / 60).toFixed(1)} min/s`;
  if (r < DAY) return `${sign}${(r / HOUR).toFixed(1)} hr/s`;
  if (r < MONTH) return `${sign}${(r / DAY).toFixed(1)} day/s`;
  if (r < YEAR) return `${sign}${(r / MONTH).toFixed(1)} mo/s`;
  return `${sign}${(r / YEAR).toFixed(1)} yr/s`;
}

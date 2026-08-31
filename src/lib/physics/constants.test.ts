import { describe, expect, it } from 'vitest';
import {
  AU,
  DAY,
  EARTH_MASS,
  EARTH_RADIUS,
  G,
  JUPITER_MASS,
  MOON_MASS,
  SUN_MASS,
  SUN_RADIUS,
  YEAR,
} from './constants';

// Guards against a typo'd exponent silently rescaling the whole simulation.
describe('constants', () => {
  it('G is the CODATA gravitational constant', () => {
    expect(G).toBeCloseTo(6.674e-11, 14);
  });

  it('uses the IAU astronomical unit', () => {
    expect(AU).toBeCloseTo(1.496e11, -8);
  });

  it('relates day and year correctly', () => {
    expect(DAY).toBe(86400);
    expect(YEAR / DAY).toBeCloseTo(365.25, 10);
  });

  it('has plausible mass ratios', () => {
    expect(SUN_MASS / EARTH_MASS).toBeCloseTo(333000, -4);
    expect(JUPITER_MASS / EARTH_MASS).toBeCloseTo(317.8, 0);
    expect(EARTH_MASS / MOON_MASS).toBeCloseTo(81.3, 0);
  });

  it('has plausible radii', () => {
    expect(SUN_RADIUS / EARTH_RADIUS).toBeCloseTo(109, 0);
  });
});

import { describe, expect, it } from 'vitest';
import { AU, SUN_MASS } from './constants';
import { habitableZone } from './habitableZone';

describe('habitableZone', () => {
  it('brackets Earth for a Sun-mass star', () => {
    const zone = habitableZone(SUN_MASS);
    expect(zone.inner).toBeCloseTo(0.8 * AU, -6);
    expect(zone.outer).toBeCloseTo(1.5 * AU, -6);
    expect(zone.inner).toBeLessThan(AU);
    expect(zone.outer).toBeGreaterThan(AU);
  });

  it('scales both edges with √L for the M^3.5 luminosity', () => {
    const dim = habitableZone(0.6 * SUN_MASS);
    const sun = habitableZone(SUN_MASS);
    const expected = Math.sqrt(0.6 ** 3.5);
    expect(dim.inner / sun.inner).toBeCloseTo(expected, 10);
    expect(dim.outer / sun.outer).toBeCloseTo(expected, 10);
  });
});

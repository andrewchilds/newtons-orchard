// The classical liquid-water habitable zone, estimated from stellar mass
// alone: equal insolation puts the band at distance ∝ √L (flux falls as L/d²),
// with L from the main-sequence L ∝ M^3.5 rule. The Sun-anchored bounds are
// rounded Kasting-style limits — runaway greenhouse inside, maximum greenhouse
// outside. First-order on purpose: no spectral dependence, no atmosphere, no
// eccentricity. Shared by the random-system generator and the display overlay
// so the drawn band and the generated earthlikes can never disagree.

import { AU, SUN_MASS } from './constants';

export const HZ_INNER_AU = 0.8;
export const HZ_OUTER_AU = 1.5;

export interface HabitableZone {
  /** inner edge, m */
  inner: number;
  /** outer edge, m */
  outer: number;
}

export function habitableZone(starMass: number): HabitableZone {
  const sqrtLum = Math.sqrt((starMass / SUN_MASS) ** 3.5);
  return { inner: HZ_INNER_AU * sqrtLum * AU, outer: HZ_OUTER_AU * sqrtLum * AU };
}

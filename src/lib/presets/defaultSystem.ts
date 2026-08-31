// The "Star & Planet" preset: one star and one planet, deliberately bare — a
// blank canvas for building a system through the UI. (The app boots into
// `solarSystem()` — see `state/simInstance.ts`.)

import { AU, DAY, EARTH_MASS, EARTH_RADIUS, SUN_MASS, SUN_RADIUS } from '../physics/constants';
import { circularOrbit, type StateVector } from '../physics/kepler';
import { vec3 } from '../physics/vec3';
import type { Body } from '../types';

export function defaultSystem(): Body[] {
  const star: StateVector = { position: vec3(), velocity: vec3() };
  const planet = circularOrbit(SUN_MASS, star, AU, 0, 0, EARTH_MASS);

  return [
    {
      id: crypto.randomUUID(),
      name: 'Star',
      color: '#ffd27f',
      type: 'star',
      mass: SUN_MASS,
      radius: SUN_RADIUS,
      rotationPeriod: 25.4 * DAY,
      axialTilt: 7.25,
      position: star.position,
      velocity: star.velocity,
    },
    {
      id: crypto.randomUUID(),
      name: 'Planet 1',
      color: '#4a7edb',
      type: 'earthlike',
      mass: EARTH_MASS,
      radius: EARTH_RADIUS,
      rotationPeriod: 86164,
      axialTilt: 23.44,
      position: planet.position,
      velocity: planet.velocity,
      atmosphere: { color: '#7fb2ff', density: 0.2 },
    },
  ];
}

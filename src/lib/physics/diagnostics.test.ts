import { describe, expect, it } from 'vitest';
import { AU, EARTH_MASS, EARTH_RADIUS, G, SUN_MASS, SUN_RADIUS } from './constants';
import { createState, stateFromBodies } from './integrator';
import { circularOrbit } from './kepler';
import {
  barycenter,
  barycenterVelocity,
  kineticEnergy,
  potentialEnergy,
  totalEnergy,
  totalMomentum,
} from './diagnostics';
import { AT_ORIGIN, testBody } from './testUtils';

describe('diagnostics', () => {
  it('computes kinetic energy as ½mv²', () => {
    const state = createState(2);
    state.mass[0] = 2;
    state.mass[1] = 4;
    state.vel[0] = 3; // body 0: v = 3 along x
    state.vel[4] = 5; // body 1: v = 5 along y
    expect(kineticEnergy(state)).toBeCloseTo(0.5 * 2 * 9 + 0.5 * 4 * 25, 9);
  });

  it('computes pairwise potential energy as −Gm₁m₂/r', () => {
    const state = createState(2);
    state.mass[0] = SUN_MASS;
    state.mass[1] = EARTH_MASS;
    state.pos[3] = AU;

    const expected = -(G * SUN_MASS * EARTH_MASS) / AU;
    expect(potentialEnergy(state) / expected).toBeCloseTo(1, 10);
    expect(potentialEnergy(state)).toBeLessThan(0);
  });

  it('reports negative total energy for a bound orbit', () => {
    const earth = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, 0, EARTH_MASS);
    const state = stateFromBodies([
      testBody({ mass: SUN_MASS, radius: SUN_RADIUS, type: 'star' }),
      testBody({
        mass: EARTH_MASS,
        radius: EARTH_RADIUS,
        position: earth.position,
        velocity: earth.velocity,
      }),
    ]);
    expect(totalEnergy(state)).toBeLessThan(0);
    // For a circular orbit, KE = −PE/2 (virial theorem).
    expect(kineticEnergy(state) / -potentialEnergy(state)).toBeCloseTo(0.5, 4);
  });

  it('sums momentum across bodies', () => {
    const state = createState(2);
    state.mass[0] = 10;
    state.mass[1] = 5;
    state.vel[0] = 2;
    state.vel[3] = -4;
    const p = totalMomentum(state);
    expect(p.x).toBeCloseTo(10 * 2 + 5 * -4, 9);
    expect(p.y).toBe(0);
    expect(p.z).toBe(0);
  });

  it('locates the barycenter of an unequal pair', () => {
    const state = createState(2);
    state.mass[0] = 3;
    state.mass[1] = 1;
    state.pos[0] = 0;
    state.pos[3] = 4;
    // Center of mass sits 1/4 of the way from the heavy body.
    expect(barycenter(state).x).toBeCloseTo(1, 9);
  });

  it('puts the Sun-Earth barycenter just inside the Sun', () => {
    const state = createState(2);
    state.mass[0] = SUN_MASS;
    state.mass[1] = EARTH_MASS;
    state.pos[3] = AU;
    // ~450 km from the Sun's center — well inside its 696,000 km radius.
    expect(barycenter(state).x).toBeLessThan(SUN_RADIUS);
    expect(barycenter(state).x).toBeGreaterThan(1e5);
  });

  it('returns the origin for a massless or empty system', () => {
    expect(barycenter(createState(0))).toEqual({ x: 0, y: 0, z: 0 });
    expect(barycenter(createState(2))).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('computes barycenter velocity as P/M', () => {
    const state = createState(2);
    state.mass[0] = 3;
    state.mass[1] = 1;
    state.vel[0] = 4;
    state.vel[3] = 0;
    expect(barycenterVelocity(state).x).toBeCloseTo((3 * 4) / 4, 9);
  });
});

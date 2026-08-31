import { describe, expect, it } from 'vitest';
import { AU, EARTH_MASS, EARTH_RADIUS, G, SUN_MASS, SUN_RADIUS } from './constants';
import { computeAccelerations } from './gravity';
import { createState, stateFromBodies, step } from './integrator';
import { totalMomentum } from './diagnostics';
import { testBody } from './testUtils';

/** Two point masses on the x axis at ±(separation/2). */
function pair(m1: number, m2: number, separation: number) {
  const state = createState(2);
  state.mass[0] = m1;
  state.mass[1] = m2;
  state.pos[0] = -separation / 2;
  state.pos[3] = separation / 2;
  computeAccelerations(state);
  return state;
}

describe('computeAccelerations', () => {
  it('matches the analytic GM/r² for a two-body pair', () => {
    const r = AU;
    const state = pair(SUN_MASS, EARTH_MASS, r);

    // Body 0 is pulled toward +x by body 1, and vice versa.
    expect(state.acc[0]).toBeCloseTo((G * EARTH_MASS) / (r * r), 20);
    expect(state.acc[3]).toBeCloseTo(-(G * SUN_MASS) / (r * r), 12);
    // No off-axis component.
    expect(state.acc[1]).toBe(0);
    expect(state.acc[2]).toBe(0);
    expect(state.acc[4]).toBe(0);
    expect(state.acc[5]).toBe(0);
  });

  it('produces equal and opposite forces (Newton III)', () => {
    const state = pair(SUN_MASS, EARTH_MASS, AU);
    const f0 = state.acc[0] * state.mass[0];
    const f1 = state.acc[3] * state.mass[1];
    expect(f0 + f1).toBeCloseTo(0, 10);
  });

  it('follows the inverse square law', () => {
    const near = pair(SUN_MASS, EARTH_MASS, AU);
    const far = pair(SUN_MASS, EARTH_MASS, 2 * AU);
    expect(near.acc[3] / far.acc[3]).toBeCloseTo(4, 6);
  });

  it('superposes contributions from multiple bodies', () => {
    const state = createState(3);
    state.mass[0] = SUN_MASS;
    state.mass[1] = SUN_MASS;
    state.mass[2] = EARTH_MASS;
    // Two equal masses symmetric about the origin, test mass at the origin.
    state.pos[0] = -AU;
    state.pos[3] = AU;
    computeAccelerations(state);

    // Symmetric pull cancels at the midpoint.
    expect(Math.abs(state.acc[6])).toBeLessThan(1e-20);
    expect(state.acc[7]).toBe(0);
    expect(state.acc[8]).toBe(0);
  });

  it('leaves a single body unaccelerated', () => {
    const state = createState(1);
    state.mass[0] = SUN_MASS;
    computeAccelerations(state);
    expect(Array.from(state.acc)).toEqual([0, 0, 0]);
  });

  it('handles an empty system', () => {
    const state = createState(0);
    expect(() => computeAccelerations(state)).not.toThrow();
  });

  it('zeroes stale accelerations rather than accumulating them', () => {
    const state = pair(SUN_MASS, EARTH_MASS, AU);
    const first = state.acc[0];
    computeAccelerations(state);
    expect(state.acc[0]).toBe(first);
  });
});

describe('softening', () => {
  it('stays finite for coincident bodies', () => {
    const state = createState(2);
    state.mass[0] = SUN_MASS;
    state.mass[1] = EARTH_MASS;
    // Exactly the same position — the unsoftened form would divide by zero.
    computeAccelerations(state);

    for (const a of state.acc) {
      expect(Number.isFinite(a)).toBe(true);
    }
  });

  it('survives a near-pass without producing NaN', () => {
    // Two bodies aimed almost exactly at each other at high speed, integrated
    // straight through the encounter.
    const state = stateFromBodies([
      testBody({
        mass: EARTH_MASS,
        radius: EARTH_RADIUS,
        position: { x: -AU / 100, y: 0, z: 0 },
        velocity: { x: 5e4, y: 0, z: 0 },
      }),
      testBody({
        mass: EARTH_MASS,
        radius: EARTH_RADIUS,
        position: { x: AU / 100, y: 1, z: 0 },
        velocity: { x: -5e4, y: 0, z: 0 },
      }),
    ]);

    for (let s = 0; s < 5000; s++) step(state, 60);

    for (const v of [...state.pos, ...state.vel, ...state.acc]) {
      expect(Number.isNaN(v)).toBe(false);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('conserves momentum through a near-pass', () => {
    const state = stateFromBodies([
      testBody({
        mass: SUN_MASS,
        radius: SUN_RADIUS,
        type: 'star',
        position: { x: -1e9, y: 0, z: 0 },
        velocity: { x: 1e4, y: 0, z: 0 },
      }),
      testBody({
        mass: EARTH_MASS,
        radius: EARTH_RADIUS,
        position: { x: 1e9, y: 100, z: 0 },
        velocity: { x: -1e4, y: 0, z: 0 },
      }),
    ]);

    const p0 = totalMomentum(state);
    for (let s = 0; s < 20000; s++) step(state, 60);
    const p1 = totalMomentum(state);

    const scaleP = SUN_MASS * 1e4;
    expect(Math.abs(p1.x - p0.x) / scaleP).toBeLessThan(1e-12);
    expect(Math.abs(p1.y - p0.y) / scaleP).toBeLessThan(1e-12);
  });

  it('is negligible at planetary separations', () => {
    // Softened vs. analytic unsoftened acceleration at 1 AU: the 1 km epsilon
    // should not show up at even 12 significant figures.
    const state = pair(SUN_MASS, EARTH_MASS, AU);
    const analytic = (G * SUN_MASS) / (AU * AU);
    expect(Math.abs(Math.abs(state.acc[3]) - analytic) / analytic).toBeLessThan(1e-12);
  });
});

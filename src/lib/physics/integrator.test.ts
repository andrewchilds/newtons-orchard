import { describe, expect, it } from 'vitest';
import {
  AU,
  DAY,
  EARTH_MASS,
  EARTH_RADIUS,
  MOON_MASS,
  MOON_ORBIT,
  MOON_RADIUS,
  SUN_MASS,
  SUN_RADIUS,
  YEAR,
} from './constants';
import { circularOrbit, elementsToStateVector } from './kepler';
import { stateFromBodies, step, copyState, type PhysicsState } from './integrator';
import { barycenter, totalEnergy, totalMomentum } from './diagnostics';
import { AT_ORIGIN, testBody } from './testUtils';

const DT = 600; // s — the app's default timestep

/** Sun + Earth on a circular orbit, built about the (moving) Sun at rest. */
function sunEarth(): PhysicsState {
  const earth = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, 0, EARTH_MASS);
  return stateFromBodies([
    testBody({ mass: SUN_MASS, radius: SUN_RADIUS, type: 'star' }),
    testBody({
      mass: EARTH_MASS,
      radius: EARTH_RADIUS,
      position: earth.position,
      velocity: earth.velocity,
    }),
  ]);
}

/** Advance `state` by `steps` steps of `dt`. */
function run(state: PhysicsState, steps: number, dt = DT): void {
  for (let s = 0; s < steps; s++) step(state, dt);
}

describe('velocity Verlet: two-body period', () => {
  it('Earth-Sun period is within 0.1% of a year at dt = 600 s', () => {
    const state = sunEarth();

    // Earth starts on +x moving +y. Detect the completed orbit as the step
    // where y crosses from negative back to positive, then refine the crossing
    // by linear interpolation in y — sub-step resolution, so the measurement
    // isn't quantized to ±600 s.
    let t = 0;
    let prevY = state.pos[4];
    let period = 0;

    const maxSteps = Math.ceil((1.2 * YEAR) / DT);
    for (let s = 0; s < maxSteps; s++) {
      step(state, DT);
      t += DT;
      const y = state.pos[4];
      // Ignore the first few steps so we don't trigger on the start point.
      if (t > 0.5 * YEAR && prevY < 0 && y >= 0) {
        period = t - DT * (y / (y - prevY));
        break;
      }
      prevY = y;
    }

    expect(period).toBeGreaterThan(0);
    const days = period / DAY;
    // Two-body period with μ = G(M☉+M⊕) is ~365.2 d.
    expect(Math.abs(days - 365.25) / 365.25).toBeLessThan(0.001);
  });

  it('keeps the orbital radius nearly constant over a year (circular stays circular)', () => {
    const state = sunEarth();
    let minR = Infinity;
    let maxR = 0;

    const steps = Math.ceil(YEAR / DT);
    for (let s = 0; s < steps; s++) {
      step(state, DT);
      const dx = state.pos[3] - state.pos[0];
      const dy = state.pos[4] - state.pos[1];
      const dz = state.pos[5] - state.pos[2];
      const r = Math.hypot(dx, dy, dz);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }

    expect((maxR - minR) / AU).toBeLessThan(1e-4);
  });
});

describe('velocity Verlet: conservation', () => {
  it('energy drift stays below 1e-8 relative over 10 simulated years', () => {
    const state = sunEarth();
    const e0 = totalEnergy(state);

    let worst = 0;
    const steps = Math.ceil((10 * YEAR) / DT);
    for (let s = 0; s < steps; s++) {
      step(state, DT);
      // Sample rather than measure every step; drift is smooth.
      if (s % 500 === 0) {
        worst = Math.max(worst, Math.abs((totalEnergy(state) - e0) / e0));
      }
    }
    worst = Math.max(worst, Math.abs((totalEnergy(state) - e0) / e0));

    expect(worst).toBeLessThan(1e-8);
  });

  it('energy stays bounded rather than trending (symplectic)', () => {
    // A drifting integrator's error grows with time; a symplectic one
    // oscillates. Compare the worst error in the first year against the tenth.
    const state = sunEarth();
    const e0 = totalEnergy(state);
    const stepsPerYear = Math.ceil(YEAR / DT);

    const relError = (): number => Math.abs((totalEnergy(state) - e0) / e0);

    let firstYearWorst = 0;
    for (let s = 0; s < stepsPerYear; s++) {
      step(state, DT);
      if (s % 100 === 0) firstYearWorst = Math.max(firstYearWorst, relError());
    }

    for (let s = 0; s < 8 * stepsPerYear; s++) step(state, DT);

    let tenthYearWorst = 0;
    for (let s = 0; s < stepsPerYear; s++) {
      step(state, DT);
      if (s % 100 === 0) tenthYearWorst = Math.max(tenthYearWorst, relError());
    }

    // Allow a factor of 3 of slack; a non-symplectic method would be ~10×.
    expect(tenthYearWorst).toBeLessThan(Math.max(firstYearWorst * 3, 1e-12));
  });

  it('conserves total momentum to floating-point noise', () => {
    const state = sunEarth();
    const p0 = totalMomentum(state);
    const scaleP = Math.hypot(p0.x, p0.y, p0.z) || SUN_MASS;

    run(state, 20000);

    const p1 = totalMomentum(state);
    expect(Math.abs(p1.x - p0.x) / scaleP).toBeLessThan(1e-12);
    expect(Math.abs(p1.y - p0.y) / scaleP).toBeLessThan(1e-12);
    expect(Math.abs(p1.z - p0.z) / scaleP).toBeLessThan(1e-12);
  });

  it('moves the barycenter at constant velocity', () => {
    const state = sunEarth();
    const c0 = barycenter(state);
    const v = totalMomentum(state);
    const totalMass = SUN_MASS + EARTH_MASS;

    const steps = 10000;
    run(state, steps);
    const c1 = barycenter(state);
    const elapsed = steps * DT;

    // Expected drift = (P/M)·t.
    expect(c1.x - c0.x).toBeCloseTo((v.x / totalMass) * elapsed, 3);
    expect(c1.y - c0.y).toBeCloseTo((v.y / totalMass) * elapsed, 3);
    expect(c1.z - c0.z).toBeCloseTo((v.z / totalMass) * elapsed, 3);
  });
});

describe('velocity Verlet: determinism', () => {
  it('reproduces an identical trajectory from identical initial state', () => {
    const a = sunEarth();
    const b = sunEarth();

    run(a, 5000);
    run(b, 5000);

    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(Array.from(a.vel)).toEqual(Array.from(b.vel));
  });

  it('a copied state continues identically to the original', () => {
    const a = sunEarth();
    run(a, 1000);

    const b = copyState(a);
    run(a, 1000);
    run(b, 1000);

    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(Array.from(a.vel)).toEqual(Array.from(b.vel));
    expect(Array.from(a.acc)).toEqual(Array.from(b.acc));
  });
});

describe('velocity Verlet: three-body', () => {
  it('Sun-Earth-Moon keeps the Moon bound to Earth for a year', () => {
    const earth = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, 0, EARTH_MASS);
    const moon = circularOrbit(EARTH_MASS, earth, MOON_ORBIT, 5, 0, MOON_MASS);

    const state = stateFromBodies([
      testBody({ mass: SUN_MASS, radius: SUN_RADIUS, type: 'star' }),
      testBody({
        mass: EARTH_MASS,
        radius: EARTH_RADIUS,
        position: earth.position,
        velocity: earth.velocity,
      }),
      testBody({
        mass: MOON_MASS,
        radius: MOON_RADIUS,
        type: 'moon',
        position: moon.position,
        velocity: moon.velocity,
      }),
    ]);

    let minSep = Infinity;
    let maxSep = 0;
    const steps = Math.ceil(YEAR / DT);
    for (let s = 0; s < steps; s++) {
      step(state, DT);
      const dx = state.pos[6] - state.pos[3];
      const dy = state.pos[7] - state.pos[4];
      const dz = state.pos[8] - state.pos[5];
      const sep = Math.hypot(dx, dy, dz);
      minSep = Math.min(minSep, sep);
      maxSep = Math.max(maxSep, sep);
    }

    // Solar tides make the lunar orbit breathe, but it stays clearly bound.
    expect(minSep).toBeGreaterThan(0.9 * MOON_ORBIT);
    expect(maxSep).toBeLessThan(1.1 * MOON_ORBIT);
  });

  it('an eccentric orbit returns to periapsis distance after one period', () => {
    const a = 1.5 * AU;
    const e = 0.5;
    const sv = elementsToStateVector(SUN_MASS, AT_ORIGIN, {
      a,
      e,
      i: 0,
      lan: 0,
      argPeriapsis: 0,
      trueAnomaly: 0, // start at periapsis
    });
    const state = stateFromBodies([
      testBody({ mass: SUN_MASS, radius: SUN_RADIUS, type: 'star' }),
      testBody({ mass: 1e3, radius: 1e3, position: sv.position, velocity: sv.velocity }),
    ]);

    const period = 2 * Math.PI * Math.sqrt((a * a * a) / (6.6743e-11 * SUN_MASS));
    const steps = Math.round(period / DT);

    let maxR = 0;
    let minR = Infinity;
    for (let s = 0; s < steps; s++) {
      step(state, DT);
      const r = Math.hypot(
        state.pos[3] - state.pos[0],
        state.pos[4] - state.pos[1],
        state.pos[5] - state.pos[2]
      );
      maxR = Math.max(maxR, r);
      minR = Math.min(minR, r);
    }

    // Apsides match the analytic values to 0.1%.
    expect(Math.abs(maxR - a * (1 + e)) / (a * (1 + e))).toBeLessThan(1e-3);
    expect(Math.abs(minR - a * (1 - e)) / (a * (1 - e))).toBeLessThan(1e-3);
  });
});

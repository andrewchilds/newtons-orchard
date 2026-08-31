import { describe, expect, it } from 'vitest';
import { AU, DAY, EARTH_MASS, MOON_MASS, MOON_ORBIT, SUN_MASS, YEAR } from '../physics/constants';
import { circularOrbit, orbitalPeriod } from '../physics/kepler';
import { AT_ORIGIN, testBody } from '../physics/testUtils';
import { stateFromBodies } from '../physics/integrator';
import { Simulation } from './simulation';
import { MAX_PREDICTION_STEPS, predictionDt, predictionHorizon, predictPath } from './predictPath';
import type { Body } from '../types';

/** Sun + Earth on a circular 1 AU orbit. */
function sunEarth(): Body[] {
  const earth = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, 0, EARTH_MASS);
  return [
    testBody({ mass: SUN_MASS, radius: 6.957e8, type: 'star' }),
    testBody({
      mass: EARTH_MASS,
      radius: 6.371e6,
      position: earth.position,
      velocity: earth.velocity,
    }),
  ];
}

describe('predictPath', () => {
  it('starts at the body’s current position', () => {
    const bodies = sunEarth();
    const state = stateFromBodies(bodies);
    const path = predictPath(state, 1, { horizon: YEAR, dt: 600 });

    // Points are Float32 (they feed a GPU buffer), so ~7 significant digits is
    // all that survives; compare relative to AU rather than in raw meters.
    expect(path[0] / AU).toBeCloseTo(bodies[1].position.x / AU, 6);
    expect(path[1] / AU).toBeCloseTo(bodies[1].position.y / AU, 6);
    expect(path[2] / AU).toBeCloseTo(bodies[1].position.z / AU, 6);
  });

  it('closes the loop after one full period', () => {
    const state = stateFromBodies(sunEarth());
    const period = orbitalPeriod(AU, SUN_MASS, EARTH_MASS);
    const path = predictPath(state, 1, { horizon: period, dt: 600 });

    const n = path.length / 3;
    const startX = path[0];
    const startY = path[1];
    const endX = path[(n - 1) * 3];
    const endY = path[(n - 1) * 3 + 1];

    // The last sample lands within a fraction of a percent of the first — the
    // path is a closed ellipse, which is what makes it read as an orbit.
    const gap = Math.hypot(endX - startX, endY - startY);
    expect(gap / AU).toBeLessThan(0.02);
  });

  it('stays on the orbital radius throughout a circular orbit', () => {
    const state = stateFromBodies(sunEarth());
    const path = predictPath(state, 1, { horizon: YEAR, dt: 600 });

    for (let i = 0; i < path.length / 3; i++) {
      const r = Math.hypot(path[i * 3], path[i * 3 + 1], path[i * 3 + 2]);
      expect(r / AU).toBeCloseTo(1, 2);
    }
  });

  it('does not mutate the state it was given', () => {
    const state = stateFromBodies(sunEarth());
    const posBefore = state.pos.slice();
    const velBefore = state.vel.slice();

    predictPath(state, 1, { horizon: YEAR, dt: 600 });

    expect(Array.from(state.pos)).toEqual(Array.from(posBefore));
    expect(Array.from(state.vel)).toEqual(Array.from(velBefore));
  });

  it('overlays the trajectory the simulation actually takes', () => {
    // The acceptance criterion from GUIDE.md: predict, then play forward and
    // check the sim went where the prediction said.
    const bodies = sunEarth();
    const sim = new Simulation(bodies, { dt: 600 });
    const period = orbitalPeriod(AU, SUN_MASS, EARTH_MASS);

    const path = predictPath(sim.state, 1, { horizon: period, dt: sim.dt, samples: 5 });

    // Sample 2 of 5 sits at 2/4 of the horizon.
    const stepsPerSample = Math.floor(Math.round(period / sim.dt) / 4);
    sim.advanceTo(stepsPerSample * 2 * sim.dt, Infinity);

    const actual = sim.positionOf(bodies[1].id)!;
    const predictedX = path[2 * 3];
    const predictedY = path[2 * 3 + 1];

    expect(predictedX / AU).toBeCloseTo(actual.x / AU, 6);
    expect(predictedY / AU).toBeCloseTo(actual.y / AU, 6);
  });

  it('draws a moon’s path as a closed ellipse in its planet’s frame', () => {
    // In the inertial frame this is a helix around the Sun; relative to Earth
    // it must close. This is the same index-alignment idea as trails.
    const earth = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, 0, EARTH_MASS);
    const moon = circularOrbit(EARTH_MASS, earth, MOON_ORBIT, 0, 0, MOON_MASS);
    const state = stateFromBodies([
      testBody({ mass: SUN_MASS, radius: 6.957e8, type: 'star' }),
      testBody({ mass: EARTH_MASS, radius: 6.371e6, ...earth }),
      testBody({ mass: MOON_MASS, radius: 1.7374e6, ...moon }),
    ]);

    const month = orbitalPeriod(MOON_ORBIT, EARTH_MASS, MOON_MASS);
    const path = predictPath(state, 2, {
      horizon: month,
      dt: 600,
      referenceIndex: 1,
    });

    // Every point sits at roughly the lunar distance from Earth.
    for (let i = 0; i < path.length / 3; i++) {
      const r = Math.hypot(path[i * 3], path[i * 3 + 1], path[i * 3 + 2]);
      expect(r / MOON_ORBIT).toBeCloseTo(1, 1);
    }
  });

  it('applies the scene scale', () => {
    const state = stateFromBodies(sunEarth());
    const raw = predictPath(state, 1, { horizon: YEAR, dt: 600, samples: 8 });
    const scaled = predictPath(state, 1, { horizon: YEAR, dt: 600, samples: 8, scale: 1e9 });

    for (let i = 0; i < raw.length; i++) {
      // Float32 again: compare as a ratio, not an absolute difference.
      if (Math.abs(raw[i]) < 1e3) continue;
      expect(scaled[i] / (raw[i] / 1e9)).toBeCloseTo(1, 5);
    }
  });

  it('returns nothing for degenerate requests', () => {
    const state = stateFromBodies(sunEarth());
    expect(predictPath(state, 1, { horizon: 0, dt: 600 })).toHaveLength(0);
    expect(predictPath(state, 1, { horizon: YEAR, dt: 0 })).toHaveLength(0);
    expect(predictPath(state, 9, { horizon: YEAR, dt: 600 })).toHaveLength(0);
    expect(predictPath(state, -1, { horizon: YEAR, dt: 600 })).toHaveLength(0);
  });

  it('never records more points than it takes steps', () => {
    const state = stateFromBodies(sunEarth());
    // Horizon of 3 steps but 240 samples requested.
    const path = predictPath(state, 1, { horizon: 1800, dt: 600, samples: 240 });
    expect(path.length / 3).toBeLessThanOrEqual(4);
  });
});

describe('predictionDt', () => {
  it('keeps the sim dt while the horizon fits the step budget', () => {
    expect(predictionDt(DAY, 600)).toBe(600);
    expect(predictionDt(MAX_PREDICTION_STEPS * 600, 600)).toBe(600);
  });

  it('coarsens in whole multiples of the sim dt beyond the budget', () => {
    const horizon = 250 * YEAR;
    const dt = predictionDt(horizon, 600);
    expect(dt % 600).toBe(0);
    expect(dt).toBeGreaterThan(600);
    expect(horizon / dt).toBeLessThanOrEqual(MAX_PREDICTION_STEPS);
  });

  it('keeps the step count near the budget rather than far under it', () => {
    // The ceiling on the multiple can at worst halve the step count (multiple
    // 2 when 1.01 was needed); it must not collapse a long horizon into a
    // handful of steps.
    const horizon = 250 * YEAR;
    const dt = predictionDt(horizon, 600);
    expect(horizon / dt).toBeGreaterThan(MAX_PREDICTION_STEPS / 2);
  });

  it('still closes an orbit at the coarsened dt', () => {
    // The whole premise of coarsening: a display path at horizon/20k steps is
    // indistinguishable from one at the sim's dt. One Earth year at the dt a
    // 250-year horizon would pick (~4400 s) must still close the ellipse.
    const state = stateFromBodies(sunEarth());
    const period = orbitalPeriod(AU, SUN_MASS, EARTH_MASS);
    const dt = predictionDt(250 * YEAR, 600);
    const path = predictPath(state, 1, { horizon: period, dt });

    const n = path.length / 3;
    const gap = Math.hypot(path[(n - 1) * 3] - path[0], path[(n - 1) * 3 + 1] - path[1]);
    expect(gap / AU).toBeLessThan(0.02);

    for (let i = 0; i < n; i++) {
      const r = Math.hypot(path[i * 3], path[i * 3 + 1], path[i * 3 + 2]);
      expect(r / AU).toBeCloseTo(1, 2);
    }
  });
});

describe('predictionHorizon', () => {
  it('uses one orbital period when the orbit is bound', () => {
    expect(predictionHorizon(YEAR, DAY)).toBe(YEAR);
  });

  it('falls back when there is no period (unbound orbit)', () => {
    expect(predictionHorizon(null, 30 * DAY)).toBe(30 * DAY);
    expect(predictionHorizon(Infinity, 30 * DAY)).toBe(30 * DAY);
    expect(predictionHorizon(-5, 30 * DAY)).toBe(30 * DAY);
  });

  it('clamps to the maximum horizon so a distant body stays affordable', () => {
    expect(predictionHorizon(400 * YEAR, DAY, 10 * YEAR)).toBe(10 * YEAR);
  });
});

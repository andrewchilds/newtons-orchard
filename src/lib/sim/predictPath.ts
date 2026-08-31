// Forward-prediction of a single body's path: integrate a throwaway clone of
// the whole system and record where the chosen body goes. The clone is the
// point — predicting must never perturb the timeline the user is watching.
//
// N-body, not a Kepler ellipse, so precession and perturbation show up.

import { copyState, step, type PhysicsState } from '../physics/integrator';

export interface PredictOptions {
  /** how far forward to integrate, seconds */
  horizon: number;
  /** integrator timestep, seconds — the sim's own dt */
  dt: number;
  /** how many points to record along the path */
  samples?: number;
  /** divide positions by this (scene units) before returning */
  scale?: number;
  /**
   * Body the path is drawn relative to, or null for the inertial frame.
   * Subtracting inside the integration is what makes a moon's predicted path a
   * closed ellipse in its planet's frame.
   */
  referenceIndex?: number | null;
}

export const DEFAULT_SAMPLES = 240;

/**
 * Cap on integration steps for one predicted path. The prediction is
 * display-only, so unlike the sim it may trade accuracy for cost. The horizon
 * is at most one orbit, so this is a steps-per-orbit floor: 20k stays smooth
 * through periapsis while bounding a recompute to a few milliseconds.
 */
export const MAX_PREDICTION_STEPS = 20_000;

/**
 * The sim's own dt while the horizon is affordable, coarsened in whole
 * multiples of it beyond that so the step count never exceeds `maxSteps`.
 * Whole multiples keep a short-horizon prediction on the sim's own grid, where
 * it matches the future bit for bit.
 *
 * The coarse dt under-resolves bodies with shorter periods than the drawn one,
 * but the integrator is symplectic so their orbits stay bounded, and their
 * perturbation is below what a drawn line can show.
 */
export function predictionDt(
  horizon: number,
  simDt: number,
  maxSteps = MAX_PREDICTION_STEPS
): number {
  if (!(horizon > 0) || !(simDt > 0)) return simDt;
  return simDt * Math.max(1, Math.ceil(horizon / (maxSteps * simDt)));
}

/**
 * Integrate `state` forward and return body `bodyIndex`'s path as
 * xyz-interleaved points, oldest → newest, starting at the current position.
 *
 * The result is Float32 because it feeds a GPU buffer directly (~10 km of
 * rounding at 1 AU): fine for a drawn line, useless as a physics quantity. The
 * integration itself runs in the float64 clone; only the sampled output is
 * narrowed. Empty array when the request is degenerate.
 */
export function predictPath(
  state: PhysicsState,
  bodyIndex: number,
  options: PredictOptions
): Float32Array {
  const { horizon, dt } = options;
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const scale = options.scale ?? 1;
  const referenceIndex = options.referenceIndex ?? null;

  if (!(horizon > 0) || !(dt > 0) || bodyIndex < 0 || bodyIndex >= state.n || samples < 2) {
    return new Float32Array(0);
  }

  const totalSteps = Math.max(1, Math.round(horizon / dt));
  const pointCount = Math.min(samples, totalSteps + 1);
  const stepsPerSample = Math.max(1, Math.floor(totalSteps / (pointCount - 1)));

  const clone = copyState(state);
  const out = new Float32Array(pointCount * 3);

  const write = (slot: number) => {
    const b3 = bodyIndex * 3;
    const o = slot * 3;
    let x = clone.pos[b3];
    let y = clone.pos[b3 + 1];
    let z = clone.pos[b3 + 2];

    if (referenceIndex !== null && referenceIndex >= 0 && referenceIndex < clone.n) {
      const r3 = referenceIndex * 3;
      x -= clone.pos[r3];
      y -= clone.pos[r3 + 1];
      z -= clone.pos[r3 + 2];
    }

    out[o] = x / scale;
    out[o + 1] = y / scale;
    out[o + 2] = z / scale;
  };

  write(0);

  for (let slot = 1; slot < pointCount; slot++) {
    for (let k = 0; k < stepsPerSample; k++) step(clone, dt);
    write(slot);
  }

  return out;
}

/**
 * How far forward to predict: one orbital period when bound, clamped to
 * `maxHorizon`. An unbound or unknown orbit has no period, so it falls back to
 * `fallback` and the path reads as "where it's heading" rather than a loop.
 */
export function predictionHorizon(
  period: number | null,
  fallback: number,
  maxHorizon = Infinity
): number {
  const horizon = period !== null && Number.isFinite(period) && period > 0 ? period : fallback;
  return Math.min(horizon, maxHorizon);
}

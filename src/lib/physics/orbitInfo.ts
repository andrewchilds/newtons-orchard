// Display-oriented quantities read off a body's *current* state vector: speed,
// distance to a parent, orbital period, apsides.
//
// Nothing is integrated or accumulated — every value is a pure function of the
// instantaneous state, which is what makes the info panel scrub-safe.
//
// Pure TS: no Svelte, no Three.js (GUIDE.md — Conventions).

import { orbitalPeriod, stateVectorToElements, type StateVector } from './kepler';

/**
 * Orbit summary for a body relative to a chosen parent.
 *
 * `bound` is false for parabolic/hyperbolic orbits (e ≥ 1, a ≤ 0), where
 * `period` and `apoapsis` are null but `periapsis` still means something: even
 * an escaping body has a closest approach.
 */
export interface OrbitSummary {
  /** true when the orbit is elliptical (e < 1 and a > 0) */
  bound: boolean;
  /** semi-major axis, m; negative for hyperbolic orbits */
  semiMajorAxis: number;
  eccentricity: number;
  /** degrees */
  inclination: number;
  /** seconds; null when unbound */
  period: number | null;
  /** m; null when unbound */
  apoapsis: number | null;
  /** m */
  periapsis: number;
  /** current separation from the parent, m */
  distance: number;
  /** current speed relative to the parent, m/s */
  relativeSpeed: number;
}

/**
 * Orbital elements and apsides for `body` relative to `parent`.
 *
 * μ = G(M + m), matching `kepler.ts` and the sim: the satellite's own mass is
 * not negligible for a moon or a binary, and dropping it measurably shifts the
 * period.
 */
export function summarizeOrbit(
  parentMass: number,
  parent: StateVector,
  body: StateVector,
  bodyMass = 0
): OrbitSummary {
  const elements = stateVectorToElements(parentMass, parent, body, bodyMass);
  const { a, e } = elements;

  const dx = body.position.x - parent.position.x;
  const dy = body.position.y - parent.position.y;
  const dz = body.position.z - parent.position.z;
  const dvx = body.velocity.x - parent.velocity.x;
  const dvy = body.velocity.y - parent.velocity.y;
  const dvz = body.velocity.z - parent.velocity.z;

  const distance = Math.hypot(dx, dy, dz);
  const relativeSpeed = Math.hypot(dvx, dvy, dvz);

  const bound = e < 1 && a > 0 && Number.isFinite(a);

  return {
    bound,
    semiMajorAxis: a,
    eccentricity: e,
    inclination: elements.i,
    period: bound ? orbitalPeriod(a, parentMass, bodyMass) : null,
    apoapsis: bound ? a * (1 + e) : null,
    // r_p = a(1 − e) holds for hyperbolas too, where a < 0 and e > 1 make the
    // product positive again.
    periapsis: a * (1 - e),
    relativeSpeed,
    distance,
  };
}

/**
 * Which body `bodyIndex` should be considered to orbit.
 *
 * "Parent" isn't stored in the data model — users place bodies anywhere and
 * merges rewrite the roster — so it has to be inferred.
 *
 * Not strongest instantaneous pull GM/r²: that gets the case that matters most
 * wrong, since the Sun pulls on the Moon about twice as hard as Earth does.
 * (Real, not an artifact — Earth dominates only the *differential* pull.)
 *
 * Instead, sphere of influence: body j's SOI has radius r_j·(m_j/M_j)^{2/5},
 * r_j being j's distance from its own primary. Candidates are ranked by
 * distance in units of their SOI and the deepest nesting wins, putting the Moon
 * under Earth and Earth under the Sun. Candidates must out-mass this body, so a
 * planet is never reported as orbiting its own moon.
 *
 * Returns null when there is no more massive body.
 */
export function dominantAttractor(
  bodyIndex: number,
  mass: ArrayLike<number>,
  pos: ArrayLike<number>,
  n: number
): number | null {
  const i3 = bodyIndex * 3;
  return attractorAt(pos[i3], pos[i3 + 1], pos[i3 + 2], mass, pos, n, mass[bodyIndex], bodyIndex);
}

/**
 * `dominantAttractor` for a point in empty space — which body would a new body
 * placed at (x, y, z) orbit?
 *
 * `candidateMinMass` plays the role the existing body's own mass plays above:
 * candidates must out-mass the body being placed. Pass 0 to accept any body.
 */
export function dominantAttractorAtPoint(
  x: number,
  y: number,
  z: number,
  mass: ArrayLike<number>,
  pos: ArrayLike<number>,
  n: number,
  candidateMinMass = 0
): number | null {
  return attractorAt(x, y, z, mass, pos, n, candidateMinMass, -1);
}

/** Shared SOI ranking for `dominantAttractor`/`dominantAttractorAtPoint`. */
function attractorAt(
  x: number,
  y: number,
  z: number,
  mass: ArrayLike<number>,
  pos: ArrayLike<number>,
  n: number,
  candidateMinMass: number,
  excludeIndex: number
): number | null {
  if (n === 0) return null;

  // The most massive body is the reference primary for everyone else's SOI.
  let primary = 0;
  for (let j = 1; j < n; j++) if (mass[j] > mass[primary]) primary = j;

  let best: number | null = null;
  let bestRatio = Infinity;

  for (let j = 0; j < n; j++) {
    if (j === excludeIndex) continue;
    if (mass[j] <= candidateMinMass) continue;

    const j3 = j * 3;
    const distance = Math.hypot(pos[j3] - x, pos[j3 + 1] - y, pos[j3 + 2] - z);
    if (distance === 0) continue;

    let ratio: number;
    if (j === primary) {
      // The primary is the fallback parent: ranked worse than any body whose
      // SOI actually contains us.
      ratio = 1 + distance / soiRadius(mass, pos, j, primary);
    } else {
      ratio = distance / soiRadius(mass, pos, j, primary);
    }

    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = j;
    }
  }

  return best;
}

function separation(pos: ArrayLike<number>, a: number, b: number): number {
  const a3 = a * 3;
  const b3 = b * 3;
  return Math.hypot(pos[b3] - pos[a3], pos[b3 + 1] - pos[a3 + 1], pos[b3 + 2] - pos[a3 + 2]);
}

/**
 * Radius of body `j`'s sphere of influence about the system primary,
 * r·(m/M)^{2/5}. Unbounded for the primary itself; callers handle that case.
 */
export function soiRadius(
  mass: ArrayLike<number>,
  pos: ArrayLike<number>,
  j: number,
  primary: number
): number {
  if (j === primary) return Infinity;
  const r = separation(pos, j, primary);
  if (r === 0) return Infinity;
  return r * (mass[j] / mass[primary]) ** 0.4;
}

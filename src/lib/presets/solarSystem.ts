// The real solar system: Sun, eight planets, Earth's Moon, and the five
// best-known dwarf planets — Ceres, Pluto, Haumea, Makemake and Eris.
//
// Positions and velocities come from J2000 mean orbital elements through
// `kepler.ts`. Mean elements, not an ephemeris: the planets will not be where a
// telescope says they are on a given date, but the orbits' shapes, sizes,
// inclinations and periods are right, which is what this sim is for.
//
// Two details that matter and aren't obvious:
//
//   * **The Sun gets a recoil velocity, not a zero one.** Elements are defined
//     relative to the Sun, so building every planet off a stationary Sun leaves
//     the system with the planets' total momentum and no counterweight — the
//     whole solar system then drifts out of frame at ~12 m/s (Jupiter alone
//     carries 2e29 kg·m/s). `balanceMomentum` puts that momentum back into the
//     star, which is the physical truth: the Sun orbits the barycenter too.
//   * **The Moon is placed relative to Earth**, after Earth is placed, so its
//     state is Earth's plus a lunar orbit. Its μ uses G(M_earth + M_moon) —
//     the Moon is 1.2% of Earth, enough to shift the period by half a percent.

import {
  AU,
  DAY,
  EARTH_MASS,
  EARTH_RADIUS,
  HOUR,
  MOON_MASS,
  MOON_ORBIT,
  MOON_RADIUS,
  SUN_MASS,
  SUN_RADIUS,
  YEAR,
} from '../physics/constants';
import { elementsToStateVector, type OrbitalElements, type StateVector } from '../physics/kepler';
import { vec3, type Vec3 } from '../physics/vec3';
import type { Body, BodyType, RealTextureKey } from '../types';

interface PlanetSpec {
  name: string;
  type: BodyType;
  color: string;
  /** photographic map — the planets have one, the dwarfs don't */
  texture?: RealTextureKey;
  mass: number; // kg
  radius: number; // m (equatorial)
  rotationPeriod: number; // s — negative is retrograde
  axialTilt: number; // degrees
  elements: OrbitalElements;
  atmosphere?: Body['atmosphere'];
  rings?: Body['rings'];
}

/**
 * J2000 mean elements. `trueAnomaly` here is seeded from each planet's mean
 * anomaly at J2000 rather than solved through Kepler's equation — for a nearly
 * circular orbit the two differ by ~2e (a couple of degrees for most planets),
 * which only rotates the starting phase and leaves every orbit's geometry and
 * period exact. Mercury, Pluto and Eris are the eccentric outliers and are the
 * only ones where the starting angle is visibly off; nothing downstream depends
 * on it.
 *
 * The dwarf planets carry *osculating* elements at J2000, not the secular mean
 * elements the planets use: a small body deep in Neptune's or Jupiter's
 * perturbations has no meaningful mean element set, and the osculating ones are
 * what the minor-planet tables actually publish.
 */
const PLANETS: PlanetSpec[] = [
  {
    name: 'Mercury',
    type: 'rocky',
    color: '#9c8b7d',
    texture: 'mercury',
    mass: 3.3011e23,
    radius: 2.4397e6,
    rotationPeriod: 58.646 * DAY,
    axialTilt: 0.034,
    elements: { a: 0.38709927 * AU, e: 0.20563593, i: 7.00497902, lan: 48.33076593, argPeriapsis: 29.12703035, trueAnomaly: 174.79252722 },
  },
  {
    name: 'Venus',
    type: 'rocky',
    color: '#d9b98a',
    texture: 'venus',
    mass: 4.8675e24,
    radius: 6.0518e6,
    // Retrograde: Venus turns backwards, and slowly. The negative sign is the
    // data model's convention for that.
    rotationPeriod: -243.025 * DAY,
    axialTilt: 177.36,
    elements: { a: 0.72333566 * AU, e: 0.00677672, i: 3.39467605, lan: 76.67984255, argPeriapsis: 54.92262463, trueAnomaly: 50.11530112 },
    // Dense enough to close the cloud deck — Venus's ground is never visible.
    atmosphere: { color: '#f0d9a8', density: 0.9 },
  },
  {
    name: 'Earth',
    type: 'earthlike',
    color: '#4a7edb',
    texture: 'earth',
    mass: EARTH_MASS,
    radius: EARTH_RADIUS,
    rotationPeriod: 86164.1, // sidereal day, not 86400
    axialTilt: 23.4393,
    elements: { a: 1.00000261 * AU, e: 0.01671123, i: -0.00001531, lan: 0, argPeriapsis: 102.93768193, trueAnomaly: 100.46457166 },
    atmosphere: { color: '#7fb2ff', density: 0.2 },
  },
  {
    name: 'Mars',
    type: 'rocky',
    color: '#c1440e',
    texture: 'mars',
    mass: 6.4171e23,
    radius: 3.3895e6,
    rotationPeriod: 88642.7,
    axialTilt: 25.19,
    elements: { a: 1.52371034 * AU, e: 0.0933941, i: 1.84969142, lan: 49.55953891, argPeriapsis: 286.4968315, trueAnomaly: 355.44656795 },
    atmosphere: { color: '#e8a878', density: 0.12 },
  },
  {
    // The one dwarf planet inside Neptune's orbit, and the only body in the
    // asteroid belt big enough to be round.
    name: 'Ceres',
    type: 'dwarf',
    color: '#9c9791',
    texture: 'ceres',
    mass: 9.3835e20,
    radius: 4.696e5,
    rotationPeriod: 9.074 * HOUR,
    axialTilt: 4,
    elements: { a: 2.7658 * AU, e: 0.078, i: 10.5867, lan: 80.3293, argPeriapsis: 73.5977, trueAnomaly: 95.9892 },
  },
  {
    name: 'Jupiter',
    type: 'gas',
    color: '#d8a878',
    texture: 'jupiter',
    mass: 1.8982e27,
    radius: 7.1492e7,
    rotationPeriod: 9.925 * HOUR,
    axialTilt: 3.13,
    elements: { a: 5.202887 * AU, e: 0.04838624, i: 1.30439695, lan: 100.47390909, argPeriapsis: 273.86740703, trueAnomaly: 34.39644051 },
    // No rim glow on the gas giants. The visible disk already *is* the cloud
    // tops, and an additive limb reads as a force field over the banding the
    // texture works hard to sell — which is what people picture for these two.
  },
  {
    name: 'Saturn',
    type: 'gas',
    color: '#e3d3a0',
    texture: 'saturn',
    mass: 5.6834e26,
    radius: 6.0268e7,
    rotationPeriod: 10.656 * HOUR,
    axialTilt: 26.73,
    elements: { a: 9.53667594 * AU, e: 0.05386179, i: 2.48599187, lan: 113.66242448, argPeriapsis: 339.39216586, trueAnomaly: 49.95424423 },
    // See Jupiter: no rim glow. On Saturn it also competed with the rings.
    // Real ring span: the C ring's inner edge (~1.11 R) out to the A ring's
    // outer edge (~2.27 R). Rendered through the same exaggeration as radii.
    rings: { innerRadius: 6.7e7, outerRadius: 1.3665e8, color: '#d9c9a3', opacity: 0.62 },
  },
  {
    name: 'Uranus',
    type: 'ice',
    color: '#93d7e8',
    texture: 'uranus',
    mass: 8.681e25,
    radius: 2.5559e7,
    // Also retrograde, and tipped on its side — the 97.77° tilt is the headline
    // fact about Uranus and should be visible in the scene.
    rotationPeriod: -17.24 * HOUR,
    axialTilt: 97.77,
    elements: { a: 19.18916464 * AU, e: 0.04725744, i: 0.77263783, lan: 74.01692503, argPeriapsis: 96.99885295, trueAnomaly: 313.23810451 },
    atmosphere: { color: '#b8ecf7', density: 0.45 },
  },
  {
    name: 'Neptune',
    type: 'ice',
    color: '#4166c4',
    texture: 'neptune',
    mass: 1.02413e26,
    radius: 2.4764e7,
    rotationPeriod: 16.11 * HOUR,
    axialTilt: 28.32,
    elements: { a: 30.06992276 * AU, e: 0.00859048, i: 1.77004347, lan: 131.78422574, argPeriapsis: 276.33648905, trueAnomaly: 304.87997031 },
    atmosphere: { color: '#7f9ff0', density: 0.45 },
  },
  {
    name: 'Pluto',
    type: 'dwarf',
    color: '#c4a68a',
    mass: 1.303e22,
    radius: 1.1883e6,
    rotationPeriod: -6.3872 * DAY,
    axialTilt: 122.53,
    elements: { a: 39.48211675 * AU, e: 0.2488273, i: 17.14001206, lan: 110.30393684, argPeriapsis: 113.76329943, trueAnomaly: 238.92903833 },
  },
  {
    // The fastest-spinning large body in the solar system: a 3.9-hour day has
    // pulled it into a triaxial ellipsoid ~2100 × 1680 × 1074 km. `radius` is
    // the volume-equivalent mean, since the renderer draws spheres.
    name: 'Haumea',
    type: 'dwarf',
    color: '#ded9d2',
    mass: 4.006e21,
    radius: 7.98e5,
    rotationPeriod: 3.9155 * HOUR,
    axialTilt: 126,
    elements: { a: 43.116 * AU, e: 0.19489, i: 28.2137, lan: 122.167, argPeriapsis: 239.041, trueAnomaly: 217.774 },
  },
  {
    name: 'Makemake',
    type: 'dwarf',
    color: '#b5765a',
    mass: 3.1e21,
    radius: 7.15e5,
    rotationPeriod: 22.8266 * HOUR,
    axialTilt: 0,
    elements: { a: 45.43 * AU, e: 0.16126, i: 28.9835, lan: 79.62, argPeriapsis: 294.834, trueAnomaly: 156.735 },
  },
  {
    // The most massive dwarf planet — 27% heavier than Pluto, and the discovery
    // that cost Pluto its planethood. Its 44° inclination and 0.44 eccentricity
    // are the two most extreme in this roster: the orbit is visibly tilted out
    // of the ecliptic and runs from 38 AU to 97 AU.
    name: 'Eris',
    type: 'dwarf',
    color: '#d8d4cc',
    mass: 1.6466e22,
    radius: 1.163e6,
    rotationPeriod: 15.786 * DAY,
    axialTilt: 78,
    elements: { a: 67.864 * AU, e: 0.43607, i: 44.0402, lan: 35.9276, argPeriapsis: 151.639, trueAnomaly: 208.407 },
  },
];

/** The Sun's own definition; its state is filled in by momentum balancing. */
const SUN: Omit<PlanetSpec, 'elements'> = {
  name: 'Sun',
  type: 'star',
  color: '#ffd27f',
  mass: SUN_MASS,
  radius: SUN_RADIUS,
  rotationPeriod: 25.38 * DAY,
  axialTilt: 7.25,
};

/** Earth's Moon, placed relative to Earth rather than the Sun. */
const MOON_ELEMENTS: OrbitalElements = {
  a: MOON_ORBIT,
  e: 0.0549,
  // Inclination to the ecliptic (5.15°), not to Earth's equator — the rest of
  // the system is built in the ecliptic plane, so this is the consistent one.
  i: 5.145,
  lan: 125.08,
  argPeriapsis: 318.15,
  trueAnomaly: 135.27,
};

/**
 * The Sun is created at the origin at rest, every other body is placed against
 * it, and the Sun's velocity is then set to cancel the total momentum so the
 * barycenter stays put.
 */
export function solarSystem(): Body[] {
  const sunState: StateVector = { position: vec3(), velocity: vec3() };

  const sun: Body = {
    id: crypto.randomUUID(),
    name: SUN.name,
    color: SUN.color,
    type: SUN.type,
    mass: SUN.mass,
    radius: SUN.radius,
    rotationPeriod: SUN.rotationPeriod,
    axialTilt: SUN.axialTilt,
    position: sunState.position,
    velocity: sunState.velocity,
  };

  const bodies: Body[] = [sun];
  let earthState: StateVector | null = null;

  for (const spec of PLANETS) {
    // μ = G(M_sun + m_planet): Jupiter is a thousandth of the Sun, which moves
    // its period by ~0.05% — small, but the period test checks to ±2% and this
    // is free correctness.
    const state = elementsToStateVector(SUN_MASS, sunState, spec.elements, spec.mass);
    bodies.push(bodyFromSpec(spec, state));
    if (spec.name === 'Earth') earthState = state;
  }

  if (earthState) {
    const moonState = elementsToStateVector(EARTH_MASS, earthState, MOON_ELEMENTS, MOON_MASS);
    bodies.push({
      id: crypto.randomUUID(),
      name: 'Moon',
      color: '#c8c6c0',
      type: 'moon',
      texture: 'moon',
      mass: MOON_MASS,
      radius: MOON_RADIUS,
      // Tidally locked: one rotation per orbit. The *period* only keeps the
      // facing steady; which face that is comes from the phase, aimed at Earth
      // from wherever the elements put the Moon at t = 0.
      //
      // 27.0738 d, not the catalog sidereal month (27.321661 d). The lock has
      // to match the month the sim *integrates*, and under the Sun's
      // perturbation these osculating elements produce a mean motion ~0.9% off
      // the catalog figure — with the catalog period the locked face walked
      // around Earth at ~44°/yr. Measured in the real `Simulation` at the
      // production 600 s dt: least-squares slope of the unwrapped Earth→Moon
      // azimuth over 20 years (a 10-year fit agrees to 1 s). The rate is
      // *phase-dependent* — a preset that re-places the Moon along its orbit
      // gets a different mean month and must re-measure, not just re-aim
      // (see `artemisII`).
      rotationPeriod: 2339178,
      rotationPhase: lockedFacing(moonState.position, earthState.position),
      axialTilt: 6.68,
      position: moonState.position,
      velocity: moonState.velocity,
    });
  }

  balanceMomentum(bodies, 0);
  return bodies;
}

function bodyFromSpec(spec: PlanetSpec, state: StateVector): Body {
  return {
    id: crypto.randomUUID(),
    name: spec.name,
    color: spec.color,
    type: spec.type,
    texture: spec.texture,
    mass: spec.mass,
    radius: spec.radius,
    rotationPeriod: spec.rotationPeriod,
    axialTilt: spec.axialTilt,
    position: state.position,
    velocity: state.velocity,
    atmosphere: spec.atmosphere ? { ...spec.atmosphere } : undefined,
    rings: spec.rings ? { ...spec.rings } : undefined,
  };
}

/**
 * Spin phase (degrees) that points a tidally locked body's near side at its
 * parent at t = 0. The texture's central meridian faces the zero-spin azimuth
 * (+x), so the phase is simply the body→parent azimuth in the orbital plane.
 *
 * Exported for presets that re-place the Moon on its orbit: the phase is a
 * function of where the body *is*, so moving it means re-aiming it.
 */
export function lockedFacing(body: Vec3, parent: Vec3): number {
  return (Math.atan2(parent.y - body.y, parent.x - body.x) * 180) / Math.PI;
}

/**
 * Give body `anchorIndex` whatever velocity makes the system's total momentum
 * zero, so the barycenter doesn't drift.
 *
 * Elements are always expressed relative to a parent, so any system built this
 * way has a net momentum equal to the sum of the satellites'. Left alone, the
 * whole system translates — over a century of sim time the solar system walks
 * ~40 AU out of the default camera framing, which reads as a bug.
 *
 * Exported because every preset built from elements needs it.
 */
export function balanceMomentum(bodies: Body[], anchorIndex = 0): void {
  const anchor = bodies[anchorIndex];
  if (!anchor) return;

  let px = 0;
  let py = 0;
  let pz = 0;

  for (let i = 0; i < bodies.length; i++) {
    if (i === anchorIndex) continue;
    const b = bodies[i];
    px += b.mass * b.velocity.x;
    py += b.mass * b.velocity.y;
    pz += b.mass * b.velocity.z;
  }

  anchor.velocity = vec3(-px / anchor.mass, -py / anchor.mass, -pz / anchor.mass);
}

/** Expected sidereal periods, seconds — used by the preset's period test. */
export const KNOWN_PERIODS: Record<string, number> = {
  Mercury: 87.969 * DAY,
  Venus: 224.701 * DAY,
  Earth: 365.256 * DAY,
  Mars: 686.98 * DAY,
  Jupiter: 11.862 * YEAR,
  Saturn: 29.457 * YEAR,
  Uranus: 84.021 * YEAR,
  Neptune: 164.79 * YEAR,
  Ceres: 4.604 * YEAR,
  Pluto: 247.94 * YEAR,
  Haumea: 283.12 * YEAR,
  Makemake: 306.21 * YEAR,
  Eris: 559.07 * YEAR,
};

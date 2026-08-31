// Many-body presets. These exist to stress the UI at the sim's design target
// (~100 bodies): roster length, label/picking density, trail rebuilds, and the
// O(n²) force loop at high warp.
//
// Every builder draws from a seeded PRNG, so a preset builds the identical
// system on every load — tests can assert against the output, and reloading a
// preset puts the same sky on screen rather than a fresh roll of the dice.

import { AU, DAY, EARTH_MASS, HOUR, SUN_MASS, SUN_RADIUS } from '../physics/constants';
import {
  circularOrbit,
  elementsToStateVector,
  type StateVector,
} from '../physics/kepler';
import { vec3 } from '../physics/vec3';
import type { Body } from '../types';
import { logRange, mulberry32, pick, range } from './prng';
import { balanceMomentum, solarSystem } from './solarSystem';

// --- asteroid belt ---------------------------------------------------------

/** The four biggest real belt objects, worth naming and sizing correctly. */
const BIG_FOUR = [
  { name: 'Ceres', type: 'dwarf' as const, mass: 9.38e20, radius: 4.7e5, rotationPeriod: 9.07 * HOUR, a: 2.77, e: 0.076, i: 10.59 },
  { name: 'Vesta', type: 'asteroid' as const, mass: 2.59e20, radius: 2.63e5, rotationPeriod: 5.34 * HOUR, a: 2.36, e: 0.089, i: 7.14 },
  { name: 'Pallas', type: 'asteroid' as const, mass: 2.04e20, radius: 2.56e5, rotationPeriod: 7.81 * HOUR, a: 2.77, e: 0.231, i: 34.84 },
  { name: 'Hygiea', type: 'asteroid' as const, mass: 8.7e19, radius: 2.17e5, rotationPeriod: 13.83 * HOUR, a: 3.14, e: 0.112, i: 3.83 },
];

const ASTEROID_COLORS = ['#8a7f72', '#9c8b7d', '#6f6a63', '#a08d70', '#7d7468'] as const;

/** How many generated rocks join the named four. */
const SMALL_ASTEROID_COUNT = 76;

/**
 * Sun, Mars and Jupiter (reused from the solar-system preset so the elements
 * can't drift apart) plus ~80 asteroids between 2.1 and 3.3 AU.
 *
 * Jupiter is there because it's why the belt looks the way it does; Mars marks
 * the inner edge. Asteroid masses are real-scale (up to ~3e20 kg), so they are
 * effectively test particles — the stress here is body *count*, not dynamics.
 */
export function asteroidBelt(): Body[] {
  const keep = new Set(['Sun', 'Mars', 'Jupiter']);
  const bodies = solarSystem().filter((b) => keep.has(b.name));
  const sun = bodies.find((b) => b.name === 'Sun')!;
  const sunState: StateVector = { position: sun.position, velocity: sun.velocity };

  const rand = mulberry32(0xa57e401d);

  for (const spec of BIG_FOUR) {
    const state = elementsToStateVector(SUN_MASS, sunState, {
      a: spec.a * AU,
      e: spec.e,
      i: spec.i,
      lan: range(rand, 0, 360),
      argPeriapsis: range(rand, 0, 360),
      trueAnomaly: range(rand, 0, 360),
    });
    bodies.push({
      id: crypto.randomUUID(),
      name: spec.name,
      color: pick(rand, ASTEROID_COLORS),
      type: spec.type,
      mass: spec.mass,
      radius: spec.radius,
      rotationPeriod: spec.rotationPeriod,
      axialTilt: range(rand, 0, 60),
      position: state.position,
      velocity: state.velocity,
    });
  }

  for (let n = 0; n < SMALL_ASTEROID_COUNT; n++) {
    // Radius drives mass at rubble density (~2500 kg/m³), so the two agree.
    const radius = logRange(rand, 5e3, 3e5);
    const mass = 2500 * (4 / 3) * Math.PI * radius ** 3;

    const state = elementsToStateVector(SUN_MASS, sunState, {
      a: range(rand, 2.1, 3.3) * AU,
      e: range(rand, 0, 0.15),
      i: range(rand, -8, 8),
      lan: range(rand, 0, 360),
      argPeriapsis: range(rand, 0, 360),
      trueAnomaly: range(rand, 0, 360),
    });

    bodies.push({
      id: crypto.randomUUID(),
      name: `Asteroid ${n + 1}`,
      color: pick(rand, ASTEROID_COLORS),
      type: 'asteroid',
      mass,
      radius,
      rotationPeriod: range(rand, 4, 30) * HOUR,
      axialTilt: range(rand, 0, 180),
      position: state.position,
      velocity: state.velocity,
    });
  }

  // The filtered Sun still carries recoil for the dropped planets;
  // re-balance against what's actually here.
  balanceMomentum(bodies, 0);
  return bodies;
}

// --- comet swarm -----------------------------------------------------------

const COMET_COLORS = ['#bfe3f0', '#a8d8e8', '#d0ecf5', '#9fc9dd'] as const;

const COMET_COUNT = 28;

/**
 * The Sun, the Earth for scale, and ~28 comets on highly eccentric orbits.
 *
 * This is the preset that exercises comet tails and eccentric trails: every
 * body is type `ice`, periapses sit at 0.25–1.4 AU (well inside the 4 AU
 * activity radius), and eccentricities of 0.65–0.95 mean tails grow and shrink
 * dramatically over a scrub. True anomalies are uniform, which front-loads the
 * action: on a high-e orbit most of the sweep happens near periapsis, so a
 * uniform draw puts roughly half the swarm in the active zone at t = 0.
 */
export function cometSwarm(): Body[] {
  // Sun and Earth come out of `solarSystem()` rather than being written out
  // again here, so they arrive with their photographic maps, real tilts and
  // Earth's atmosphere instead of a hand-rolled near-copy that drifts from the
  // canonical one. Only the *placement* is this preset's own: the Sun sits at
  // the origin at rest and Earth on a circular 1 AU orbit, which keeps the
  // comets' periapses readable against a round Earth orbit.
  const sunState: StateVector = { position: vec3(), velocity: vec3() };
  const keep = new Set(['Sun', 'Earth']);
  const bodies = solarSystem().filter((b) => keep.has(b.name));

  const sun = bodies.find((b) => b.name === 'Sun')!;
  sun.position = sunState.position;
  sun.velocity = sunState.velocity;

  const earth = bodies.find((b) => b.name === 'Earth')!;
  const earthState = circularOrbit(SUN_MASS, sunState, AU, 0, 0, EARTH_MASS);
  earth.position = earthState.position;
  earth.velocity = earthState.velocity;

  const rand = mulberry32(0xc0e75a11);

  for (let n = 0; n < COMET_COUNT; n++) {
    // Draw the periapsis and eccentricity, derive the semi-major axis — that
    // guarantees every comet actually visits the active zone, which drawing
    // `a` directly would not.
    const q = range(rand, 0.25, 1.4) * AU;
    const e = range(rand, 0.65, 0.95);
    const a = q / (1 - e);

    const state = elementsToStateVector(SUN_MASS, sunState, {
      a,
      e,
      i: range(rand, -40, 40),
      lan: range(rand, 0, 360),
      argPeriapsis: range(rand, 0, 360),
      trueAnomaly: range(rand, 0, 360),
    });

    const radius = logRange(rand, 2e3, 2e4);
    bodies.push({
      id: crypto.randomUUID(),
      name: `Comet ${n + 1}`,
      color: pick(rand, COMET_COLORS),
      type: 'ice',
      mass: 600 * (4 / 3) * Math.PI * radius ** 3, // dirty-snowball density
      radius,
      rotationPeriod: range(rand, 6, 60) * HOUR,
      axialTilt: range(rand, 0, 180),
      position: state.position,
      velocity: state.velocity,
    });
  }

  balanceMomentum(bodies, 0);
  return bodies;
}

// --- satellite swarm -------------------------------------------------------

/**
 * Timing grids this preset overrides, and why it needs its own.
 *
 * These orbits are at *real* altitudes: the ISS at 6.78e6 m has a 92-minute
 * period, four orders of magnitude below the outer-planet orbits the app's
 * defaults are sized for. All three of the app's time grids are too coarse for
 * that, and all three have to move together or the orbit is unusable in a
 * different way each time:
 *
 *  - `dt` 600 s gives nine integration steps per ISS orbit. That isn't an
 *    orbit, it's a polygon that spirals — measured semi-major axis drifts 2.75%
 *    in ten days, which lifts the station from 408 km to 1366 km. At 60 s it is
 *    93 steps per orbit and 0.0008%, the knee of the curve.
 *  - `snapshotInterval` 1 day would place one scrub keyframe every ~15 orbits,
 *    so seeking would land the whole constellation somewhere arbitrary.
 *  - `trailInterval` 6 hours would draw one trail point every four revolutions:
 *    a straight line through the middle of the orbit rather than the orbit.
 *
 * The cost is ~10× the step count of a default preset, which the body count
 * makes affordable only because the interesting timescale here is hours: at
 * 1 sim-day/s this is ~6% of one core (measured at the roster's earlier 83
 * bodies; today's 44 are cheaper still in the O(n²) loop).
 */
export const SATELLITE_TIMING = {
  dt: 60,
  snapshotInterval: 10 * 60, // ~9 scrub keyframes per LEO orbit
  trailInterval: 60, // ~93 trail points per LEO orbit
} as const;

/**
 * The swarm's full roster — every entry a real spacecraft, flown at its
 * published orbit. `a`, `e` and `i` are the real elements; the preset's own
 * `dt` (see `SATELLITE_TIMING`) is what makes flying them possible.
 *
 * RAAN (`lan`) and phase (`trueAnomaly`) are the two elements that only mean
 * anything at a specific epoch, which the sim doesn't have. They are chosen by
 * hand instead, to keep the geometry that survives without one: the GEO birds
 * keep their true longitudes relative to each other, the GPS planes sit 60°
 * apart, the GRACE-FO pair flies 220 km in trail — and no two co-altitude
 * craft start on top of each other.
 *
 * Masses and radii are real (radius ≈ half the craft's largest span). The
 * span from Vanguard 1's 1.46 kg to the ISS's 420 t — over five decades — is
 * the point: the roster shows honest numbers and lets the display, not the
 * data, handle making them all visible.
 */
const NAMED_SATELLITES = [
  // -- low Earth orbit: stations, observatories, imagers, and two relics ----
  {
    name: 'ISS',
    color: '#e8ecf2',
    a: 6.78e6, // ~408 km altitude
    e: 0.0006,
    i: 51.64, // Baikonur-reachable inclination
    lan: 0,
    argPeriapsis: 60,
    trueAnomaly: 0,
    mass: 4.2e5,
    radius: 54, // half the ~109 m truss span
    rotationPeriod: 92.6 * 60, // nadir-locked: one rotation per orbit
  },
  {
    name: 'Tiangong',
    color: '#e3d7c4',
    a: 6.761e6, // ~390 km altitude
    e: 0.0005,
    i: 41.47,
    lan: 200,
    argPeriapsis: 200,
    trueAnomaly: 40,
    mass: 1.0e5,
    radius: 27,
    rotationPeriod: 92.2 * 60,
  },
  {
    name: 'Hubble',
    color: '#d5c9a8',
    // ~483 km altitude. Drag has decayed the orbit steadily since the last
    // Shuttle reboost in 2009, fastest through the current solar maximum —
    // it fell below 500 km for the first time in 2025.
    a: 6.854e6,
    e: 0.0003,
    i: 28.47, // Shuttle's due-east inclination from the Cape
    lan: 80,
    argPeriapsis: 110,
    trueAnomaly: 120,
    mass: 1.111e4,
    radius: 6.6, // 13.2 m long
    rotationPeriod: 94.1 * 60,
  },
  {
    name: 'Starlink',
    color: '#c9ccd4',
    a: 6.928e6, // the ~550 km shell
    e: 0.0001,
    i: 53.0,
    lan: 140,
    argPeriapsis: 0,
    trueAnomaly: 200,
    mass: 2.6e2,
    radius: 4.1,
    rotationPeriod: 95.6 * 60,
  },
  {
    name: 'Landsat 9',
    color: '#a9c4a0',
    a: 7.083e6, // ~705 km, sun-synchronous
    e: 0.0001,
    i: 98.2, // retrograde — the signature of a sun-synchronous orbit
    lan: 100,
    argPeriapsis: 90,
    trueAnomaly: 280,
    mass: 2.62e3,
    radius: 2.3,
    rotationPeriod: 98.9 * 60,
  },
  {
    // Same 705 km WRS-2 ground track as Landsat — genuinely co-planar with it,
    // which is why the two share `a` and `lan` here and differ only in phase.
    name: 'Terra',
    color: '#9db894',
    a: 7.083e6,
    e: 0.0001,
    i: 98.2,
    lan: 100,
    argPeriapsis: 90,
    trueAnomaly: 60,
    mass: 4.864e3,
    radius: 3.4,
    rotationPeriod: 98.9 * 60,
  },
  {
    name: 'Sentinel-2',
    color: '#9ab8c6',
    a: 7.164e6, // ~786 km, sun-synchronous
    e: 0.0001,
    i: 98.6,
    lan: 115,
    argPeriapsis: 90,
    trueAnomaly: 330,
    mass: 1.14e3,
    radius: 1.8,
    rotationPeriod: 100.6 * 60,
  },
  {
    name: 'NOAA-20',
    color: '#b3c2cd',
    a: 7.195e6, // ~824 km, the JPSS weather orbit
    e: 0.0001,
    i: 98.7,
    lan: 210,
    argPeriapsis: 90,
    trueAnomaly: 250,
    mass: 2.294e3,
    radius: 2.1,
    rotationPeriod: 101.2 * 60,
  },
  {
    name: 'ICESat-2',
    color: '#aebfd0',
    a: 6.867e6, // ~496 km, near-polar laser altimeter
    e: 0.0001,
    i: 92.0,
    lan: 250,
    argPeriapsis: 90,
    trueAnomaly: 300,
    mass: 1.514e3,
    radius: 1.9,
    rotationPeriod: 94.4 * 60,
  },
  {
    name: 'GRACE-FO 1',
    color: '#c2b8a3',
    a: 6.861e6, // ~490 km
    e: 0.001,
    i: 89.0,
    lan: 300,
    argPeriapsis: 0,
    trueAnomaly: 0,
    mass: 6.01e2,
    radius: 1.5,
    rotationPeriod: 94.3 * 60,
  },
  {
    // 220 km behind its twin (1.84° of phase). The gap is the instrument:
    // the mission measures gravity by ranging the distance between the pair.
    name: 'GRACE-FO 2',
    color: '#c2b8a3',
    a: 6.861e6,
    e: 0.001,
    i: 89.0,
    lan: 300,
    argPeriapsis: 0,
    trueAnomaly: 1.84,
    mass: 6.01e2,
    radius: 1.5,
    rotationPeriod: 94.3 * 60,
  },
  {
    name: 'Sentinel-6',
    color: '#8fb0c0',
    // 1336 km — the reference altimetry orbit inherited from TOPEX and the
    // Jason line, deliberately *not* sun-synchronous so it samples the tides.
    a: 7.707e6,
    e: 0.0001,
    i: 66.04,
    lan: 340,
    argPeriapsis: 0,
    trueAnomaly: 140,
    mass: 1.192e3,
    radius: 2.6,
    rotationPeriod: 112.2 * 60,
  },
  {
    name: 'Fermi',
    color: '#b7a9c9',
    a: 6.921e6, // ~550 km, low inclination to dodge the radiation belts' worst
    e: 0.001,
    i: 25.58,
    lan: 60,
    argPeriapsis: 0,
    trueAnomaly: 220,
    mass: 4.303e3,
    radius: 7.5,
    rotationPeriod: 95.5 * 60,
  },
  {
    name: 'Iridium 100',
    color: '#b8bec8',
    a: 7.156e6, // ~780 km, polar comms constellation
    e: 0.0002,
    i: 86.4,
    lan: 30,
    argPeriapsis: 45,
    trueAnomaly: 90,
    mass: 8.6e2, // Iridium NEXT — the 689 kg figure is the first generation
    radius: 2.0,
    rotationPeriod: 100.4 * 60,
  },
  {
    name: 'Envisat',
    color: '#8f9aa6',
    a: 7.143e6, // ~770 km — derelict since 2012
    e: 0.0001,
    i: 98.4,
    lan: 130,
    argPeriapsis: 90,
    trueAnomaly: 170,
    mass: 8.211e3,
    radius: 13, // 26 m solar array
    rotationPeriod: 100.1 * 60,
  },
  {
    // The oldest object still in orbit: launched 1958, aloft for centuries yet.
    name: 'Vanguard 1',
    color: '#d8d3c0',
    a: 8.683e6, // 654 × 3969 km
    e: 0.191,
    i: 34.25,
    lan: 310,
    argPeriapsis: 120,
    trueAnomaly: 200,
    mass: 1.46,
    radius: 0.08, // a 16.5 cm sphere
    rotationPeriod: 600, // long-dead; a slow tumble
  },
  {
    // First live TV across an ocean, 1962; dead within months — Starfish Prime
    // had charged the belts it flew through. Still up there.
    name: 'Telstar 1',
    color: '#cdb89a',
    a: 9.667e6, // 952 × ~5600 km
    e: 0.242,
    i: 44.8,
    lan: 170,
    argPeriapsis: 80,
    trueAnomaly: 300,
    mass: 77,
    radius: 0.44,
    rotationPeriod: 0.34, // spin-stabilised at ~178 rpm
  },

  // -- MEO: all four navigation constellations ------------------------------
  // GPS flies six planes 60° apart; four birds in alternating planes sketch
  // the geometry without the full 24-slot constellation.
  {
    name: 'GPS III Vespucci',
    color: '#cfd4dc',
    a: 2.656e7, // semi-synchronous, 12-hour period
    e: 0.001,
    i: 55.0,
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 0,
    mass: 3.88e3,
    radius: 3.4,
    rotationPeriod: 11.97 * HOUR,
  },
  {
    name: 'GPS III Magellan',
    color: '#c8cdd6',
    a: 2.656e7,
    e: 0.001,
    i: 55.0,
    lan: 60,
    argPeriapsis: 0,
    trueAnomaly: 137.5,
    mass: 3.88e3,
    radius: 3.4,
    rotationPeriod: 11.97 * HOUR,
  },
  {
    name: 'GPS III Henson',
    color: '#d4d9e0',
    a: 2.656e7,
    e: 0.001,
    i: 55.0,
    lan: 120,
    argPeriapsis: 0,
    trueAnomaly: 275,
    mass: 3.88e3,
    radius: 3.4,
    rotationPeriod: 11.97 * HOUR,
  },
  {
    name: 'GPS III Sacagawea',
    color: '#c2c8d2',
    a: 2.656e7,
    e: 0.001,
    i: 55.0,
    lan: 180,
    argPeriapsis: 0,
    trueAnomaly: 52.5,
    mass: 3.88e3,
    radius: 3.4,
    rotationPeriod: 11.97 * HOUR,
  },
  // Galileo FOC satellites are each named for a European child; Tara, Samuel
  // and Anna went up together on one Ariane 5 in 2018.
  {
    name: 'Galileo Tara',
    color: '#c4cad3',
    a: 2.9602e7, // 23 222 km altitude, 14.08-hour period
    e: 0.0002,
    i: 56.0,
    lan: 20,
    argPeriapsis: 0,
    trueAnomaly: 40,
    mass: 7.33e2,
    radius: 7.3, // 14.7 m across its arrays
    rotationPeriod: 14.08 * HOUR,
  },
  {
    name: 'Galileo Samuel',
    color: '#bec5cf',
    a: 2.9602e7,
    e: 0.0002,
    i: 56.0,
    lan: 140,
    argPeriapsis: 0,
    trueAnomaly: 180,
    mass: 7.33e2,
    radius: 7.3,
    rotationPeriod: 14.08 * HOUR,
  },
  {
    name: 'Galileo Anna',
    color: '#cdd2da',
    a: 2.9602e7,
    e: 0.0002,
    i: 56.0,
    lan: 260,
    argPeriapsis: 0,
    trueAnomaly: 320,
    mass: 7.33e2,
    radius: 7.3,
    rotationPeriod: 14.08 * HOUR,
  },
  {
    name: 'GLONASS-K2',
    color: '#b0a998',
    a: 2.551e7, // 19 130 km altitude, 11.26-hour period
    e: 0.0004,
    i: 64.8, // steeper than GPS — built for coverage at Russian latitudes
    lan: 90,
    argPeriapsis: 0,
    trueAnomaly: 45,
    mass: 1.645e3,
    radius: 3.5,
    rotationPeriod: 11.26 * HOUR,
  },
  // A BeiDou-3 MEO pair, launched together on one CZ-3B and phased apart.
  {
    name: 'BeiDou-3 M19',
    color: '#c9b98f',
    a: 2.79e7, // 21 528 km altitude, 12.88-hour period
    e: 0.0003,
    i: 55.0,
    lan: 220,
    argPeriapsis: 0,
    trueAnomaly: 10,
    mass: 9.41e2,
    radius: 2.5,
    rotationPeriod: 12.88 * HOUR,
  },
  {
    name: 'BeiDou-3 M20',
    color: '#c3b389',
    a: 2.79e7,
    e: 0.0003,
    i: 55.0,
    lan: 220,
    argPeriapsis: 0,
    trueAnomaly: 55,
    mass: 9.41e2,
    radius: 2.5,
    rotationPeriod: 12.88 * HOUR,
  },

  // -- high, eccentric and inclined: the loops and deep ellipses ------------
  {
    name: 'Molniya 3-53',
    color: '#d8b45a',
    a: 2.6561e7, // semi-synchronous, 12-hour highly elliptical orbit
    e: 0.74, // apogee over the northern hemisphere, perigee racing past the south
    i: 63.4, // the critical inclination — apsides don't precess here
    lan: 280,
    argPeriapsis: 270,
    trueAnomaly: 30,
    mass: 1.6e3,
    radius: 2.1,
    rotationPeriod: 11.97 * HOUR,
  },
  {
    // The Molniya orbit's active successor: same loop, modern Russian comms.
    name: 'Meridian 9',
    color: '#caa25e',
    a: 2.6404e7, // ~1000 × 39 000 km
    e: 0.721,
    i: 62.8,
    lan: 100,
    argPeriapsis: 270,
    trueAnomaly: 200,
    mass: 2.1e3,
    radius: 4,
    rotationPeriod: 11.86 * HOUR,
  },
  {
    // Quasi-zenith: geosynchronous period but inclined and slightly eccentric,
    // so it dwells over Japan and traces a figure-8 rather than hovering.
    name: 'QZS-1 Michibiki',
    color: '#d9c48a',
    a: 4.2164e7,
    e: 0.075,
    i: 41.0,
    lan: 195,
    argPeriapsis: 270,
    trueAnomaly: 0,
    mass: 4.0e3,
    radius: 12.6, // 25 m across its arrays
    rotationPeriod: 23.93 * HOUR,
  },
  {
    // 14 300 × 134 800 km, 63.5 hours — a third of the way to the Moon. The
    // real orbit's inclination is swung tens of degrees over the mission by
    // lunisolar torque; 55° is a mid-swing snapshot.
    name: 'Chandra',
    color: '#c8a2a2',
    a: 8.08e7,
    e: 0.744,
    i: 55.0,
    lan: 320,
    argPeriapsis: 270,
    trueAnomaly: 150,
    mass: 4.79e3,
    radius: 6.9, // 13.8 m long
    rotationPeriod: 6 * HOUR,
  },
  {
    name: 'XMM-Newton',
    color: '#a2b4c8',
    a: 6.694e7, // 7350 × 113 700 km, 47.9 hours
    e: 0.795,
    i: 38.9,
    lan: 30,
    argPeriapsis: 95,
    trueAnomaly: 210,
    mass: 3.764e3,
    radius: 8, // 16 m across its arrays
    rotationPeriod: 8 * HOUR,
  },
  {
    // 2:1 lunar-resonant, 13.7 days, apogee 59 R⊕ — almost to the Moon. The
    // real mission phases the orbit to keep the Moon at arm's length; nothing
    // here does, so the Moon genuinely works on it, which is the fun of it.
    name: 'TESS',
    color: '#e0b8b0',
    a: 2.42e8,
    e: 0.55,
    i: 37.0,
    lan: 60,
    argPeriapsis: 200,
    trueAnomaly: 340,
    mass: 3.62e2,
    radius: 1.9,
    rotationPeriod: 2 * HOUR,
  },

  // -- the geostationary belt -----------------------------------------------
  // `trueAnomaly` here is the slot's real longitude °E. Absolute longitude is
  // meaningless without an epoch, but the belt's real spacing — the crowd over
  // the Americas, the gap over the mid-Pacific — survives intact.
  {
    name: 'Meteosat-12',
    color: '#d5cfa8',
    a: 4.2164e7,
    e: 0.0001,
    i: 0.1,
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 0, // 0° — Europe's weather sentinel on the prime meridian
    mass: 3.8e3,
    radius: 3.7,
    rotationPeriod: 23.93 * HOUR,
  },
  {
    name: 'Inmarsat-6',
    color: '#d0d5dd',
    a: 4.2164e7,
    e: 0.0002,
    i: 0.03,
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 83.5, // over the Indian Ocean
    mass: 5.47e3,
    radius: 4.5,
    rotationPeriod: 23.93 * HOUR,
  },
  {
    name: 'Himawari-9',
    color: '#dcc9a8',
    a: 4.2164e7,
    e: 0.0001,
    i: 0.03,
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 140.7, // Japan's weather eye over the western Pacific
    mass: 3.5e3,
    radius: 4,
    rotationPeriod: 23.93 * HOUR,
  },
  {
    name: 'GOES-18',
    color: '#e0d5b8',
    a: 4.2164e7,
    e: 0.0001,
    i: 0.05,
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 223, // 137°W — GOES-West
    mass: 5.192e3,
    radius: 3.1,
    rotationPeriod: 23.93 * HOUR,
  },
  {
    // Jupiter-3: the heaviest commercial comsat ever flown.
    name: 'EchoStar 24',
    color: '#c9c2b2',
    a: 4.2164e7,
    e: 0.0001,
    i: 0.02,
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 265, // 95°W
    mass: 9.2e3,
    radius: 20, // ~40 m across its arrays
    rotationPeriod: 23.93 * HOUR,
  },
  {
    name: 'SES-17',
    color: '#c5cbd4',
    a: 4.2164e7,
    e: 0.0001,
    i: 0.02,
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 292.9, // 67.1°W
    mass: 6.411e3,
    radius: 8,
    rotationPeriod: 23.93 * HOUR,
  },
  {
    name: 'TDRS-13',
    color: '#c6ccd6',
    a: 4.2164e7,
    e: 0.0003,
    i: 3.5, // inclined GEO — the figure-eight ground track
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 310, // ~50°W, over the Atlantic relay slot
    mass: 3.454e3,
    radius: 2.1,
    rotationPeriod: 23.93 * HOUR,
  },
  {
    // The first satellite ever serviced in orbit: MEV-1 docked to it in 2020
    // and flew the then-retired bird back to its slot.
    name: 'Intelsat 901',
    color: '#b9b2a4',
    a: 4.2164e7,
    e: 0.0003,
    i: 0.05,
    lan: 0,
    argPeriapsis: 0,
    trueAnomaly: 332.5, // 27.5°W
    mass: 4.723e3,
    radius: 20, // a Boeing 702 — ~40 m across its arrays
    rotationPeriod: 23.93 * HOUR,
  },
] as const;

/**
 * Earth hung with 41 real spacecraft, every one flown at its published orbit.
 *
 * The roster covers each regime with the craft that define it: a LEO shell
 * running from Vanguard 1 (aloft since 1958) through the stations, imagers and
 * observatories; all four navigation constellations at MEO; the Molniya and
 * Meridian loops and QZS-1's geosynchronous figure-8; the deep ellipses of
 * Chandra and XMM-Newton; the geostationary belt at its true relative
 * longitudes; and TESS, whose 3.75e8 m apogee reaches almost to the Moon —
 * which, with nothing maintaining the real mission's resonance phasing, slowly
 * works on it.
 *
 * Every orbit is at its real altitude and its real period — the ISS at 408 km
 * and 92 minutes, the GEO belt hanging motionless over the equator. That only
 * works because the preset carries its own `dt`, snapshot and trail intervals
 * (`SATELLITE_TIMING`); the app's defaults are sized for planetary orbits and
 * would render LEO as a spiralling polygon.
 *
 * Best viewed in the Earth reference frame with the radius exaggeration low.
 * The interesting timescale here is hours, not years — at 1 day/s the LEO
 * satellites are already a blur.
 */
export function satelliteSwarm(): Body[] {
  const keep = new Set(['Sun', 'Earth', 'Moon']);
  const bodies = solarSystem().filter((b) => keep.has(b.name));
  const earth = bodies.find((b) => b.name === 'Earth')!;
  const earthState: StateVector = { position: earth.position, velocity: earth.velocity };

  for (const spec of NAMED_SATELLITES) {
    const state = elementsToStateVector(
      EARTH_MASS,
      earthState,
      {
        a: spec.a,
        e: spec.e,
        i: spec.i,
        lan: spec.lan,
        argPeriapsis: spec.argPeriapsis,
        trueAnomaly: spec.trueAnomaly,
      },
      spec.mass
    );
    bodies.push({
      id: crypto.randomUUID(),
      name: spec.name,
      color: spec.color,
      type: 'satellite',
      mass: spec.mass,
      radius: spec.radius,
      rotationPeriod: spec.rotationPeriod,
      axialTilt: 0,
      position: state.position,
      velocity: state.velocity,
    });
  }

  // Same story as the belt: the filtered Sun carries recoil for the dropped
  // planets; re-balance against what's actually here.
  balanceMomentum(bodies, 0);
  return bodies;
}

// --- planetesimal disk -----------------------------------------------------

/**
 * Three, not six. Texture cost is (colors × seed variants) full-size surfaces,
 * and `rocky` is the one expensive type that can't take a resolution cut — it
 * also covers Mercury, Venus and Mars. Six colors meant 18 × 87 ms ≈ 1.6 s of
 * generation on load. At the few pixels a planetesimal occupies these three
 * are already indistinguishable from six.
 */
const PLANETESIMAL_COLORS = ['#b0704a', '#a08055', '#c08a60'] as const;

const PLANETESIMAL_COUNT = 90;

/** See the note on `planetesimalDisk` — measured threshold for merges to fire. */
const PLANETESIMAL_COLLISION_INFLATION = 80;

/**
 * Drawn radius, as a multiple of the true one. Kept at the ×4 this preset has
 * always used: at honest size a planetesimal is invisible from a framing that
 * shows the disc, and the preset's thumbnail and default camera are both tuned
 * around this. Separate from the collision figure above so the merge rate can
 * be tuned without changing what you see.
 */
const PLANETESIMAL_DISPLAY_INFLATION = 4;

/**
 * A young star with ~90 Moon-to-Mars-mass planetesimals packed into a tight,
 * moderately eccentric disk — a system in the middle of forming planets.
 *
 * Unlike the belt, these masses are large enough to perturb each other, so the
 * disk churns: close encounters scatter bodies and some merge outright. That
 * makes it the stress test for the *timeline* — merge events, scrubbing back
 * across them, and roster churn in the scene — on top of raw body count.
 *
 * Collision radii are inflated ×80 over the physical size, via
 * `collisionRadius` so the *drawn* size stays honest. At true radii two
 * planetesimals essentially never touch on timescales anyone will scrub
 * through — they just slingshot, and the preset never does the one thing it
 * exists to show. ×80 is the measured threshold: it produces the first merge
 * around year 0.5 and a handful by year 5, which is inside the window someone
 * will actually watch. ×40 and below produce none within 5 years.
 */
export function planetesimalDisk(): Body[] {
  const sunState: StateVector = { position: vec3(), velocity: vec3() };
  const bodies: Body[] = [
    {
      id: crypto.randomUUID(),
      name: 'Proto',
      color: '#ffc27f',
      type: 'star',
      mass: SUN_MASS,
      radius: 1.2 * SUN_RADIUS,
      rotationPeriod: 10 * DAY,
      axialTilt: 3,
      position: sunState.position,
      velocity: sunState.velocity,
    },
  ];

  const rand = mulberry32(0xd15c0001);

  for (let n = 0; n < PLANETESIMAL_COUNT; n++) {
    const mass = logRange(rand, 5e21, 5e23);
    const trueRadius = Math.cbrt((3 * mass) / (4 * Math.PI * 1500));
    const radius = PLANETESIMAL_DISPLAY_INFLATION * trueRadius;

    const state = elementsToStateVector(
      SUN_MASS,
      sunState,
      {
        a: range(rand, 0.25, 1.1) * AU,
        e: range(rand, 0, 0.2),
        i: range(rand, -4, 4),
        lan: range(rand, 0, 360),
        argPeriapsis: range(rand, 0, 360),
        trueAnomaly: range(rand, 0, 360),
      },
      mass
    );

    bodies.push({
      id: crypto.randomUUID(),
      name: `Planetesimal ${n + 1}`,
      color: pick(rand, PLANETESIMAL_COLORS),
      type: 'rocky',
      mass,
      radius,
      collisionRadius: PLANETESIMAL_COLLISION_INFLATION * trueRadius,
      rotationPeriod: range(rand, 5, 40) * HOUR,
      axialTilt: range(rand, 0, 40),
      position: state.position,
      velocity: state.velocity,
    });
  }

  balanceMomentum(bodies, 0);
  return bodies;
}

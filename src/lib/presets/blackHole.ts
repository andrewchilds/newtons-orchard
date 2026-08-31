// A supermassive black hole with stars in relativistic orbits — the one
// preset where the Paczyński–Wiita pseudo-potential (see physics/gravity.ts)
// visibly does something Newtonian gravity can't.
//
// Sgr A*-sized deliberately: only a supermassive hole works at this app's
// scales. A stellar-mass one has a ~3 km horizon, smaller than the
// force-softening length and permanently sub-pixel, while this one's
// r_s ≈ 1.23e10 m is ~17 Sun radii and draws at honest scale. Orbits at
// 8–25 r_s have periods of hours, hundreds of steps per lap at the preset's dt.
//
// Each companion star demonstrates one effect:
//  - S2 (eccentric, periapsis ~6.8 r_s): periapsis advances tens of degrees
//    per orbit, so its trail draws a rosette instead of a closed ellipse.
//  - S-Swift (circular at 8 r_s, 0.29c): a stable relativistic clock — its
//    "Clock rate" readout sits near 0.89× sim time.
//  - S-Doomed (periapsis inside ~4 r_s): each pass dives deeper until the
//    pseudo-potential's instability wins and it crosses the horizon — the
//    merge grows the hole's mass and, with it, the horizon itself.
//  - S-Ring (circular at 60 r_s): far enough out to be nearly Newtonian, a
//    quiet reference orbit against which the inner chaos reads.
//
// Placed by hand from apoapsis/circular speeds rather than Kepler elements: PW
// orbits aren't Keplerian, so elements would promise a shape the integrator
// won't draw. Speeds are Newtonian at apoapsis; the PW force is stronger, so
// true periapses fall inside the Newtonian prediction — tuned into the numbers.

import { DAY, SUN_MASS, SUN_RADIUS, schwarzschildRadius } from '../physics/constants';
import { vec3 } from '../physics/vec3';
import type { Body } from '../types';
import { balanceMomentum } from './solarSystem';

/** Sgr A*'s measured mass, ~4.15 million Suns. */
export const BLACK_HOLE_MASS = 4.15e6 * SUN_MASS;

/** Horizon radius of the hole above, ~1.23e10 m — the preset's length unit. */
export const BLACK_HOLE_RS = schwarzschildRadius(BLACK_HOLE_MASS);

/**
 * The fastest thing here is S-Doomed near periapsis (~0.4c); 10 s keeps each
 * step under ~5% of the periapsis radius. Display grids are sized for the
 * shortest orbit worth drawing (S-Swift, 2 h): 120 s gives it ~60 points per
 * lap, S2 ~175. Snapshot and trail grids match per GUIDE.md, because a seek
 * rebuilds trails from snapshots.
 */
export const BLACK_HOLE_TIMING = {
  dt: 10,
  snapshotInterval: 120,
  trailInterval: 120,
} as const;

/** μ = G·M for the hole, precomputed for the speed formulas below. */
const MU = 6.6743e-11 * BLACK_HOLE_MASS;

interface CompanionSpec {
  name: string;
  color: string;
  /** solar masses */
  mass: number;
  /** solar radii */
  radius: number;
  /** starting distance from the hole, in units of r_s — apoapsis if eccentric */
  r: number;
  /**
   * Tangential speed as a fraction of the *Newtonian* circular speed at `r`.
   * 1 → near-circular (slightly eccentric under PW), <1 → eccentric with the
   * periapsis dropping toward the hole.
   */
  speedFactor: number;
  /** true when the speed should be the PW-circular value, for a round orbit */
  pwCircular?: boolean;
}

const COMPANIONS: readonly CompanionSpec[] = [
  // Apoapsis 23.3 r_s, Newtonian periapsis ~6.8 r_s. Precession is tens of
  // degrees per 6-hour orbit — the rosette.
  { name: 'S2', color: '#9fc0ff', mass: 14, radius: 3, r: 23.25, speedFactor: 0.762 },
  // PW-circular at 8 r_s: 0.29c, stable (ISCO is at 3 r_s), clock at ~0.89×.
  { name: 'S-Swift', color: '#ffd9a0', mass: 10, radius: 2, r: 8, speedFactor: 1, pwCircular: true },
  // Apoapsis 10 r_s at 85% of circular: the periapsis lands near 4 r_s, where
  // the PW force overshoots the Newtonian ellipse and each pass spirals
  // deeper — captured within the first sim-day.
  { name: 'S-Doomed', color: '#ff9f8a', mass: 8, radius: 1.8, r: 10, speedFactor: 0.85 },
  // 60 r_s: near-Newtonian, a ~2-day reference circle with mild precession.
  { name: 'S-Ring', color: '#a8e6d0', mass: 12, radius: 2.5, r: 60, speedFactor: 1, pwCircular: true },
];

/** Tangential launch speed for a companion, m/s. */
function launchSpeed(spec: CompanionSpec): number {
  const r = spec.r * BLACK_HOLE_RS;
  if (spec.pwCircular) {
    // PW circular orbit: v² = μ·r / (r − r_s)².
    return Math.sqrt(MU * r) / (r - BLACK_HOLE_RS);
  }
  return spec.speedFactor * Math.sqrt(MU / r);
}

/** Phases spread so no two stars start on the same ray from the hole. */
const PHASES_DEG = [0, 100, 210, 320];

export function blackHole(): Body[] {
  const bodies: Body[] = [
    {
      id: crypto.randomUUID(),
      name: 'Sgr A*',
      color: '#b39aff',
      type: 'blackhole',
      mass: BLACK_HOLE_MASS,
      // Drawn and collision radius are both the horizon: touching it *is*
      // falling in, and exaggerationFor() never inflates a black hole.
      radius: BLACK_HOLE_RS,
      rotationPeriod: 0,
      axialTilt: 0,
      position: vec3(),
      velocity: vec3(),
      // No atmosphere, deliberately: a #000000 disc, found only by the
      // starfield it occludes, its label, and the orbits wrapping it.
    },
  ];

  COMPANIONS.forEach((spec, n) => {
    const r = spec.r * BLACK_HOLE_RS;
    const v = launchSpeed(spec);
    const phase = (PHASES_DEG[n] * Math.PI) / 180;
    const cos = Math.cos(phase);
    const sin = Math.sin(phase);
    bodies.push({
      id: crypto.randomUUID(),
      name: spec.name,
      color: spec.color,
      type: 'star',
      mass: spec.mass * SUN_MASS,
      radius: spec.radius * SUN_RADIUS,
      rotationPeriod: 10 * DAY,
      axialTilt: 0,
      // Position on the phase ray, velocity perpendicular to it (prograde).
      position: vec3(r * cos, r * sin, 0),
      velocity: vec3(-v * sin, v * cos, 0),
    });
  });

  // The stars' net momentum would give the hole a (tiny) recoil; absorb it so
  // the hole sits exactly at the origin the camera frames.
  balanceMomentum(bodies, 0);
  return bodies;
}

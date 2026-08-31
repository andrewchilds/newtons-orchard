// The gravity assist, taught by twins: two identical probes climb the same
// transfer orbit toward Jupiter, launched days apart, and that spacing alone
// decides everything. Icarus, ahead, crosses Jupiter's path just in front of
// the planet — Jupiter's pull from behind brakes it, and it falls back inward
// around the Sun. Daedalus, behind, passes just aft — the same pull drags it
// forward, and it is flung across Saturn's bow and out of the solar system
// for good.
//
// The deep lesson is in the Center selector. Around Jupiter the two flybys are
// mirror images — each probe comes in and leaves at the same speed, bent onto
// a symmetric hyperbola — yet against the Sun one probe gained ~7 km/s and the
// other lost it. A slingshot doesn't take energy from Jupiter's *gravity*, it
// takes it from Jupiter's *motion*: the free speed is the frame change.
//
// Measured in the real integrator at the production 600 s dt:
//  - Icarus passes 2.20e9 m from Jupiter on day 559, offset 1.60e9 m *ahead*
//    along Jupiter's velocity. Braked, it falls to a 0.102 AU perihelion
//    (22 solar radii, deep inside Mercury's 0.31 AU perihelion) on day 1955,
//    and stays on that comet-like orbit.
//  - Daedalus passes 1.77e9 m on day 562, almost purely *behind* Jupiter.
//    Flung, it crosses Saturn's path at 3.2e9 m (54 Saturn radii) on day
//    1184 and is hyperbolic from the Jupiter flyby on: 21 AU by year 8,
//    still 25% over local escape speed — gone.
//  - Neither probe comes within 20× a collision radius of anything.

import { AU, DAY, SUN_MASS, YEAR } from '../physics/constants';
import { stateFromBodies, step } from '../physics/integrator';
import { elementsToStateVector, type StateVector } from '../physics/kepler';
import type { Body } from '../types';
import { balanceMomentum, solarSystem } from './solarSystem';

/**
 * Flyby-scale display grids under planetary-scale physics. The probes' years
 * are default territory (dt 600 resolves the 1.77e9 m periapsis at ~1% per
 * step), but the whole story turns in the two days around Jupiter: the default
 * 6 h trail grid draws the hairpin as a handful of chords, and a post-scrub
 * rebuild from the 1-day snapshot grid flattens it to an angle. 2 h grids keep
 * the turn a curve through every seek — this is the moment students scrub back
 * to rewatch.
 */
export const SLINGSHOT_TIMING = {
  dt: 600,
  snapshotInterval: 7200,
  trailInterval: 7200,
} as const;

/**
 * The roster's planet phases are synthetic (solarSystem seeds trueAnomaly from
 * J2000 *mean longitude*), and at that epoch Saturn sits ~45° past anywhere a
 * resolvable Jupiter flyby can throw a probe. Rolling the whole system forward
 * to the next workable launch window — exactly as mission planners wait for
 * one — brings the Jupiter→Saturn corridor around. Integrated at the preset's
 * own dt so the tests measure the same world the app builds.
 */
const LAUNCH_WINDOW = 3.2 * YEAR;

/** Perihelion 1 AU, aphelion 10 AU — hot, so the flyby can eject Daedalus
 * from a periapsis the 600 s grid honestly resolves (a Hohmann-ish transfer
 * needs a sub-5-radii pass for the same fate). */
const TRANSFER_A = 5.5 * AU;
const TRANSFER_E = 1 - AU / TRANSFER_A;

/**
 * Jupiter's own J2000 plane (values from `solarSystem`'s Jupiter), so the
 * encounter is two-dimensional: a probe launched in the ecliptic would miss
 * the flyby corridor by more out-of-plane than the corridor is wide.
 */
const JUPITER_I = 1.30439695;
const JUPITER_LAN = 100.47390909;

/** Aims the shared orbit's outbound leg at where Jupiter will be on day ~560. */
const ARG_PERIAPSIS = 304.71;

/**
 * Micro-tilt of the shared orbit about the in-plane axis perpendicular to the
 * Jupiter-encounter direction. It offsets Daedalus's B-plane a hair out of
 * Jupiter's orbital plane, which rotates the flyby's bend so the exit leg lies
 * in *Saturn's* plane — without it the exit rides Jupiter's plane and misses
 * Saturn by 31e9 m of pure z. A launch-plane change 100× larger can't do the
 * same job: the flyby's bend undoes it.
 */
const TILT_RAD = (0.016 * Math.PI) / 180;
const TILT_AXIS = { x: 0.1692, y: -0.9853, z: 0 };

/**
 * Each twin's start, in degrees of true anomaly before perihelion. The pair's
 * whole divergence is these two numbers: ~7.6° apart on one ellipse, a few
 * days of flight time, one fate ahead of Jupiter and one behind.
 */
const PROBES = [
  { name: 'Icarus', color: '#ffb85c', trueAnomaly: -1.516 },
  { name: 'Daedalus', color: '#e2ecff', trueAnomaly: -9.075 },
] as const;

/** Voyager's build: 825 kg, a dish about four metres across. */
const PROBE_MASS = 825;
const PROBE_RADIUS = 4;

function tilt(v: { x: number; y: number; z: number }) {
  const n = Math.hypot(TILT_AXIS.x, TILT_AXIS.y, TILT_AXIS.z);
  const ux = TILT_AXIS.x / n;
  const uy = TILT_AXIS.y / n;
  const uz = TILT_AXIS.z / n;
  const c = Math.cos(TILT_RAD);
  const s = Math.sin(TILT_RAD);
  const d = ux * v.x + uy * v.y + uz * v.z;
  return {
    x: v.x * c + (uy * v.z - uz * v.y) * s + ux * d * (1 - c),
    y: v.y * c + (uz * v.x - ux * v.z) * s + uy * d * (1 - c),
    z: v.z * c + (ux * v.y - uy * v.x) * s + uz * d * (1 - c),
  };
}

export function slingshotTwins(): Body[] {
  // All eight planets — Saturn is a destination, the ice giants milestones for
  // following Daedalus out — but no Moon or dwarfs: nothing here revisits 1 AU
  // close enough to care, and the roster stays legible.
  const keep = new Set([
    'Sun',
    'Mercury',
    'Venus',
    'Earth',
    'Mars',
    'Jupiter',
    'Saturn',
    'Uranus',
    'Neptune',
  ]);
  const bodies = solarSystem().filter((b) => keep.has(b.name));

  // Balanced before the fast-forward so the window rolls forward in place
  // instead of drifting with the dropped bodies' recoil.
  balanceMomentum(bodies, 0);
  const st = stateFromBodies(bodies);
  const shiftSteps = Math.round(LAUNCH_WINDOW / SLINGSHOT_TIMING.dt);
  for (let s = 0; s < shiftSteps; s++) step(st, SLINGSHOT_TIMING.dt);
  for (let i = 0; i < bodies.length; i++) {
    const i3 = i * 3;
    bodies[i].position = { x: st.pos[i3], y: st.pos[i3 + 1], z: st.pos[i3 + 2] };
    bodies[i].velocity = { x: st.vel[i3], y: st.vel[i3 + 1], z: st.vel[i3 + 2] };
  }

  const sun = bodies[0];
  const sunState: StateVector = { position: sun.position, velocity: sun.velocity };

  for (const spec of PROBES) {
    const raw = elementsToStateVector(
      SUN_MASS,
      sunState,
      {
        a: TRANSFER_A,
        e: TRANSFER_E,
        i: JUPITER_I,
        lan: JUPITER_LAN,
        argPeriapsis: ARG_PERIAPSIS,
        trueAnomaly: spec.trueAnomaly,
      },
      PROBE_MASS
    );
    // The tilt rotates the sun-relative state, then re-anchors on the sun.
    const rp = tilt({
      x: raw.position.x - sun.position.x,
      y: raw.position.y - sun.position.y,
      z: raw.position.z - sun.position.z,
    });
    const rv = tilt({
      x: raw.velocity.x - sun.velocity.x,
      y: raw.velocity.y - sun.velocity.y,
      z: raw.velocity.z - sun.velocity.z,
    });
    bodies.push({
      id: crypto.randomUUID(),
      name: spec.name,
      color: spec.color,
      type: 'satellite',
      mass: PROBE_MASS,
      radius: PROBE_RADIUS,
      rotationPeriod: 1 * DAY,
      axialTilt: 0,
      position: { x: sun.position.x + rp.x, y: sun.position.y + rp.y, z: sun.position.z + rp.z },
      velocity: { x: sun.velocity.x + rv.x, y: sun.velocity.y + rv.y, z: sun.velocity.z + rv.z },
    });
  }

  balanceMomentum(bodies, 0);
  return bodies;
}

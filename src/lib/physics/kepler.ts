// Orbital elements → state vectors, relative to a parent body. How users place
// planets.
//
// Frame convention: reference plane z = 0, reference direction (from which the
// longitude of the ascending node is measured) +x. Zero inclination gives a
// counter-clockwise orbit viewed from +z.

import { G } from './constants';
import { clone, vec3, type Vec3 } from './vec3';

export interface OrbitalElements {
  /** semi-major axis, m */
  a: number;
  /** eccentricity, 0 ≤ e < 1 for bound orbits */
  e: number;
  /** inclination, degrees */
  i: number;
  /** longitude of ascending node, degrees */
  lan: number;
  /** argument of periapsis, degrees */
  argPeriapsis: number;
  /** true anomaly, degrees */
  trueAnomaly: number;
}

export interface StateVector {
  position: Vec3; // m
  velocity: Vec3; // m/s
}

const DEG = Math.PI / 180;

/**
 * Standard gravitational parameter for a two-body pair, μ = G(M + m).
 *
 * The satellite's mass matters when it isn't negligible (a binary, or the Moon
 * at ~1% of Earth): G·M alone gives a measurably wrong period. Test particles
 * pass `bodyMass = 0`, the default.
 */
export function gravitationalParameter(parentMass: number, bodyMass = 0): number {
  return G * (parentMass + bodyMass);
}

/** Orbital period from Kepler's third law, seconds. */
export function orbitalPeriod(a: number, parentMass: number, bodyMass = 0): number {
  const mu = gravitationalParameter(parentMass, bodyMass);
  return 2 * Math.PI * Math.sqrt((a * a * a) / mu);
}

/**
 * Speed at radius `r` on an orbit of semi-major axis `a` (vis-viva):
 * v² = μ(2/r − 1/a).
 */
export function visViva(r: number, a: number, parentMass: number, bodyMass = 0): number {
  const mu = gravitationalParameter(parentMass, bodyMass);
  return Math.sqrt(mu * (2 / r - 1 / a));
}

/**
 * Elements relative to a parent → absolute position & velocity. The parent's
 * own state is added in, so the result lands in the parent's frame.
 *
 * Textbook perifocal → inertial rotation: build the state in the orbital plane,
 * then rotate by argument of periapsis, inclination, and longitude of node.
 */
export function elementsToStateVector(
  parentMass: number,
  parent: StateVector,
  elements: OrbitalElements,
  bodyMass = 0
): StateVector {
  const { a, e } = elements;
  const mu = gravitationalParameter(parentMass, bodyMass);

  const i = elements.i * DEG;
  const lan = elements.lan * DEG;
  const argP = elements.argPeriapsis * DEG;
  const nu = elements.trueAnomaly * DEG;

  // Perifocal frame: periapsis along +x, motion toward +y.
  const p = a * (1 - e * e); // semi-latus rectum
  const cosNu = Math.cos(nu);
  const sinNu = Math.sin(nu);
  const r = p / (1 + e * cosNu);

  const xPf = r * cosNu;
  const yPf = r * sinNu;

  // v = sqrt(μ/p) · (−sin ν, e + cos ν) in the perifocal frame.
  const vFactor = Math.sqrt(mu / p);
  const vxPf = -vFactor * sinNu;
  const vyPf = vFactor * (e + cosNu);

  const cosO = Math.cos(lan);
  const sinO = Math.sin(lan);
  const cosW = Math.cos(argP);
  const sinW = Math.sin(argP);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);

  // Columns of R_z(Ω)·R_x(i)·R_z(ω) that act on (xPf, yPf, 0).
  const m11 = cosO * cosW - sinO * sinW * cosI;
  const m12 = -cosO * sinW - sinO * cosW * cosI;
  const m21 = sinO * cosW + cosO * sinW * cosI;
  const m22 = -sinO * sinW + cosO * cosW * cosI;
  const m31 = sinW * sinI;
  const m32 = cosW * sinI;

  return {
    position: vec3(
      parent.position.x + m11 * xPf + m12 * yPf,
      parent.position.y + m21 * xPf + m22 * yPf,
      parent.position.z + m31 * xPf + m32 * yPf
    ),
    velocity: vec3(
      parent.velocity.x + m11 * vxPf + m12 * vyPf,
      parent.velocity.y + m21 * vxPf + m22 * vyPf,
      parent.velocity.z + m31 * vxPf + m32 * vyPf
    ),
  };
}

/**
 * Convenience: circular orbit around a parent at `distance` (m) with
 * `inclination` and starting `phase` (degrees).
 */
export function circularOrbit(
  parentMass: number,
  parent: StateVector,
  distance: number,
  inclination = 0,
  phase = 0,
  bodyMass = 0
): StateVector {
  return elementsToStateVector(
    parentMass,
    parent,
    {
      a: distance,
      e: 0,
      i: inclination,
      lan: 0,
      argPeriapsis: 0,
      trueAnomaly: phase,
    },
    bodyMass
  );
}

/**
 * Circular-orbit velocity at an arbitrary `position`: speed √(μ/r) along ẑ × r̂,
 * prograde, matching the element convention above. The parent's own velocity is
 * added in.
 *
 * Unlike `circularOrbit` the position is given rather than derived from a phase
 * angle — the drop-a-body-here case. A z-offset from the parent still gets a
 * velocity perpendicular to the radial (an inclined circular orbit through the
 * point); a position on the parent's polar axis has no defined prograde
 * direction and falls back to +x.
 */
export function circularVelocityAt(
  parentMass: number,
  parent: StateVector,
  position: Vec3,
  bodyMass = 0
): Vec3 {
  const rx = position.x - parent.position.x;
  const ry = position.y - parent.position.y;
  const rz = position.z - parent.position.z;
  const r = Math.hypot(rx, ry, rz);
  if (r === 0) return clone(parent.velocity);

  const speed = Math.sqrt(gravitationalParameter(parentMass, bodyMass) / r);

  // ẑ × r = (−ry, rx, 0): perpendicular to the radial, horizontal, prograde.
  let tx = -ry;
  let ty = rx;
  const tMag = Math.hypot(tx, ty);
  if (tMag === 0) {
    tx = 1;
    ty = 0;
  } else {
    tx /= tMag;
    ty /= tMag;
  }

  return vec3(parent.velocity.x + speed * tx, parent.velocity.y + speed * ty, parent.velocity.z);
}

/**
 * State vector relative to a parent → orbital elements. Inverse of
 * `elementsToStateVector`; the info panel reads apsides and period off it.
 *
 * For an unbound orbit `a` is non-positive and `e ≥ 1`; presenting that is the
 * caller's decision.
 */
export function stateVectorToElements(
  parentMass: number,
  parent: StateVector,
  body: StateVector,
  bodyMass = 0
): OrbitalElements {
  const mu = gravitationalParameter(parentMass, bodyMass);

  const rx = body.position.x - parent.position.x;
  const ry = body.position.y - parent.position.y;
  const rz = body.position.z - parent.position.z;
  const vx = body.velocity.x - parent.velocity.x;
  const vy = body.velocity.y - parent.velocity.y;
  const vz = body.velocity.z - parent.velocity.z;

  const r = Math.hypot(rx, ry, rz);
  const vSq = vx * vx + vy * vy + vz * vz;

  // Specific angular momentum h = r × v.
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h = Math.hypot(hx, hy, hz);

  // Eccentricity vector e = (v × h)/μ − r̂.
  const ex = (vy * hz - vz * hy) / mu - rx / r;
  const ey = (vz * hx - vx * hz) / mu - ry / r;
  const ez = (vx * hy - vy * hx) / mu - rz / r;
  const e = Math.hypot(ex, ey, ez);

  // Specific orbital energy ⇒ semi-major axis.
  const energy = vSq / 2 - mu / r;
  const a = -mu / (2 * energy);

  const i = Math.acos(clampUnit(hz / h)) / DEG;

  // Node vector n = ẑ × h.
  const nx = -hy;
  const ny = hx;
  const nMag = Math.hypot(nx, ny);

  let lan: number;
  let argPeriapsis: number;

  if (nMag < 1e-12 * h) {
    // Equatorial: the ascending node is undefined, so pin it to the reference
    // direction and measure the periapsis argument from +x.
    lan = 0;
    argPeriapsis = Math.atan2(ey, ex) / DEG;
    if (hz < 0) argPeriapsis = -argPeriapsis;
  } else {
    lan = Math.atan2(ny, nx) / DEG;
    if (e < 1e-12) {
      argPeriapsis = 0;
    } else {
      argPeriapsis = Math.acos(clampUnit((nx * ex + ny * ey) / (nMag * e))) / DEG;
      if (ez < 0) argPeriapsis = 360 - argPeriapsis;
    }
  }

  let trueAnomaly: number;
  if (e < 1e-12) {
    // Circular: periapsis is undefined, so measure from the node (or from +x
    // when the orbit is also equatorial).
    if (nMag < 1e-12 * h) {
      trueAnomaly = Math.atan2(ry, rx) / DEG;
      if (hz < 0) trueAnomaly = -trueAnomaly;
    } else {
      trueAnomaly = Math.acos(clampUnit((nx * rx + ny * ry) / (nMag * r))) / DEG;
      if (rz < 0) trueAnomaly = 360 - trueAnomaly;
    }
  } else {
    trueAnomaly = Math.acos(clampUnit((ex * rx + ey * ry + ez * rz) / (e * r))) / DEG;
    // Negative radial velocity ⇒ inbound ⇒ second half of the orbit.
    if (rx * vx + ry * vy + rz * vz < 0) trueAnomaly = 360 - trueAnomaly;
  }

  return {
    a,
    e,
    i,
    lan: normalizeDegrees(lan),
    argPeriapsis: normalizeDegrees(argPeriapsis),
    trueAnomaly: normalizeDegrees(trueAnomaly),
  };
}

/** Guard acos against |x| drifting a few ulps past 1. */
function clampUnit(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

function normalizeDegrees(d: number): number {
  const m = d % 360;
  return m < 0 ? m + 360 : m;
}

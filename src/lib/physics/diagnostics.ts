// System diagnostics — total energy, momentum, barycenter.
//
// These are the health checks for the integrator: a symplectic method should
// hold total energy bounded (oscillating, not trending) and conserve momentum
// to floating-point noise.

import { G, SOFTENING } from './constants';
import { vec3, type Vec3 } from './vec3';
import type { PhysicsState } from './integrator';

const EPS_SQ = SOFTENING * SOFTENING;

/** Total kinetic energy, joules. */
export function kineticEnergy(state: PhysicsState): number {
  const { n, mass, vel } = state;
  let ke = 0;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const vx = vel[i3];
    const vy = vel[i3 + 1];
    const vz = vel[i3 + 2];
    ke += 0.5 * mass[i] * (vx * vx + vy * vy + vz * vz);
  }
  return ke;
}

/**
 * Total gravitational potential energy, joules (negative for a bound system).
 *
 * Uses the same softened separation as `computeAccelerations` — U = −G·m₁·m₂ /
 * sqrt(|d|² + ε²). Pairing the softened potential with the softened force is
 * what makes the energy-drift test measure integrator quality instead of an
 * inconsistency between the two.
 */
export function potentialEnergy(state: PhysicsState): number {
  const { n, mass, pos } = state;
  let pe = 0;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    for (let j = i + 1; j < n; j++) {
      const j3 = j * 3;
      const dx = pos[j3] - pos[i3];
      const dy = pos[j3 + 1] - pos[i3 + 1];
      const dz = pos[j3 + 2] - pos[i3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz + EPS_SQ);
      pe -= (G * mass[i] * mass[j]) / dist;
    }
  }
  return pe;
}

/** Total energy (kinetic + potential), joules. */
export function totalEnergy(state: PhysicsState): number {
  return kineticEnergy(state) + potentialEnergy(state);
}

/** Total linear momentum, kg·m/s. */
export function totalMomentum(state: PhysicsState): Vec3 {
  const { n, mass, vel } = state;
  const p = vec3();
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const m = mass[i];
    p.x += m * vel[i3];
    p.y += m * vel[i3 + 1];
    p.z += m * vel[i3 + 2];
  }
  return p;
}

/** Center of mass, m. Returns the origin for an empty or massless system. */
export function barycenter(state: PhysicsState): Vec3 {
  const { n, mass, pos } = state;
  const c = vec3();
  let totalMass = 0;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const m = mass[i];
    totalMass += m;
    c.x += m * pos[i3];
    c.y += m * pos[i3 + 1];
    c.z += m * pos[i3 + 2];
  }
  if (totalMass === 0) return c;
  c.x /= totalMass;
  c.y /= totalMass;
  c.z /= totalMass;
  return c;
}

/** Barycenter velocity, m/s — the drift of the system as a whole. */
export function barycenterVelocity(state: PhysicsState): Vec3 {
  const { n, mass } = state;
  const p = totalMomentum(state);
  let totalMass = 0;
  for (let i = 0; i < n; i++) totalMass += mass[i];
  if (totalMass === 0) return p;
  p.x /= totalMass;
  p.y /= totalMass;
  p.z /= totalMass;
  return p;
}

// Velocity Verlet integrator (symplectic — bounded energy drift), fixed
// timestep.
//
// State is parallel Float64Arrays with xyz-interleaved pos/vel/acc (length 3n):
// cache-friendly, allocation-free in the hot loop, directly snapshottable.
//
// Determinism is a hard requirement — the same initial state and dt must
// reproduce the same trajectory bit for bit. Nothing here reads wall-clock time
// or frame deltas.

import { computeAccelerations, type ContactList } from './gravity';
import { schwarzschildRadius } from './constants';
import type { Body } from '../types';

export interface PhysicsState {
  /** number of bodies */
  n: number;
  /** kg, length n */
  mass: Float64Array;
  /** m, length n */
  radius: Float64Array;
  /**
   * Schwarzschild radius, m, length n — nonzero only for black holes, where it
   * is always `schwarzschildRadius(mass[i])`. Nonzero switches every pair
   * involving that body to the Paczyński–Wiita pseudo-potential in
   * `computeAccelerations`; zero keeps the Newtonian force bit-for-bit.
   */
  rs: Float64Array;
  /** m, xyz interleaved, length 3n */
  pos: Float64Array;
  /** m/s, xyz interleaved, length 3n */
  vel: Float64Array;
  /** m/s², xyz interleaved, length 3n — carried between steps */
  acc: Float64Array;
}

export function createState(n: number): PhysicsState {
  return {
    n,
    mass: new Float64Array(n),
    radius: new Float64Array(n),
    rs: new Float64Array(n),
    pos: new Float64Array(3 * n),
    vel: new Float64Array(3 * n),
    acc: new Float64Array(3 * n),
  };
}

export function rsFor(body: Pick<Body, 'type' | 'mass'>): number {
  return body.type === 'blackhole' ? schwarzschildRadius(body.mass) : 0;
}

/**
 * Index-aligned with `bodies`; primes the accelerations so the first `step`
 * is a valid Verlet step.
 */
export function stateFromBodies(bodies: readonly Body[]): PhysicsState {
  const state = createState(bodies.length);
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const i3 = i * 3;
    state.mass[i] = b.mass;
    state.radius[i] = b.radius;
    state.rs[i] = rsFor(b);
    state.pos[i3] = b.position.x;
    state.pos[i3 + 1] = b.position.y;
    state.pos[i3 + 2] = b.position.z;
    state.vel[i3] = b.velocity.x;
    state.vel[i3 + 1] = b.velocity.y;
    state.vel[i3 + 2] = b.velocity.z;
  }
  computeAccelerations(state);
  return state;
}

/** Deep copy — used by seek/snapshot paths and by throwaway clones. */
export function copyState(state: PhysicsState): PhysicsState {
  return {
    n: state.n,
    mass: state.mass.slice(),
    radius: state.radius.slice(),
    rs: state.rs.slice(),
    pos: state.pos.slice(),
    vel: state.vel.slice(),
    acc: state.acc.slice(),
  };
}

/**
 * Advance `state` by one fixed timestep `dt` (seconds) using velocity Verlet:
 *
 *   x += v·dt + ½a·dt²
 *   recompute a′
 *   v += ½(a + a′)·dt
 *
 * `state.acc` must hold the accelerations for the current positions on entry
 * (`stateFromBodies` primes them); on exit it holds a′. Code that mutates
 * positions out from under the integrator must call `computeAccelerations`
 * before stepping again.
 *
 * `contacts`, if given, receives the overlapping pairs at the *post-drift*
 * positions — the ones the caller should resolve after this step returns.
 */
export function step(state: PhysicsState, dt: number, contacts?: ContactList): void {
  const { n, pos, vel, acc } = state;
  const len = 3 * n;
  const halfDt = 0.5 * dt;

  // Half-kick then drift: algebraically identical to x += v·dt + ½a·dt², and
  // leaves vel holding v + ½a·dt so the second half-kick only needs a′.
  for (let k = 0; k < len; k++) {
    vel[k] += acc[k] * halfDt;
    pos[k] += vel[k] * dt;
  }

  computeAccelerations(state, contacts);

  for (let k = 0; k < len; k++) {
    vel[k] += acc[k] * halfDt;
  }
}

// Shared helpers for physics tests. Not imported by app code.

import { vec3 } from './vec3';
import type { StateVector } from './kepler';
import type { Body, BodyType } from '../types';

let counter = 0;

/** A minimal Body with sane defaults — tests override only what they care about. */
export function testBody(overrides: Partial<Body> & { mass: number }): Body {
  counter += 1;
  return {
    id: `test-${counter}`,
    name: `Test ${counter}`,
    color: '#ffffff',
    type: 'rocky' as BodyType,
    radius: 1e6,
    rotationPeriod: 86400,
    axialTilt: 0,
    position: vec3(),
    velocity: vec3(),
    ...overrides,
  };
}

/** A body at rest at the origin — the usual parent for orbit construction. */
export const AT_ORIGIN: StateVector = {
  position: vec3(),
  velocity: vec3(),
};

export function positionOf(
  state: { pos: Float64Array },
  i: number
): { x: number; y: number; z: number } {
  return vec3(state.pos[i * 3], state.pos[i * 3 + 1], state.pos[i * 3 + 2]);
}

export function velocityOf(
  state: { vel: Float64Array },
  i: number
): { x: number; y: number; z: number } {
  return vec3(state.vel[i * 3], state.vel[i * 3 + 1], state.vel[i * 3 + 2]);
}

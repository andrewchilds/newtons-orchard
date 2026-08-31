// Geometry for the toolbar's quarter-turn camera buttons. Pure functions over
// vectors, so the easily-wrong parts are unit-testable; SceneCanvas owns the
// animation and the camera writes.
//
// Turns are *screen-relative*: "down" pitches about the camera's right vector,
// "right" yaws about its up, "roll" spins about the view direction. A turn
// about a fixed world axis instead degenerates when the camera sits on that
// axis — the click only rolls the horizon. Deriving the axis from the camera
// has no such pole.

import * as THREE from 'three';
import type { CameraTurn } from '../state/ui.svelte';

const HALF_PI = Math.PI / 2;

/** How long a quarter turn takes, seconds — the same for every button. */
export const TURN_SECONDS = 0.5;

export function turnDuration(_from: THREE.Vector3, _to: THREE.Vector3): number {
  return TURN_SECONDS;
}

/** The world axes, used to square a view onto the 90° grid. */
const WORLD_AXES: readonly THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

/**
 * Snap `up` to whichever world axis it lies closest to, excluding the one the
 * camera looks along (that direction is degenerate as an up). Mutates `up`.
 */
const squareView = new THREE.Vector3();
export function squareToNearestAxis(up: THREE.Vector3, offset: THREE.Vector3): void {
  squareView.copy(offset).normalize();
  let best: THREE.Vector3 | null = null;
  let bestDot = -Infinity;
  let bestSign = 1;
  for (const candidate of WORLD_AXES) {
    if (Math.abs(squareView.dot(candidate)) > 0.999) continue;
    const dot = up.dot(candidate);
    if (Math.abs(dot) > bestDot) {
      bestDot = Math.abs(dot);
      best = candidate;
      bestSign = dot < 0 ? -1 : 1;
    }
  }
  if (best) up.copy(best).multiplyScalar(bestSign);
  up.normalize();
}

/**
 * Snap a vector onto the nearest world axis, preserving its length. Puts a
 * tumbled camera exactly down one axis so the next click steps a clean quadrant.
 */
function snapToGrid(v: THREE.Vector3, out: THREE.Vector3): void {
  const length = v.length();
  if (length === 0) {
    out.copy(v);
    return;
  }
  let bestAxis = WORLD_AXES[0];
  let bestDot = -Infinity;
  let bestSign = 1;
  for (const axis of WORLD_AXES) {
    const dot = v.dot(axis) / length;
    if (Math.abs(dot) > bestDot) {
      bestDot = Math.abs(dot);
      bestAxis = axis;
      bestSign = dot < 0 ? -1 : 1;
    }
  }
  out.copy(bestAxis).multiplyScalar(bestSign * length);
}

/** How close to a world axis counts as already square, as a direction cosine. */
const SQUARE_TOLERANCE = 0.9999;

function isSquare(offset: THREE.Vector3): boolean {
  const length = offset.length();
  if (length === 0) return true;
  for (const axis of WORLD_AXES) {
    if (Math.abs(offset.dot(axis) / length) > SQUARE_TOLERANCE) return true;
  }
  return false;
}

const turnRotation = new THREE.Quaternion();
const turnAxis = new THREE.Vector3();
const viewDirection = new THREE.Vector3();
const rightVector = new THREE.Vector3();
const trueUp = new THREE.Vector3();

/**
 * Where a quarter turn lands the camera, written into `outOffset` / `outUp`.
 * `offset` is the camera's position relative to what it orbits; `up` is its
 * current up vector. Inputs are not modified.
 *
 * A tumbled view is squared onto the 90° grid first and the step applied only
 * if it was already square, so the first click levels up and later clicks are
 * clean quarter turns. Stepping a tumbled view directly would carry its tilt
 * around forever and never recover a square view.
 *
 * The turn axis comes from the camera's own basis:
 *
 * - `down`  pitches about the right vector — the view tips downward.
 * - `right` yaws about the up vector — the view swings rightward.
 * - `roll`  spins about the view direction; `outOffset` is unchanged.
 */
export function quarterTurnTarget(
  turn: CameraTurn,
  offset: THREE.Vector3,
  up: THREE.Vector3,
  outOffset: THREE.Vector3,
  outUp: THREE.Vector3
): void {
  // If the view wasn't on the grid, the snap *is* this click.
  if (!isSquare(offset)) {
    snapToGrid(offset, outOffset);
    outUp.copy(up);
    squareToNearestAxis(outUp, outOffset);
    return;
  }

  // Camera basis; view direction points from camera toward target. `up` may be
  // slightly off-perpendicular, so right is view × up and up is recomputed from
  // it rather than trusted directly.
  viewDirection.copy(offset).normalize().negate();
  rightVector.crossVectors(viewDirection, up).normalize();
  trueUp.crossVectors(rightVector, viewDirection).normalize();

  // Degenerate basis (`up` parallel to the view direction). Shouldn't happen,
  // but a NaN here would silently poison the camera.
  if (rightVector.lengthSq() < 0.5) {
    outOffset.copy(offset);
    outUp.copy(up);
    return;
  }

  switch (turn) {
    case 'down':
      // Negative so the *view* tips down, moving the camera up over the top.
      turnAxis.copy(rightVector);
      turnRotation.setFromAxisAngle(turnAxis, -HALF_PI);
      break;
    case 'right':
      // Negative so the scene swings right, i.e. the camera orbits left.
      turnAxis.copy(trueUp);
      turnRotation.setFromAxisAngle(turnAxis, -HALF_PI);
      break;
    case 'roll':
      // The camera doesn't move, so only `up` turns. Negative because
      // `viewDirection` points away from the viewer: a right-handed +90° about
      // it turns the scene counter-clockwise on screen, opposite the icon.
      turnRotation.setFromAxisAngle(viewDirection, -HALF_PI);
      outOffset.copy(offset);
      outUp.copy(up).applyQuaternion(turnRotation).normalize();
      return;
  }

  outOffset.copy(offset).applyQuaternion(turnRotation);
  outUp.copy(trueUp).applyQuaternion(turnRotation);

  // Square the horizon: a rigid rotation alone carries residual roll around
  // with it, and the snap is a no-op once the view is on the grid.
  squareToNearestAxis(outUp, outOffset);
}

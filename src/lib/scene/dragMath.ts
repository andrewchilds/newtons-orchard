// Screen → world math for direct-manipulation drags (place, move, velocity).
//
// Drags happen on a plane of constant z, parallel to the ecliptic — the scene's
// xy-plane (kepler.ts builds orbits in z = 0, camera up is +z). These helpers
// turn a pointer position into a point on such a plane and convert between
// rendered scene coordinates (reference-frame-shifted, ÷ SCENE_SCALE) and
// world meters.

import * as THREE from 'three';
import { SCENE_SCALE } from './sceneManager';
import { vec3, type Vec3 } from '../physics/vec3';

/**
 * Reject rays this close to parallel with the drag plane (|direction.z|, ≈ 2°).
 * A grazing intersection lands astronomically far away and a pixel of pointer
 * motion moves it by whole orbits; the drag holds its last valid point instead.
 */
export const GRAZING_DIR_Z = 0.035;

export function pointerNdc(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  out: THREE.Vector2
): THREE.Vector2 {
  out.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  out.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  return out;
}

const raycaster = new THREE.Raycaster();

/**
 * Intersect the pointer ray with the plane z = `zPlane` (scene units). Null
 * when the ray grazes the plane, points away, or hits beyond the camera's far
 * plane; callers keep their previous point.
 */
export function intersectZPlane(
  camera: THREE.PerspectiveCamera,
  ndc: THREE.Vector2,
  zPlane: number,
  out: THREE.Vector3
): THREE.Vector3 | null {
  raycaster.setFromCamera(ndc, camera);
  const { origin, direction } = raycaster.ray;
  if (Math.abs(direction.z) < GRAZING_DIR_Z) return null;
  const t = (zPlane - origin.z) / direction.z;
  if (t <= 0 || t > camera.far) return null;
  return out.copy(direction).multiplyScalar(t).add(origin);
}

/**
 * Rendered scene coordinates → world meters. `refWorldM` is the reference
 * body's world position in meters (null in the barycentric frame) — the same
 * offset `SceneManager.render` subtracts before scaling.
 */
export function sceneToWorldM(scenePoint: { x: number; y: number; z: number }, refWorldM: Vec3 | null): Vec3 {
  return vec3(
    scenePoint.x * SCENE_SCALE + (refWorldM?.x ?? 0),
    scenePoint.y * SCENE_SCALE + (refWorldM?.y ?? 0),
    scenePoint.z * SCENE_SCALE + (refWorldM?.z ?? 0)
  );
}

/** World z (meters) → the rendered scene z of the drag plane through it. */
export function worldZToSceneZ(zM: number, refWorldM: Vec3 | null): number {
  return (zM - (refWorldM?.z ?? 0)) / SCENE_SCALE;
}

/**
 * Reject an axis drag when the ray is this close to parallel with the axis
 * (|sin| between them, ≈ 3.4°). Looking down an axis, a pixel of pointer motion
 * slides the nearest point unboundedly — the `GRAZING_DIR_Z` pathology again.
 */
export const GRAZING_AXIS_SIN = 0.06;

/**
 * Distance along `axis` (unit, from `origin`) of the point on that line closest
 * to the pointer ray. Null when the ray nearly parallels the line; callers keep
 * their previous value.
 *
 * Closest approach of two skew lines: for ray `p + t·d`, line `origin + s·axis`
 * and `w = p − origin`, `s = (w·a − (w·d)(a·d)) / (1 − (a·d)²)`. The
 * denominator is sin² of the angle between them, vanishing exactly in the
 * grazing case rejected above.
 */
export function closestPointOnAxis(
  camera: THREE.PerspectiveCamera,
  ndc: THREE.Vector2,
  origin: THREE.Vector3,
  axis: THREE.Vector3
): number | null {
  raycaster.setFromCamera(ndc, camera);
  const { origin: rayOrigin, direction } = raycaster.ray;

  const axisDotDir = axis.dot(direction);
  const sinSq = 1 - axisDotDir * axisDotDir;
  if (sinSq < GRAZING_AXIS_SIN * GRAZING_AXIS_SIN) return null;

  axisW.subVectors(rayOrigin, origin);
  return (axisW.dot(axis) - axisW.dot(direction) * axisDotDir) / sinSq;
}

const axisW = new THREE.Vector3();

export function worldMToScene(
  worldM: Vec3,
  refWorldM: Vec3 | null,
  out: THREE.Vector3
): THREE.Vector3 {
  return out.set(
    (worldM.x - (refWorldM?.x ?? 0)) / SCENE_SCALE,
    (worldM.y - (refWorldM?.y ?? 0)) / SCENE_SCALE,
    (worldM.z - (refWorldM?.z ?? 0)) / SCENE_SCALE
  );
}

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  closestPointOnAxis,
  intersectZPlane,
  pointerNdc,
  sceneToWorldM,
  worldZToSceneZ,
} from './dragMath';
import { SCENE_SCALE } from './sceneManager';
import { vec3 } from '../physics/vec3';

/** A camera looking at the origin from above and behind, ecliptic up. */
function makeCamera(position = new THREE.Vector3(0, -100, 50), far = 1e6): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.001, far);
  camera.up.set(0, 0, 1);
  camera.position.copy(position);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('pointerNdc', () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 } as DOMRect;

  it('maps the rect center to (0, 0)', () => {
    const ndc = pointerNdc(110, 70, rect, new THREE.Vector2());
    expect(ndc.x).toBeCloseTo(0, 9);
    expect(ndc.y).toBeCloseTo(0, 9);
  });

  it('maps corners to ±1 with y flipped', () => {
    const topLeft = pointerNdc(10, 20, rect, new THREE.Vector2());
    expect(topLeft.x).toBeCloseTo(-1, 9);
    expect(topLeft.y).toBeCloseTo(1, 9);

    const bottomRight = pointerNdc(210, 120, rect, new THREE.Vector2());
    expect(bottomRight.x).toBeCloseTo(1, 9);
    expect(bottomRight.y).toBeCloseTo(-1, 9);
  });
});

describe('intersectZPlane', () => {
  it('hits the plane where the view ray crosses it', () => {
    // Camera looks straight at the origin, which sits on the z = 0 plane.
    const camera = makeCamera();
    const hit = intersectZPlane(camera, new THREE.Vector2(0, 0), 0, new THREE.Vector3());

    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(0, 6);
    expect(hit!.y).toBeCloseTo(0, 6);
    expect(hit!.z).toBeCloseTo(0, 6);
  });

  it('respects a non-zero plane height', () => {
    const camera = makeCamera(new THREE.Vector3(0, 0, 100));
    // Looking straight down from (0, 0, 100) at a plane z = 40.
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const hit = intersectZPlane(camera, new THREE.Vector2(0, 0), 40, new THREE.Vector3());

    expect(hit).not.toBeNull();
    expect(hit!.z).toBeCloseTo(40, 6);
  });

  it('rejects a grazing ray', () => {
    // Camera in the plane itself, looking along it: direction.z = 0.
    const camera = new THREE.PerspectiveCamera(55, 1, 0.001, 1e6);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -100, 0);
    camera.lookAt(0, 100, 0);
    camera.updateMatrixWorld(true);

    expect(intersectZPlane(camera, new THREE.Vector2(0, 0), 0, new THREE.Vector3())).toBeNull();
  });

  it('rejects a plane behind the camera', () => {
    // Looking down from z = 50; a plane at z = 200 is behind the ray.
    const camera = makeCamera(new THREE.Vector3(0, -10, 50));
    expect(intersectZPlane(camera, new THREE.Vector2(0, 0), 200, new THREE.Vector3())).toBeNull();
  });

  it('rejects an intersection beyond the far plane', () => {
    const camera = makeCamera(new THREE.Vector3(0, -100, 50), 10);
    expect(intersectZPlane(camera, new THREE.Vector2(0, 0), 0, new THREE.Vector3())).toBeNull();
  });
});

describe('closestPointOnAxis', () => {
  // The default `makeCamera` pose, well off any axis. A camera placed at
  // (0, 0, z) looking at the origin is NOT usable here: the view direction is
  // then parallel to `camera.up`, the degenerate case for `lookAt`, and Three
  // resolves it with a slight tilt rather than a clean top-down orientation.

  it('returns the offset of the point the ray points at', () => {
    // The camera looks at the origin, so the center pixel's ray passes
    // through it — and the origin is where the x axis has s = 0.
    const camera = makeCamera();
    const s = closestPointOnAxis(
      camera,
      new THREE.Vector2(0, 0),
      new THREE.Vector3(),
      new THREE.Vector3(1, 0, 0)
    );
    expect(s).not.toBeNull();
    expect(s!).toBeCloseTo(0, 6);
  });

  it('is signed along the axis direction', () => {
    // The camera sits on -y looking at +y, so screen-right is +x. A pointer
    // right of center must read a positive component, left a negative one —
    // the drag must not flip the sign of what it edits.
    const camera = makeCamera();
    const origin = new THREE.Vector3();
    const axis = new THREE.Vector3(1, 0, 0);

    const right = closestPointOnAxis(camera, new THREE.Vector2(0.5, 0), origin, axis);
    const left = closestPointOnAxis(camera, new THREE.Vector2(-0.5, 0), origin, axis);
    expect(right!).toBeGreaterThan(0);
    expect(left!).toBeCloseTo(-right!, 6);
  });

  it('measures from the supplied origin, not the world origin', () => {
    const camera = makeCamera();
    // The center ray still passes through the world origin, so an axis
    // anchored at x = 7 reads that same point as s = -7.
    const s = closestPointOnAxis(
      camera,
      new THREE.Vector2(0, 0),
      new THREE.Vector3(7, 0, 0),
      new THREE.Vector3(1, 0, 0)
    );
    expect(s!).toBeCloseTo(-7, 6);
  });

  it('agrees with a brute-force search over the line', () => {
    const camera = makeCamera(new THREE.Vector3(40, -100, 60));
    const origin = new THREE.Vector3(3, -2, 5);

    for (const axis of [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ]) {
      for (const ndc of [new THREE.Vector2(0.3, 0.2), new THREE.Vector2(-0.4, 0.6)]) {
        const s = closestPointOnAxis(camera, ndc, origin, axis);
        expect(s).not.toBeNull();

        // Scan the line for the point of closest approach to the same ray.
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, camera);
        const distanceAt = (t: number): number => {
          const point = origin.clone().addScaledVector(axis, t);
          return raycaster.ray.distanceToPoint(point);
        };
        // Scan a window around zero rather than around s, so a wrong-signed
        // or offset result can't drag the search to agree with itself.
        let best = -120;
        for (let t = -120; t <= 120; t += 0.002) {
          if (distanceAt(t) < distanceAt(best)) best = t;
        }
        expect(s!).toBeCloseTo(best, 2);
      }
    }
  });

  it('rejects a ray that parallels the axis', () => {
    // Camera on the y axis looking down it, so the y handle is edge-on and a
    // pixel of pointer motion would slide it arbitrarily far.
    const camera = new THREE.PerspectiveCamera(55, 1, 0.001, 1e6);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -100, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const s = closestPointOnAxis(
      camera,
      new THREE.Vector2(0, 0),
      new THREE.Vector3(),
      new THREE.Vector3(0, 1, 0)
    );
    expect(s).toBeNull();
  });
});

describe('scene ↔ world conversion', () => {
  it('round-trips through a non-zero reference offset', () => {
    const refM = vec3(3e11, -2e11, 5e10);
    const scenePoint = { x: 150, y: -40, z: 7 };

    const world = sceneToWorldM(scenePoint, refM);
    expect(world.x).toBeCloseTo(150 * SCENE_SCALE + 3e11, 0);
    expect(world.y).toBeCloseTo(-40 * SCENE_SCALE - 2e11, 0);
    expect(world.z).toBeCloseTo(7 * SCENE_SCALE + 5e10, 0);

    // Back: the plane through that world z renders at the original scene z.
    expect(worldZToSceneZ(world.z, refM)).toBeCloseTo(scenePoint.z, 9);
  });

  it('treats a null reference as the barycentric frame', () => {
    const world = sceneToWorldM({ x: 1, y: 2, z: 3 }, null);
    expect(world.x).toBe(1 * SCENE_SCALE);
    expect(world.z).toBe(3 * SCENE_SCALE);
    expect(worldZToSceneZ(world.z, null)).toBe(3);
  });
});

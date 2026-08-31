// Click-to-select raycasting.
//
// Bodies are tiny even with radius exaggeration — Earth at ×500 is still a
// sub-pixel target from a system-wide view — so raycasting the visible meshes
// alone makes selection nearly impossible. Each body therefore carries an
// invisible hit sphere sized to a minimum *screen* footprint, and picking tests
// those instead.

import * as THREE from 'three';

/** Approximate on-screen radius, in pixels, that a hit sphere should cover. */
const MIN_PICK_PIXELS = 14;

export class Picker {
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  /**
   * Scale every hit sphere so it covers at least MIN_PICK_PIXELS on screen,
   * without ever shrinking below the body's visible radius.
   *
   * The projection is the standard perspective one: an object of radius r at
   * distance d subtends `r / (d · tan(fov/2))` of the half-height.
   */
  updateHitSpheres(
    hitSpheres: Iterable<{ sphere: THREE.Mesh; visualRadius: number }>,
    camera: THREE.PerspectiveCamera,
    viewportHeight: number
  ): void {
    const halfFovTan = Math.tan((camera.fov * Math.PI) / 360);
    const perPixel = (2 * halfFovTan) / Math.max(1, viewportHeight);

    for (const { sphere, visualRadius } of hitSpheres) {
      const distance = camera.position.distanceTo(sphere.position);
      const minRadius = distance * perPixel * MIN_PICK_PIXELS;
      sphere.scale.setScalar(Math.max(visualRadius, minRadius));
    }
  }

  /** Each target mesh must carry its body id in `userData.bodyId`. */
  pick(
    event: { clientX: number; clientY: number },
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    targets: THREE.Object3D[]
  ): string | null {
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, camera);
    const hits = this.raycaster.intersectObjects(targets, false);

    for (const hit of hits) {
      const id = hit.object.userData.bodyId;
      if (typeof id === 'string') return id;
    }
    return null;
  }
}

/**
 * A selection marker: a thin billboarded ring that sits around the selected
 * body and stays a constant size on screen, so it's findable regardless of how
 * far out the camera is.
 */
export class SelectionMarker {
  private group: THREE.Group;
  private ring: THREE.Mesh;
  private geometry: THREE.RingGeometry;
  private material: THREE.MeshBasicMaterial;
  /** A wider, fainter, additively-blended ring under the crisp one, which is
   * what makes the outline read as glowing rather than just drawn. */
  private glow: THREE.Mesh;
  private glowGeometry: THREE.RingGeometry;
  private glowMaterial: THREE.MeshBasicMaterial;

  constructor(ringColor = 0x3d9bff, glowColor = 0x2f8bff) {
    this.geometry = new THREE.RingGeometry(1, 1.045, 64);
    this.material = new THREE.MeshBasicMaterial({
      color: ringColor,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(this.geometry, this.material);

    this.glowGeometry = new THREE.RingGeometry(0.94, 1.11, 64);
    this.glowMaterial = new THREE.MeshBasicMaterial({
      color: glowColor,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.glow = new THREE.Mesh(this.glowGeometry, this.glowMaterial);

    this.group = new THREE.Group();
    this.group.add(this.glow, this.ring);
    this.group.visible = false;
    this.ring.frustumCulled = false;
    this.glow.frustumCulled = false;
    // Draw over everything: a marker hidden behind its own planet is useless.
    this.glow.renderOrder = 10;
    this.ring.renderOrder = 11;
  }

  get object(): THREE.Object3D {
    return this.group;
  }

  hide(): void {
    this.group.visible = false;
  }

  /**
   * Park the ring on `position`, sized to sit just outside a body of
   * `visualRadius` but never smaller than a fixed screen size, and turned to
   * face the camera.
   */
  show(
    position: THREE.Vector3,
    visualRadius: number,
    camera: THREE.PerspectiveCamera,
    viewportHeight: number
  ): void {
    const distance = camera.position.distanceTo(position);
    const perPixel = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight);
    const minRadius = distance * perPixel * 18;

    this.group.position.copy(position);
    this.group.scale.setScalar(Math.max(visualRadius * 1.6, minRadius));
    this.group.quaternion.copy(camera.quaternion);
    this.group.visible = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.glowGeometry.dispose();
    this.glowMaterial.dispose();
  }
}

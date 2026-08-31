// A screen-space dot per body, so a to-scale planet still registers like a
// background star instead of vanishing when its disc drops below a pixel.
//
// Same rendering rules as the starfield (see `createStarfield`): points are
// screen-space sized, not `sizeAttenuation` — an attenuated sub-pixel point
// lands on a different sample every frame and shimmers under bloom — and the
// color ceiling keeps every dot below the bloom pass's 0.62 threshold.

import * as THREE from 'three';

const WHITE = new THREE.Color(0xffffff);

/**
 * Peak channel value for a dot. Two constraints: bright enough to outrank the
 * starfield (whose stars top out at 0.56), dim enough to stay under the bloom
 * threshold. All dots normalize to the same peak — a dot is a legibility
 * floor, so a dark body's dot must read as well as a white one's.
 */
const DOT_PEAK = 0.6;

/**
 * How far a dot's hue leans toward white before normalizing. Pure saturated
 * colors carry their energy in one channel and read dimmer than their peak
 * suggests (the trail-dash lesson: a 1px line in a dark color is invisible).
 */
const WHITE_MIX = 0.3;

export class BodyDots {
  readonly object: THREE.Points;

  private geometry = new THREE.BufferGeometry();
  private material: THREE.PointsMaterial;
  private positions = new Float32Array(64 * 3);
  private colors = new Float32Array(64 * 3);
  private count = 0;
  /** body id → normalized linear dot color */
  private colorById = new Map<string, THREE.Color>();
  private scratchColor = new THREE.Color();

  constructor() {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.material = new THREE.PointsMaterial({
      size: 2.0,
      sizeAttenuation: false,
      vertexColors: true,
      // Additive so the fade-out (color scaled toward black) blends to nothing
      // instead of stamping a dark square over background stars.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.name = 'body-dots';
    // The point set changes every frame; a stale bounding sphere would cull it.
    this.object.frustumCulled = false;
  }

  setColor(id: string, hex: string): void {
    const color = this.scratchColor.set(hex).lerp(WHITE, WHITE_MIX);
    const peak = Math.max(color.r, color.g, color.b);
    this.colorById.set(id, color.clone().multiplyScalar(peak > 0 ? DOT_PEAK / peak : 0));
  }

  remove(id: string): void {
    this.colorById.delete(id);
  }

  /** Reset for this frame's `add` calls; `commit` publishes them. */
  begin(): void {
    this.count = 0;
  }

  /**
   * Queue a dot at `position` (scene units) for body `id`, at `fade` ∈ [0, 1].
   * The caller offsets the position off the body's near surface — at the
   * center it sits behind the mesh's front faces and fails the depth test.
   */
  add(id: string, position: THREE.Vector3, fade: number): void {
    const color = this.colorById.get(id);
    if (!color || fade <= 0) return;
    if (this.count * 3 >= this.positions.length) this.grow();
    const i3 = this.count * 3;
    this.positions[i3] = position.x;
    this.positions[i3 + 1] = position.y;
    this.positions[i3 + 2] = position.z;
    this.colors[i3] = color.r * fade;
    this.colors[i3 + 1] = color.g * fade;
    this.colors[i3 + 2] = color.b * fade;
    this.count += 1;
  }

  commit(): void {
    this.geometry.setDrawRange(0, this.count);
    if (this.count === 0) return;
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private grow(): void {
    const positions = new Float32Array(this.positions.length * 2);
    const colors = new Float32Array(this.colors.length * 2);
    positions.set(this.positions);
    colors.set(this.colors);
    this.positions = positions;
    this.colors = colors;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
}

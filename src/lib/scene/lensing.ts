// Screen-space gravitational lensing for black holes.
//
// A full-screen post pass warps the rendered frame around each visible hole by
// the point-mass lens equation: for an observed direction θ (angle from the
// hole's center), the light came from
//
//     β = θ − θ_E² / θ,  θ_E = √(2 r_s / D)
//
// for a backdrop at infinity and an observer at distance D. Applied as a UV
// displacement this yields arcs, doubled images and the Einstein ring for free.
// The drawn shadow is the photon-sphere capture radius √27/2 · r_s ≈ 2.6 r_s,
// which is what an observer sees — not the 1 r_s horizon the scene mesh models.
//
// Screen-space warping bends foreground bodies along with the background. That
// trade beats rendering the scene twice; transits are rare.
//
// The weak-field formula fails within a few r_s (θ_E → radians, tan θ_E → ∞),
// so angles clamp to MAX_ANGLE; by then the shadow fills the frame anyway.

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/** The shadow (photon-capture) radius in units of r_s: √27/2. */
export const SHADOW_FACTOR = Math.sqrt(27) / 2;

/** Most simultaneous lenses the shader loops over; extras are ignored. */
export const MAX_LENSES = 4;

/**
 * Ceiling on both angles, radians. Near the photon sphere the weak-field math
 * is meaningless and tan() diverges; capping keeps the uniforms finite.
 */
const MAX_ANGLE = 1.2;

/**
 * Below this ring radius (NDC-height units) the warp is invisible; the lens is
 * skipped so a distant hole doesn't force the post chain on.
 */
const MIN_RING_NDC = 2e-3;

/** Einstein radius θ_E = √(2 r_s / D), radians, for a source at infinity. */
export function einsteinAngle(rs: number, distance: number): number {
  if (rs <= 0 || distance <= 0) return 0;
  return Math.min(Math.sqrt((2 * rs) / distance), MAX_ANGLE);
}

/** Apparent angular radius of the shadow, asin(√27/2 · r_s / D), radians. */
export function shadowAngle(rs: number, distance: number): number {
  if (rs <= 0 || distance <= 0) return 0;
  return Math.min(Math.asin(Math.min((SHADOW_FACTOR * rs) / distance, 1)), MAX_ANGLE);
}

/** A hole to lens around: rendered position and r_s, both in scene units. */
export interface LensSource {
  id: string;
  position: THREE.Vector3;
  rs: number;
}

// Screen math is in "aspect-corrected NDC": y spans [-1, 1], x spans [-aspect,
// aspect], so distances are isotropic and circles stay circular. Each lens
// packs as (center.x, center.y, θ_E², shadow radius) in those units.
const LensingShader = {
  name: 'GravitationalLensingShader',

  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uCount: { value: 0 },
    uAspect: { value: 1 },
    /** one pixel in NDC-height units, for the shadow's edge feather */
    uPixel: { value: 2e-3 },
    uLenses: { value: Array.from({ length: MAX_LENSES }, () => new THREE.Vector4()) },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    #define MAX_LENSES ${MAX_LENSES}

    uniform sampler2D tDiffuse;
    uniform int uCount;
    uniform float uAspect;
    uniform float uPixel;
    uniform vec4 uLenses[MAX_LENSES];
    varying vec2 vUv;

    void main() {
      vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
      // Deflections sum across lenses: exact for one hole, an approximation
      // for overlapping ones.
      vec2 q = p;
      float dark = 0.0;

      for (int i = 0; i < MAX_LENSES; i++) {
        if (i >= uCount) break;
        vec2 d = p - uLenses[i].xy;
        float r2 = max(dot(d, d), 1e-8);
        // β = θ − θ_E²/θ in vector form: displace toward the hole. Inside the
        // Einstein radius it overshoots the center — that's the inverted
        // secondary image, not an artifact.
        q -= d * (uLenses[i].z / r2);

        // The shadow, feathered ~a pixel so the rim doesn't alias; the soft
        // edge doubles as the bright limb against the photon sphere.
        float r = sqrt(r2);
        float edge = max(uPixel * 1.5, uLenses[i].w * 0.04);
        dark = max(dark, 1.0 - smoothstep(uLenses[i].w - edge, uLenses[i].w + edge, r));
      }

      vec2 uv = q / vec2(uAspect, 1.0) * 0.5 + 0.5;
      // Strong deflection can source from outside the frame. Mirror rather
      // than clamp: a reflected starfield is indistinguishable, while clamping
      // smears the border row into streaks.
      uv = clamp(1.0 - abs(1.0 - abs(uv)), 0.0, 1.0);

      vec4 texel = texture2D(tDiffuse, uv);
      gl_FragColor = vec4(texel.rgb * (1.0 - dark), texel.a);
    }
  `,
};

const view = new THREE.Vector3();
const ndc = new THREE.Vector3();

export class LensingPass extends ShaderPass {
  /**
   * Ids of the holes warped this frame. The caller hides these holes' horizon
   * meshes: the warp would re-image the black disc as a dark band on the
   * Einstein ring, and the 2.6 r_s shadow already covers what the 1 r_s mesh
   * occluded. Holes not in this set (sub-pixel, off-frame, past MAX_LENSES)
   * keep their mesh as the silhouette.
   */
  readonly activeIds = new Set<string>();

  constructor() {
    super(LensingShader);
    this.enabled = false;
  }

  /**
   * Switch the pass off for this frame. Clearing `activeIds` matters as much
   * as `enabled`: the caller restores horizon meshes from that set, so a stale
   * set leaves every lensed hole with nothing drawing its silhouette.
   */
  deactivate(): false {
    this.activeIds.clear();
    this.enabled = false;
    return false;
  }

  /**
   * Point the pass at this frame's holes: project each into screen space,
   * convert θ_E and the shadow to NDC-height units, drop lenses behind the
   * camera or too weak to move a pixel. Returns whether any survived — whether
   * this frame needs the post chain — and sets `enabled` to match.
   */
  refresh(
    holes: readonly LensSource[],
    camera: THREE.PerspectiveCamera,
    viewportHeight: number
  ): boolean {
    const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = camera.aspect;
    let count = 0;

    this.activeIds.clear();
    camera.updateMatrixWorld();
    for (const hole of holes) {
      if (count >= MAX_LENSES) break;

      // View-space z decides "behind the camera": projecting such a point
      // flips it through the origin and would lens around a mirage.
      view.copy(hole.position).applyMatrix4(camera.matrixWorldInverse);
      if (view.z >= 0) continue;

      const distance = view.length();
      const thetaE = einsteinAngle(hole.rs, distance);
      if (thetaE === 0) continue;

      ndc.copy(hole.position).project(camera);
      const cx = ndc.x * aspect;
      const cy = ndc.y;
      const ring = Math.tan(thetaE) / tanHalfFov;
      const shadow = Math.tan(shadowAngle(hole.rs, distance)) / tanHalfFov;

      // Deflection at screen distance r is ring²/r, so an off-frame hole still
      // reaches in. Skip once the warp at the nearest on-screen point falls
      // below a pixel-ish threshold.
      const overhang = Math.max(Math.abs(cx) - aspect, Math.abs(cy) - 1, 0);
      const strength = ring * ring;
      if (overhang > 0 ? strength / overhang < MIN_RING_NDC : ring < MIN_RING_NDC) continue;

      (this.uniforms.uLenses.value[count] as THREE.Vector4).set(cx, cy, strength, shadow);
      this.activeIds.add(hole.id);
      count++;
    }

    this.uniforms.uCount.value = count;
    this.uniforms.uAspect.value = aspect;
    this.uniforms.uPixel.value = 2 / Math.max(1, viewportHeight);
    this.enabled = count > 0;
    return this.enabled;
  }
}

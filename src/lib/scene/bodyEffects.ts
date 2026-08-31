// Per-body visual add-ons hanging off a body's group: atmosphere glow, rings,
// comet tails. Kept out of `sceneManager.ts` because each owns GPU resources
// with its own build/update/dispose lifecycle.
//
// All render-only: nothing feeds back into physics, and everything derives from
// the body's current state rather than accumulating, so scrubbing stays exact.

import * as THREE from 'three';
import type { Body } from '../types';
import { applyHueRotation, createSolarPanelTexture } from './textures';

// --- atmosphere -----------------------------------------------------------

/** Density above which the cloud deck starts veiling the surface. */
const DECK_START = 0.35;
/** Density at which the deck is fully opaque — a Venus-style closed deck. */
const DECK_FULL = 0.85;
/** Just above the surface; the rim shell always sits outside it. */
const DECK_SCALE = 1.015;

/**
 * Two nested shells over the body:
 *
 * - A Fresnel-style rim glow: a slightly larger sphere rendered back-side with
 *   additive blending, brightest where the surface turns away from the viewer.
 *   Additive blending keeps it visible against both space and the lit planet,
 *   and a back-side sphere never z-fights with the surface it wraps. The
 *   falloff is an `onBeforeCompile` on MeshBasicMaterial rather than a raw
 *   ShaderMaterial, which keeps three.js's tone-mapping and color-space wiring
 *   intact (same approach as `trails.ts`).
 * - A lit, front-side cloud deck carrying a seeded swirl texture, present only
 *   above `DECK_START`. This is what makes a thick atmosphere read as *thick*:
 *   opacity ramps until the deck closes over the surface entirely, the way
 *   Venus hides its ground.
 *
 * Density is an opacity axis, not a height axis — the shells' radii barely
 * move with it. An earlier version grew the rim shell 1.05–1.35× with density,
 * which read as "taller atmosphere" rather than "denser air".
 */
export class Atmosphere {
  /** both shells; the caller scales this to the body's visual radius */
  readonly object = new THREE.Group();

  private rim: THREE.Mesh;
  private rimMaterial: THREE.MeshBasicMaterial;
  private uniforms = {
    uPower: { value: 3.0 },
    uIntensity: { value: 1.0 },
  };

  /** built lazily on first crossing DECK_START, then hidden rather than torn down */
  private deck: THREE.Mesh | null = null;
  private deckMaterial: THREE.MeshStandardMaterial | null = null;
  private deckTexture: THREE.Texture | null = null;

  private geometry: THREE.SphereGeometry;
  private seed: string;

  /** density this was last built/updated for, to skip redundant writes */
  private density = -1;

  constructor(geometry: THREE.SphereGeometry, color: string, density: number, seed: string) {
    this.geometry = geometry;
    this.seed = seed;

    this.rimMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    // Rim term: 1 − |dot(normal, viewDir)|, raised to a power that sharpens the
    // limb as density falls — thin reads as a tight line, thick as broad haze.
    this.rimMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uPower = this.uniforms.uPower;
      shader.uniforms.uIntensity = this.uniforms.uIntensity;

      shader.vertexShader =
        'varying vec3 vNormalView;\nvarying vec3 vPositionView;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vNormalView = normalize( normalMatrix * normal );
           vPositionView = ( modelViewMatrix * vec4( transformed, 1.0 ) ).xyz;`
        );

      shader.fragmentShader =
        'uniform float uPower;\nuniform float uIntensity;\n' +
        'varying vec3 vNormalView;\nvarying vec3 vPositionView;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `float rim = 1.0 - abs( dot( normalize( vNormalView ), normalize( -vPositionView ) ) );
           rim = pow( clamp( rim, 0.0, 1.0 ), uPower ) * uIntensity;
           gl_FragColor = vec4( outgoingLight * rim, diffuseColor.a * rim );`
        );
    };

    this.rim = new THREE.Mesh(geometry, this.rimMaterial);
    // Draw after the body (and the deck) so the additive pass lands on top.
    this.rim.renderOrder = 2;
    this.object.add(this.rim);
    this.update(color, density);
  }

  update(color: string, density: number): void {
    this.rimMaterial.color.set(color);
    this.deckMaterial?.color.set(color);
    if (density === this.density) return;
    this.density = density;

    const d = clamp01(density);
    // Thin: sharper and dimmer; thick: softer and brighter. Intensity stays
    // under 1 so the additive pass doesn't blow out to white before bloom.
    this.uniforms.uPower.value = 3.8 - d * 1.6;
    this.uniforms.uIntensity.value = 0.22 + d * 0.78;
    // Nearly flat: a whisper of extra depth at the top of the range, kept well
    // under the point where the glow stops reading as part of the planet.
    this.rim.scale.setScalar(1.04 + d * 0.06);

    const cover = smoothstep(DECK_START, DECK_FULL, d);
    if (cover > 0) {
      if (!this.deck) this.buildDeck(color);
      this.deckMaterial!.opacity = cover;
      this.deck!.visible = true;
    } else if (this.deck) {
      this.deck.visible = false;
    }
  }

  /**
   * Cloud drift, derived from the surface spin angle so scrubbing stays exact.
   * The deck runs slightly slower than the ground: the differential is what
   * makes it read as a separate layer of weather rather than painted-on cloud.
   */
  setSpin(spin: number): void {
    if (this.deck) this.deck.rotation.y = spin * 0.8;
  }

  private buildDeck(color: string): void {
    this.deckTexture = createCloudTexture(this.seed);
    this.deckMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      map: this.deckTexture,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
    });
    this.deck = new THREE.Mesh(this.geometry, this.deckMaterial);
    this.deck.scale.setScalar(DECK_SCALE);
    this.deck.renderOrder = 1;
    this.object.add(this.deck);
  }

  dispose(): void {
    // Geometry is shared and owned by the caller.
    this.rimMaterial.dispose();
    this.deckMaterial?.dispose();
    this.deckTexture?.dispose();
  }
}

/**
 * Equirectangular swirl map for the cloud deck: zonally stretched value noise
 * sheared by a lower-frequency warp field, which turns flat latitude bands
 * into the streaks-and-eddies look of a real cloud deck. Grayscale on purpose
 * — the material's color supplies the hue, so one map serves any atmosphere.
 *
 * Seeded per body like `textures.ts` — a deck that reshuffles its swirls on
 * reload looks like a bug. Periodic in longitude so the seam never shows.
 */
function createCloudTexture(seed: string): THREE.Texture {
  const width = 512;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  const rand = mulberry32(hashSeed(seed) ^ 0xa7c5);

  // The warp field is isotropic and broad; the streak field is far finer in
  // latitude than longitude, which is what elongates features into bands.
  const warpOctaves = [makeValueNoise(rand, 6, 3), makeValueNoise(rand, 12, 6), makeValueNoise(rand, 24, 12)];
  const streakOctaves = [
    makeValueNoise(rand, 4, 12),
    makeValueNoise(rand, 8, 24),
    makeValueNoise(rand, 16, 48),
    makeValueNoise(rand, 32, 96),
  ];

  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const v = y / height;
    // Contrast fades toward the poles, where equirectangular pinching would
    // otherwise wind the streaks into a pinwheel artifact.
    const polar = smoothstep(0, 0.12, Math.min(v, 1 - v));
    for (let x = 0; x < width; x++) {
      const u = x / width;

      let warp = 0;
      let amp = 1;
      let total = 0;
      for (const n of warpOctaves) {
        warp += n(u, v) * amp;
        total += amp;
        amp *= 0.5;
      }
      const sheared = u + (warp / total - 0.5) * 0.5;

      let s = 0;
      amp = 1;
      total = 0;
      for (const n of streakOctaves) {
        s += n(sheared, v) * amp;
        total += amp;
        amp *= 0.55;
      }
      s = 0.5 + (s / total - 0.5) * 2.2;
      s = 0.75 + (clamp01(s) - 0.75) * polar;

      // Bright overall: the deck's darkest lanes still read as cloud, and the
      // material color does the tinting.
      const value = Math.round(255 * (0.55 + 0.45 * clamp01(s)));
      const i = (y * width + x) * 4;
      img.data[i] = value;
      img.data[i + 1] = value;
      img.data[i + 2] = value;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Smoothed bilinear value noise on a (cu × cv) grid, wrapping in u so the
 * texture tiles across the longitude seam.
 */
function makeValueNoise(rand: () => number, cu: number, cv: number): (u: number, v: number) => number {
  const grid = new Float32Array(cu * (cv + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return (u, v) => {
    const x = (((u % 1) + 1) % 1) * cu;
    const y = Math.min(cv, Math.max(0, v * cv));
    const x0 = Math.floor(x) % cu;
    const x1 = (x0 + 1) % cu;
    const y0 = Math.min(cv - 1, Math.floor(y));
    const y1 = y0 + 1;
    const fx = x - Math.floor(x);
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = grid[y0 * cu + x0] * (1 - sx) + grid[y0 * cu + x1] * sx;
    const b = grid[y1 * cu + x0] * (1 - sx) + grid[y1 * cu + x1] * sx;
    return a * (1 - sy) + b * sy;
  };
}

// --- rings ----------------------------------------------------------------

/**
 * A flat, double-sided, semi-transparent ring from RingGeometry, with a radial
 * density profile mapped into concentric bands so it doesn't read as a disc.
 *
 * Geometry is unit-scaled (inner/outer as multiples of the body's radius) and
 * the mesh scaled per frame, so a radius-exaggeration change costs a scale
 * write rather than a geometry rebuild.
 */
export class Rings {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.RingGeometry;
  private material: THREE.MeshBasicMaterial;
  private texture: THREE.Texture;

  /** the inner/outer ratio the geometry was built for */
  private innerRatio: number;
  private outerRatio: number;

  constructor(rings: NonNullable<Body['rings']>, bodyRadius: number, seed: string) {
    this.innerRatio = rings.innerRadius / bodyRadius;
    this.outerRatio = rings.outerRadius / bodyRadius;

    this.geometry = makeRingGeometry(this.innerRatio, this.outerRatio);
    this.texture = createRingTexture(seed);
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(rings.color),
      map: this.texture,
      alphaMap: this.texture,
      transparent: true,
      opacity: rings.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // RingGeometry is built in the xy-plane; −90° about x lays it flat in the
    // body's xz-plane, the equatorial plane its group already tilts.
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 1;
  }

  /** Rebuilds geometry only when the radius *ratios* actually changed. */
  update(rings: NonNullable<Body['rings']>, bodyRadius: number): void {
    this.material.color.set(rings.color);
    this.material.opacity = rings.opacity;

    const inner = rings.innerRadius / bodyRadius;
    const outer = rings.outerRadius / bodyRadius;
    if (nearlyEqual(inner, this.innerRatio) && nearlyEqual(outer, this.outerRatio)) return;

    this.innerRatio = inner;
    this.outerRatio = outer;
    this.geometry.dispose();
    this.geometry = makeRingGeometry(inner, outer);
    this.mesh.geometry = this.geometry;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/**
 * Ring geometry in units of body radii, guarded against the degenerate cases a
 * user can type: a non-positive inner radius, or an outer radius at or below
 * the inner one (which would produce an inside-out annulus).
 */
function makeRingGeometry(innerRatio: number, outerRatio: number): THREE.RingGeometry {
  const inner = Math.max(1.01, Number.isFinite(innerRatio) ? innerRatio : 1.3);
  const outer = Math.max(inner * 1.02, Number.isFinite(outerRatio) ? outerRatio : inner * 1.8);
  const geometry = new THREE.RingGeometry(inner, outer, 128, 1);

  // RingGeometry's stock UVs are planar (position / outerRadius), which smears
  // the texture in straight lines across the annulus. Rewrite u as the radial
  // fraction inner → outer so the 1-D profile wraps into concentric bands.
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - inner) / (outer - inner), 0.5);
  }
  return geometry;
}

/**
 * A 1-D radial optical-depth profile (width × 1) used as both map and alphaMap;
 * the geometry's rewritten UVs wrap it into concentric bands.
 *
 * Shaped after Saturn rather than uniform noise: translucent inner region
 * ramping to a bright mid-ring, easing off outward, one Cassini-style division,
 * a few narrow gaps, irregular banding at several scales. Seeded per body like
 * `textures.ts` — a ring that reshuffles its gaps on reload looks like a bug.
 */
function createRingTexture(seed: string): THREE.Texture {
  const width = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  const rand = mulberry32(hashSeed(seed) ^ 0x51e5);

  // Broad envelope over t ∈ [0, 1], inner edge → outer edge.
  const rampEnd = 0.2 + rand() * 0.15;
  const brightEnd = 0.45 + rand() * 0.15;
  const outerLevel = 0.45 + rand() * 0.25;
  const density = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    const rise = 0.25 + 0.75 * smoothstep(0, rampEnd, t);
    const fall = 1 - (1 - outerLevel) * smoothstep(brightEnd, 1, t);
    density[i] = rise * fall;
  }

  // Value noise rather than uniform stripes, so ringlets are irregular.
  for (const [cells, amp] of [
    [6, 0.2],
    [24, 0.25],
    [90, 0.3],
    [300, 0.25],
  ] as const) {
    const grid = Array.from({ length: cells + 1 }, () => rand());
    for (let i = 0; i < width; i++) {
      const x = (i / (width - 1)) * cells;
      const i0 = Math.min(cells - 1, Math.floor(x));
      const f = x - i0;
      const s = f * f * (3 - 2 * f);
      const n = grid[i0] * (1 - s) + grid[i0 + 1] * s;
      density[i] *= 1 - amp + 2 * amp * n;
    }
  }

  // One broad division plus a few narrow gaps, each with feathered shoulders.
  const gaps: Array<[center: number, halfWidth: number, depth: number]> = [
    [0.55 + rand() * 0.2, 0.025 + rand() * 0.02, 0.95],
  ];
  const minorGaps = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < minorGaps; i++) {
    gaps.push([0.15 + rand() * 0.8, 0.002 + rand() * 0.006, 0.75 + rand() * 0.2]);
  }
  for (const [center, halfWidth, depth] of gaps) {
    for (let i = 0; i < width; i++) {
      const d = Math.abs(i / (width - 1) - center) / halfWidth;
      if (d < 1) density[i] *= 1 - depth * smoothstep(1, 0.65, d);
    }
  }

  // Fade the edges; the inner more gradually than the outer, which is
  // genuinely sharp on Saturn.
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    density[i] *= smoothstep(0, 0.05, t) * smoothstep(1, 0.99, t);
  }

  // One grayscale value is both color and alpha: the material supplies the
  // tint, and alpha following brightness keeps sparse regions translucent.
  const img = ctx.createImageData(width, 1);
  for (let i = 0; i < width; i++) {
    const v = Math.round(255 * Math.pow(clamp01(density[i]), 0.7));
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // Radial bands alias badly at the glancing angles rings are usually seen
  // from; anisotropic sampling keeps the fine ringlets from shimmering away.
  texture.anisotropy = 8;
  return texture;
}

// --- comet tail -----------------------------------------------------------

/** Enough to look continuous, few enough to be cheap. */
const TAIL_POINTS = 48;

/**
 * Projected tail lengths (CSS px) between which a tail fades in. From a
 * system-wide view a tail spans a couple of pixels, and all of its additive
 * points pile onto them — the stack clips to white and flashes like an
 * explosion as rasterization shifts frame to frame. Below legibility the tail
 * carries no information anyway; the body's fallback dot takes over. The
 * window is deliberately narrow: a tail with any visible streak still reads
 * as a comet (the swarm preset's framing sits near 6 px), so only the
 * collapsed-to-a-blob case fades.
 */
const TAIL_GONE_BELOW_PX = 3;
const TAIL_FULL_ABOVE_PX = 7;

/**
 * A comet tail: a tapering line of points streaming away from the nearest star,
 * brightest at the head. Only `ice` and `asteroid` bodies get one, and only
 * near a star — outgassing is a proximity effect, so the tail grows toward
 * periapsis and vanishes far out.
 *
 * Rebuilt each frame from the body's and star's current positions, never
 * accumulated, so scrubbing shows the right tail for the time being viewed.
 */
export class CometTail {
  readonly points: THREE.Points;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.PointsMaterial;
  private positions = new Float32Array(TAIL_POINTS * 3);
  private alphas = new Float32Array(TAIL_POINTS);

  constructor(color: string) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));

    this.material = new THREE.PointsMaterial({
      color: new THREE.Color(color),
      size: 2.5,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // Per-point alpha so the tail dissolves toward its end.
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float alpha;\nvarying float vAlpha;\n' +
        shader.vertexShader.replace('void main() {', 'void main() {\n  vAlpha = alpha;');
      shader.fragmentShader =
        'varying float vAlpha;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a * vAlpha );'
        );
    };

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
  }

  setColor(color: string): void {
    this.material.color.set(color);
  }

  /**
   * Rebuild the tail for this frame.
   *
   * `bodyPos`/`starPos` are scene units in the *rendered* frame, so the tail
   * follows the reference-frame subtraction. `distance` is the true separation
   * in meters and sets the activity level; `scale` is the full-activity length
   * in scene units; `pixelsPerUnit` is the screen size of a scene unit at the
   * body, for the collapsed-tail fade.
   */
  update(
    bodyPos: THREE.Vector3,
    starPos: THREE.Vector3,
    distance: number,
    activityRadius: number,
    scale: number,
    pixelsPerUnit: number
  ): void {
    // Nothing at the activity radius to full at a fifth of it, roughly how
    // comets brighten near periapsis.
    const activity = clamp01((activityRadius - distance) / (activityRadius * 0.8));
    if (activity <= 0.01) {
      this.points.visible = false;
      return;
    }

    const direction = bodyPos.clone().sub(starPos);
    const length = direction.length();
    if (length === 0) {
      this.points.visible = false;
      return;
    }
    direction.divideScalar(length);

    const tailLength = scale * activity;
    const legibility = clamp01(
      (tailLength * pixelsPerUnit - TAIL_GONE_BELOW_PX) / (TAIL_FULL_ABOVE_PX - TAIL_GONE_BELOW_PX)
    );
    if (legibility <= 0.01) {
      this.points.visible = false;
      return;
    }

    for (let i = 0; i < TAIL_POINTS; i++) {
      const t = i / (TAIL_POINTS - 1);
      const i3 = i * 3;
      // t² bunches points toward the head: dense at the body, sparse at the end.
      const d = t * t * tailLength;
      this.positions[i3] = bodyPos.x + direction.x * d;
      this.positions[i3 + 1] = bodyPos.y + direction.y * d;
      this.positions[i3 + 2] = bodyPos.z + direction.z * d;
      // The 0.7 keeps the additive head from reading as a second glow source
      // next to the body.
      this.alphas[i] = (1 - t) * activity * legibility * 0.7;
    }

    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('alpha').needsUpdate = true;
    this.points.visible = true;
  }

  hide(): void {
    this.points.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --- spacecraft -----------------------------------------------------------

/**
 * Bus dimensions in units of the body's visual radius. The footprint stays
 * comparable to the unit sphere a satellite would otherwise be, so camera
 * framing and the selection marker need no special case.
 */
const BUS_RADIUS = 0.62;
const BUS_LENGTH = 1.9;
const WING_LENGTH = 3.6;
const WING_WIDTH = 1.5;

/**
 * Geometry shared by every spacecraft: the shape is identical, so per-body
 * allocation meant one pointless GPU upload per satellite (the Satellite Swarm
 * preset builds 80). Created on first use and never disposed.
 */
let sharedBusGeometry: THREE.CylinderGeometry | null = null;
let sharedWingGeometry: THREE.PlaneGeometry | null = null;

function busGeometry(): THREE.CylinderGeometry {
  sharedBusGeometry ??= new THREE.CylinderGeometry(BUS_RADIUS, BUS_RADIUS, BUS_LENGTH, 16, 1);
  return sharedBusGeometry;
}

function wingGeometry(): THREE.PlaneGeometry {
  sharedWingGeometry ??= new THREE.PlaneGeometry(WING_LENGTH, WING_WIDTH, 1, 1);
  return sharedWingGeometry;
}

/**
 * A modeled spacecraft: a cylindrical bus with a solar array on each side.
 *
 * Geometry rather than a textured sphere because at the exaggeration a
 * satellite needs to be visible (×400, see `exaggerationFor`) it is clearly
 * resolved, and the silhouette is what makes it read as a machine. Dishes,
 * booms and antennae were tried and dropped: illegible at screen size, and
 * triple the mesh count for a preset that builds 80 craft.
 *
 * Built in units of the body's visual radius and scaled by the caller each
 * frame, so it tracks the exaggeration slider like the sphere it replaces. The
 * bus runs along +Y — the axis the sphere spins about in `applyOrientation` —
 * so rotation and axial tilt apply unchanged.
 */
export class Spacecraft {
  readonly object = new THREE.Group();

  private materials: THREE.Material[] = [];
  private hullMaterial: THREE.MeshStandardMaterial;

  constructor(hullTexture: THREE.Texture, color: string, seed: string) {
    // The hull map is hue-rotated to the body's color like every sphere
    // surface. No `material.color` multiply: multiplying a reference-colored
    // map by an arbitrary body color crosses two hues and darkens toward mud.
    this.hullMaterial = new THREE.MeshStandardMaterial({
      map: hullTexture,
      roughness: 0.52,
      metalness: 0.72,
    });
    applyHueRotation(this.hullMaterial, 'satellite', color);
    this.materials.push(this.hullMaterial);

    this.object.add(new THREE.Mesh(busGeometry(), this.hullMaterial));

    // --- solar arrays ---
    //
    // Two wings on the ±X axis, double-sided: a single-sided plane is invisible
    // from the back, so a tumbling craft would flicker as each wing turned.
    const panelMaterial = new THREE.MeshStandardMaterial({
      map: createSolarPanelTexture(seed),
      side: THREE.DoubleSide,
      roughness: 0.34,
      metalness: 0.45,
      // Faint blue self-illumination so a wing facing away from the star still
      // reads as a solar panel.
      emissive: new THREE.Color(0x0a1330),
      emissiveIntensity: 1,
    });
    this.materials.push(panelMaterial);

    for (const sign of [1, -1]) {
      const wing = new THREE.Mesh(wingGeometry(), panelMaterial);
      // PlaneGeometry is built in the xy-plane; +90° about x lays it into the
      // xz-plane so the wings spread flat either side of the bus.
      wing.rotation.x = Math.PI / 2;
      wing.position.x = sign * (BUS_RADIUS + 0.4 + WING_LENGTH / 2);
      this.object.add(wing);
    }
  }

  setColor(color: string): void {
    applyHueRotation(this.hullMaterial, 'satellite', color);
  }

  /** The caller owns the texture's lifetime, so this only re-points the material. */
  setHullTexture(texture: THREE.Texture): void {
    this.hullMaterial.map = texture;
    this.hullMaterial.needsUpdate = true;
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
    // Geometry is shared across craft and the panel texture is owned by
    // `textures.ts`; neither is disposed here.
  }
}

// --- shared helpers -------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Edges may be reversed for a falling step. */
function smoothstep(e0: number, e1: number, t: number): number {
  const x = clamp01((t - e0) / (e1 - e0));
  return x * x * (3 - 2 * x);
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** mulberry32, matching `textures.ts` — deterministic per-body variation. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, matching `textures.ts`. */
function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

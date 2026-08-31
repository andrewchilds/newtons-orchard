// Scene-wide overlays: vector arrows, merge bursts, accretion flares, and the
// predicted-orbit path.
//
// Render-only, derived from sim state. The time-dependent effects are driven by
// *sim* time, never wall time, so scrubbing back across a merge replays them.

import * as THREE from 'three';
import { DAY } from '../physics/constants';
import { habitableZone, HZ_INNER_AU, HZ_OUTER_AU } from '../physics/habitableZone';

/** Reused mix target for brightening body colors. */
const WHITE = new THREE.Color(0xffffff);

// --- vector arrows --------------------------------------------------------

const VELOCITY_COLOR = 0x63e6ff;
const ACCELERATION_COLOR = 0xff8b5e;

/**
 * Velocity and net-acceleration arrows, one pair per body.
 *
 * Both quantities span orders of magnitude across a system, so lengths are
 * normalized against this frame's largest magnitude and then square-rooted. A
 * linear scale would leave every arrow but the biggest invisible.
 */
export class VectorArrows {
  readonly object = new THREE.Group();
  private arrows = new Map<string, { velocity: THREE.ArrowHelper; acceleration: THREE.ArrowHelper }>();

  constructor() {
    this.object.name = 'vector-arrows';
    this.object.renderOrder = 2;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  /** Hide every arrow; `show` re-enables the ones still present this frame. */
  hideAll(): void {
    for (const pair of this.arrows.values()) {
      pair.velocity.visible = false;
      pair.acceleration.visible = false;
    }
  }

  /**
   * Point body `id`'s arrows. Raw SI vectors, this frame's maxima to normalize
   * against, and `size` = scene-unit length of a full-magnitude arrow.
   */
  show(
    id: string,
    origin: THREE.Vector3,
    velocity: THREE.Vector3,
    acceleration: THREE.Vector3,
    maxVelocity: number,
    maxAcceleration: number,
    size: number
  ): void {
    const pair = this.pairFor(id);

    orient(pair.velocity, origin, velocity, maxVelocity, size);
    orient(pair.acceleration, origin, acceleration, maxAcceleration, size * 0.75);
  }

  remove(id: string): void {
    const pair = this.arrows.get(id);
    if (!pair) return;
    this.object.remove(pair.velocity);
    this.object.remove(pair.acceleration);
    disposeArrow(pair.velocity);
    disposeArrow(pair.acceleration);
    this.arrows.delete(id);
  }

  dispose(): void {
    for (const id of [...this.arrows.keys()]) this.remove(id);
  }

  private pairFor(id: string) {
    let pair = this.arrows.get(id);
    if (pair) return pair;

    const up = new THREE.Vector3(0, 1, 0);
    const zero = new THREE.Vector3();
    pair = {
      velocity: new THREE.ArrowHelper(up, zero, 1, VELOCITY_COLOR, 0.3, 0.18),
      acceleration: new THREE.ArrowHelper(up, zero, 1, ACCELERATION_COLOR, 0.3, 0.18),
    };
    pair.velocity.visible = false;
    pair.acceleration.visible = false;
    this.object.add(pair.velocity);
    this.object.add(pair.acceleration);
    this.arrows.set(id, pair);
    return pair;
  }
}

function orient(
  arrow: THREE.ArrowHelper,
  origin: THREE.Vector3,
  vector: THREE.Vector3,
  max: number,
  size: number
): void {
  const magnitude = vector.length();
  if (magnitude === 0 || max <= 0) {
    arrow.visible = false;
    return;
  }

  // sqrt compresses the dynamic range so small arrows stay visible.
  const length = size * Math.sqrt(magnitude / max);
  arrow.position.copy(origin);
  arrow.setDirection(vector.clone().divideScalar(magnitude));
  arrow.setLength(length, length * 0.28, length * 0.16);
  arrow.visible = true;
}

function disposeArrow(arrow: THREE.ArrowHelper): void {
  arrow.line.geometry.dispose();
  (arrow.line.material as THREE.Material).dispose();
  arrow.cone.geometry.dispose();
  (arrow.cone.material as THREE.Material).dispose();
}

// --- merge burst ----------------------------------------------------------

/** How long a burst lasts, in sim seconds — see the note in `MergeBursts`. */
const BURST_DURATION = 3 * 86400;
const BURST_PARTICLES = 90;

interface Burst {
  /** sim time the merge happened */
  t: number;
  /** world position in the inertial frame, scene units */
  position: THREE.Vector3;
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  directions: Float32Array;
}

/**
 * Brief particle bursts at collision sites.
 *
 * A burst is a pure function of `simTime − mergeTime`, never wall time and
 * never per-frame accumulation: scrubbing back replays it, pausing freezes it.
 */
export class MergeBursts {
  readonly object = new THREE.Group();
  private bursts: Burst[] = [];
  private geometrySeed = 0;

  constructor() {
    this.object.name = 'merge-bursts';
    this.object.renderOrder = 3;
  }

  /** Record a burst at a merge site (inertial-frame scene units). */
  add(t: number, position: THREE.Vector3, color: string): void {
    const positions = new Float32Array(BURST_PARTICLES * 3);
    const directions = new Float32Array(BURST_PARTICLES * 3);

    // Seeded so a burst doesn't reshuffle when you scrub back to it.
    this.geometrySeed += 1;
    const rand = mulberry32(this.geometrySeed * 0x9e3779b1);
    for (let i = 0; i < BURST_PARTICLES; i++) {
      const z = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const speed = 0.35 + rand() * 0.65;
      const i3 = i * 3;
      directions[i3] = Math.cos(theta) * r * speed;
      directions[i3 + 1] = z * speed;
      directions[i3 + 2] = Math.sin(theta) * r * speed;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: new THREE.Color(color),
      size: 4,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.object.add(points);

    this.bursts.push({ t, position: position.clone(), points, geometry, material, directions });
  }

  /**
   * Advance every burst to `simTime`, expiring the finished ones. `refPosition`
   * is the reference-frame origin, subtracted so bursts sit correctly in a
   * body-relative view; `radius` is the spray extent in scene units.
   */
  update(simTime: number, refPosition: THREE.Vector3, radius: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      const age = (simTime - burst.t) / BURST_DURATION;

      // Hidden, not destroyed — scrubbing back and forward must replay them.
      if (age < 0 || age > 1) {
        burst.points.visible = false;
        continue;
      }

      const attr = burst.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = attr.array as Float32Array;
      // Ease out — a decelerating expansion reads as an impact.
      const spread = radius * (1 - (1 - age) ** 2) * 6;

      for (let p = 0; p < BURST_PARTICLES; p++) {
        const p3 = p * 3;
        array[p3] = burst.position.x - refPosition.x + burst.directions[p3] * spread;
        array[p3 + 1] = burst.position.y - refPosition.y + burst.directions[p3 + 1] * spread;
        array[p3 + 2] = burst.position.z - refPosition.z + burst.directions[p3 + 2] * spread;
      }
      attr.needsUpdate = true;

      burst.material.opacity = 1 - age;
      burst.points.visible = true;
    }

    // Bound the list on a long collision-heavy run; the dropped bursts are far
    // enough back that scrubbing to them is unlikely.
    if (this.bursts.length > 24) {
      const stale = this.bursts.splice(0, this.bursts.length - 24);
      for (const burst of stale) this.disposeBurst(burst);
    }
  }

  /** Forget every burst — a system load or a full reset. */
  clear(): void {
    for (const burst of this.bursts) this.disposeBurst(burst);
    this.bursts.length = 0;
  }

  dispose(): void {
    this.clear();
  }

  private disposeBurst(burst: Burst): void {
    this.object.remove(burst.points);
    burst.geometry.dispose();
    burst.material.dispose();
  }
}

// --- accretion flare ------------------------------------------------------

/**
 * Flare light curve, in sim time: fast rise, then the t^(−5/3) tidal-disruption
 * decay. The tail is below 1% of peak by the time the window closes.
 */
const FLARE_RISE = 0.5 * DAY;
const FLARE_DURATION = 10 * DAY;

/** Bound on retained flares, matching MergeBursts' reasoning. */
const MAX_FLARES = 24;

interface Flare {
  /** sim time of the merge */
  t: number;
  /** body id of the black hole the flare sits on */
  anchorId: string;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
}

/** What a flare needs from the scene each frame to sit on its black hole. */
export interface FlareAnchor {
  /** the hole's rendered position, reference-frame adjusted, scene units */
  position: THREE.Vector3;
  /** the hole's rendered radius, scene units */
  radius: number;
}

/**
 * The glow of a black hole eating something, in the absorbed body's color.
 * Replaces the merge burst for black-hole captures: a horizon forbids debris
 * flying back out, but the accretion flare is how these are really observed.
 *
 * Ages like a burst — a pure function of `simTime − mergeTime`. Unlike a burst
 * it anchors to a *body*, not the collision site, so the sprite rides the hole
 * through any reference frame; `update` re-resolves the anchor each frame.
 */
export class AccretionFlares {
  readonly object = new THREE.Group();
  private flares: Flare[] = [];

  /**
   * Soft radial falloff, shared by every flare. A plain filled sprite reads as
   * a disc sticker; the falloff reads as light. 64px is plenty this soft.
   */
  private readonly glowMap: THREE.Texture;

  constructor() {
    this.object.name = 'accretion-flares';
    this.object.renderOrder = 3;

    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    this.glowMap = new THREE.CanvasTexture(canvas);
  }

  /**
   * Record a flare on black hole `anchorId` for a merge at sim time `t`.
   *
   * A seek re-emits the same merge event, so an identical (t, anchor) flare is
   * skipped — stacked additive glow would read as the flare heating up.
   */
  add(t: number, anchorId: string, color: string): void {
    if (this.flares.some((f) => f.t === t && f.anchorId === anchorId)) return;

    const material = new THREE.SpriteMaterial({
      map: this.glowMap,
      color: new THREE.Color(color).lerp(WHITE, 0.35),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    this.object.add(sprite);

    this.flares.push({ t, anchorId, sprite, material });

    if (this.flares.length > MAX_FLARES) {
      const stale = this.flares.splice(0, this.flares.length - MAX_FLARES);
      for (const flare of stale) this.disposeFlare(flare);
    }
  }

  /**
   * Advance every flare to `simTime`. `anchorFor` resolves a body id to its
   * rendered position and radius, or null while the body isn't in the scene —
   * which hides the flare for the frame rather than orphaning it.
   */
  update(simTime: number, anchorFor: (id: string) => FlareAnchor | null): void {
    for (const flare of this.flares) {
      const age = simTime - flare.t;
      if (age < 0 || age > FLARE_DURATION) {
        flare.sprite.visible = false;
        continue;
      }

      const anchor = anchorFor(flare.anchorId);
      if (anchor === null) {
        flare.sprite.visible = false;
        continue;
      }

      const envelope = age < FLARE_RISE ? age / FLARE_RISE : (age / FLARE_RISE) ** (-5 / 3);

      // The glow spreads as it decays, while the falloff texture keeps the
      // bright core on the hole.
      const spread = 2.2 + 2.3 * (age / FLARE_DURATION);
      flare.sprite.position.copy(anchor.position);
      flare.sprite.scale.setScalar(Math.max(anchor.radius, 1e-4) * 2 * spread);
      flare.material.opacity = envelope;
      flare.sprite.visible = true;
    }
  }

  /** Forget every flare — a system load or a full reset. */
  clear(): void {
    for (const flare of this.flares) this.disposeFlare(flare);
    this.flares.length = 0;
  }

  dispose(): void {
    this.clear();
    this.glowMap.dispose();
  }

  private disposeFlare(flare: Flare): void {
    this.object.remove(flare.sprite);
    flare.material.dispose();
  }
}

// --- predicted orbit path -------------------------------------------------

/**
 * The dashed forward-prediction path for the selected body. The integration
 * lives in `predictPath.ts`; this class only owns the line. Dashes distinguish
 * it from history trails, which are solid.
 */
export class PredictionPath {
  readonly object: THREE.Line;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.LineDashedMaterial;
  private reserved = 0;

  constructor() {
    this.material = new THREE.LineDashedMaterial({
      color: new THREE.Color('#ffffff'),
      transparent: true,
      // Near-opaque on purpose: a 1px body-colored line at low opacity against
      // black is invisible for any dark body color.
      opacity: 0.95,
      depthWrite: false,
      dashSize: 1.5,
      gapSize: 1.5,
    });
    this.object = new THREE.Line(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 1;
    this.object.visible = false;
  }

  /**
   * Tint the path with the body's color, brightened toward white: raw body
   * colors are often dark, and a 1px dashed line in one on a black sky reads as
   * nothing.
   */
  setColor(color: string): void {
    this.material.color.set(color).lerp(WHITE, 0.45);
  }

  /** Replace the drawn path. `points` is xyz-interleaved in scene units. */
  setPoints(points: Float32Array): void {
    const count = points.length / 3;
    if (count < 2) {
      this.object.visible = false;
      return;
    }

    // Sized to exactly the point count, never over-reserved with a draw range:
    // `computeLineDistances` walks the *whole* position attribute, so trailing
    // zeros inject a huge jump and the dashes collapse into a solid line.
    if (count !== this.reserved) {
      this.geometry.dispose();
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      this.object.geometry = this.geometry;
      this.reserved = count;
    }

    const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    (attr.array as Float32Array).set(points);
    attr.needsUpdate = true;
    this.geometry.computeBoundingSphere();

    // Dashes are measured along the line: rebuild whenever vertices change.
    this.object.computeLineDistances();
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }

  /**
   * Scale dash length to the path's size, so a moon's tight orbit and a
   * planet's wide one both read as dashed.
   */
  setDashScale(scale: number): void {
    const dash = Math.max(0.05, scale * 0.02);
    if (this.material.dashSize === dash) return;
    this.material.dashSize = dash;
    this.material.gapSize = dash;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --- habitable zones --------------------------------------------------------

/**
 * Where an earthlike planet keeps liquid water, and the water-vapor/CO₂
 * feedbacks that set the classical bounds don't care what the star looks like
 * in detail — mass is the whole input. Green by long convention ("the green
 * zone"), and it's the one hue no body type's default color uses, so the band
 * never reads as a smeared trail.
 */
const ZONE_COLOR = 0x54d68c;

/**
 * A flat annulus per star spanning its habitable zone, lying in the ecliptic
 * (world xy) plane the Kepler-built orbits live in.
 *
 * The zone's inner/outer *ratio* is a constant of the model, so every star
 * shares one unit-outer-radius geometry and differs only by a scale — a
 * mass edit rescales, never rebuilds. Radii derive from the sim's current
 * masses each frame, so a star edited heavier mid-run widens its band at that
 * point on the timeline, exactly like every other visual derived from state.
 */
export class HabitableZones {
  readonly object = new THREE.Group();
  private zones = new Map<string, { mesh: THREE.Mesh; mass: number }>();
  /** star ids drawn this frame; commit() hides the rest */
  private shown = new Set<string>();
  private geometry: THREE.RingGeometry;
  private material: THREE.MeshBasicMaterial;
  private texture: THREE.Texture;

  constructor() {
    this.object.name = 'habitable-zones';

    this.geometry = new THREE.RingGeometry(HZ_INNER_AU / HZ_OUTER_AU, 1, 128, 1);
    // Stock RingGeometry UVs are planar; rewrite u as the radial fraction so
    // the 1-D falloff texture wraps into feathered concentric edges (same
    // trick as the planetary rings in bodyEffects.ts).
    const pos = this.geometry.attributes.position;
    const uv = this.geometry.attributes.uv;
    const inner = HZ_INNER_AU / HZ_OUTER_AU;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (r - inner) / (1 - inner), 0.5);
    }

    this.texture = createZoneFalloffTexture();
    this.material = new THREE.MeshBasicMaterial({
      color: ZONE_COLOR,
      alphaMap: this.texture,
      transparent: true,
      // Opacity blends in *linear* light and the output transform lifts dark
      // linear values hard (linear 0.06 displays as ~27% gray), so "faint"
      // needs to be far lower than the displayed fraction suggests — 0.07
      // still read as a solid green field.
      opacity: 0.02,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  begin(): void {
    this.shown.clear();
  }

  /** Draw star `id`'s zone at its rendered position, sized for `mass` (kg). */
  show(id: string, position: THREE.Vector3, mass: number, scale: number): void {
    let zone = this.zones.get(id);
    if (!zone) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      // Before every other transparent overlay: the band is backdrop, and a
      // trail or prediction path crossing it must stay legible on top.
      mesh.renderOrder = -1;
      this.object.add(mesh);
      zone = { mesh, mass: NaN };
      this.zones.set(id, zone);
    }
    if (zone.mass !== mass) {
      zone.mass = mass;
      zone.mesh.scale.setScalar(habitableZone(mass).outer / scale);
    }
    zone.mesh.position.copy(position);
    zone.mesh.visible = true;
    this.shown.add(id);
  }

  /** Hide zones not shown this frame — toggle off, star merged away or dead. */
  commit(): void {
    for (const [id, zone] of this.zones) {
      if (!this.shown.has(id)) zone.mesh.visible = false;
    }
  }

  /** Drop a star's zone for good (its body left the roster). */
  remove(id: string): void {
    const zone = this.zones.get(id);
    if (!zone) return;
    this.object.remove(zone.mesh);
    this.zones.delete(id);
  }

  dispose(): void {
    for (const id of [...this.zones.keys()]) this.remove(id);
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/**
 * 1-D alpha falloff across the annulus: a plateau with feathered edges. Hard
 * edges overstate the model's precision — the bounds are order-of-magnitude
 * climate estimates, and a soft band says so.
 */
function createZoneFalloffTexture(): THREE.Texture {
  const width = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  const img = ctx.createImageData(width, 1);
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    const rise = Math.min(1, t / 0.18);
    const fall = Math.min(1, (1 - t) / 0.18);
    const a = rise * rise * (3 - 2 * rise) * (fall * fall * (3 - 2 * fall));
    const v = Math.round(255 * a);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

// --- placement ghost --------------------------------------------------------

const GHOST_SEGMENTS = 128;

/**
 * Preview for click-to-place: a translucent sphere at the landing point plus a
 * circle for the orbit the drop would create. A drop is circular by
 * construction, so the circle is exact and needs no integration — just a unit
 * LineLoop scaled to the orbit radius and oriented to its normal.
 */
export class PlacementGhost {
  readonly object = new THREE.Group();
  private readonly sphere: THREE.Mesh;
  private readonly sphereGeometry = new THREE.SphereGeometry(1, 24, 16);
  private readonly sphereMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  private readonly circle: THREE.LineLoop;
  private readonly circleGeometry = new THREE.BufferGeometry();
  private readonly circleMaterial = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  private readonly zAxis = new THREE.Vector3(0, 0, 1);

  constructor() {
    this.object.name = 'placement-ghost';
    this.object.visible = false;

    this.sphere = new THREE.Mesh(this.sphereGeometry, this.sphereMaterial);
    this.sphere.frustumCulled = false;
    this.sphere.renderOrder = 4;
    this.object.add(this.sphere);

    const positions = new Float32Array(GHOST_SEGMENTS * 3);
    for (let i = 0; i < GHOST_SEGMENTS; i++) {
      const angle = (i / GHOST_SEGMENTS) * Math.PI * 2;
      positions[i * 3] = Math.cos(angle);
      positions[i * 3 + 1] = Math.sin(angle);
    }
    this.circleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.circle = new THREE.LineLoop(this.circleGeometry, this.circleMaterial);
    this.circle.frustumCulled = false;
    this.circle.renderOrder = 1;
    this.object.add(this.circle);
  }

  /**
   * Everything in scene units. `orbit` is null when the drop has no attractor
   * (empty system, or nothing out-masses the new body) — sphere only.
   */
  show(
    point: THREE.Vector3,
    radius: number,
    color: string,
    orbit: { center: THREE.Vector3; radius: number; normal: THREE.Vector3 } | null
  ): void {
    this.sphere.position.copy(point);
    this.sphere.scale.setScalar(Math.max(radius, 1e-9));
    this.sphereMaterial.color.set(color);
    this.circleMaterial.color.set(color).lerp(WHITE, 0.45);

    if (orbit && orbit.radius > 0) {
      this.circle.position.copy(orbit.center);
      this.circle.scale.setScalar(orbit.radius);
      this.circle.quaternion.setFromUnitVectors(this.zAxis, orbit.normal);
      this.circle.visible = true;
    } else {
      this.circle.visible = false;
    }

    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }

  dispose(): void {
    this.sphereGeometry.dispose();
    this.sphereMaterial.dispose();
    this.circleGeometry.dispose();
    this.circleMaterial.dispose();
  }
}

/** mulberry32, matching `textures.ts`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

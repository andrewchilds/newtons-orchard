// Orbit trails: the Three.js side of TrailBuffer.
//
// One Line per body, body-colored, faded toward the tail. Geometry is
// reallocated only when a body's point count grows past its buffer; ordinary
// frames just rewrite the existing attribute and bump the draw range, because
// reverse scrubbing rebuilds every trail *every frame* (see GUIDE.md's pitfall
// on seekGeneration) and per-frame allocation there would stutter.

import * as THREE from 'three';
import { TrailBuffer } from './trailBuffer';

/** sim-seconds between trail samples — set per-system by the caller. */
export interface TrailsOptions {
  interval: number;
  capacity: number;
}

/**
 * Draw a body's trail relative to another body's history, attached to that
 * body's *current* render-frame position (scene units). This is what turns a
 * moon's inertial helix into the ellipse it traces around its planet: the
 * shape comes from the index-aligned subtraction against the parent's track,
 * the placement from wherever the parent is right now.
 */
export interface TrailAnchor {
  id: string;
  position: { x: number; y: number; z: number };
}

interface TrailEntry {
  line: THREE.Line;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial;
  /** points the current attribute can hold */
  reserved: number;
  /**
   * The trail's newest point (reference-relative, float64), subtracted from
   * every vertex before the float32 attribute write and re-added via
   * `line.position`. Distant trails need this: at thousands of scene units a
   * float32 vertex quantizes to hundreds of km, and a far satellite's trail
   * visibly snapped between grid points when zoomed close. The line transform
   * goes through double-precision CPU matrix math, so the offset costs no
   * precision there.
   */
  origin: THREE.Vector3;
}

export class Trails {
  readonly buffer: TrailBuffer;

  private group = new THREE.Group();
  private entries = new Map<string, TrailEntry>();
  private colors = new Map<string, string>();

  // The inputs the drawn geometry is a pure function of, as of the last full
  // update() pass. Anchor *positions* are deliberately absent — they only move
  // the lines, not their shape.
  private lastVersion = -1;
  private lastReferenceId: string | null = null;
  private lastOldest = -Infinity;
  private lastSelectedId: string | null = null;
  private lastSelectedOldest = -Infinity;
  private lastAnchorIds = new Map<string, string>();

  constructor(options: TrailsOptions) {
    this.buffer = new TrailBuffer(options);
    this.group.name = 'trails';
    // Trails are thin lines against bright bodies; drawing them after the
    // meshes without depth-write avoids z-fighting on the near side.
    this.group.renderOrder = 1;
  }

  /** Add this to the scene once. */
  get object(): THREE.Object3D {
    return this.group;
  }

  setColor(id: string, color: string): void {
    if (this.colors.get(id) === color) return;
    this.colors.set(id, color);
    const entry = this.entries.get(id);
    if (entry) entry.material.color.set(color);
  }

  /** Forget all history — seek-backward, edits, system load. */
  clear(): void {
    this.buffer.clear();
    for (const entry of this.entries.values()) entry.geometry.setDrawRange(0, 0);
  }

  /**
   * Rebuild history from stored snapshots, discarding what was sampled per
   * frame. See `TrailBuffer.rebuild` for why frame sampling isn't sufficient
   * after a seek or a load.
   */
  rebuildFrom(
    samples: readonly { t: number; aliveIds: readonly string[]; pos: ArrayLike<number> }[],
    scale: number,
    now: number,
    aliveIds: readonly string[],
    positions: ArrayLike<number>
  ): void {
    this.buffer.rebuild(samples, scale, { t: now, aliveIds, pos: positions });
    for (const entry of this.entries.values()) entry.geometry.setDrawRange(0, 0);
  }

  /**
   * Extend history forward from snapshots recorded since the newest sample —
   * the per-frame counterpart of `rebuildFrom` for high warp, where the sim
   * outruns the grid every frame and a full rebuild would too. Draw ranges are
   * untouched: every track keeps its points and `update` rewrites them on the
   * version bump.
   */
  catchUpFrom(
    samples: readonly { t: number; aliveIds: readonly string[]; pos: ArrayLike<number> }[],
    scale: number,
    now: number,
    aliveIds: readonly string[],
    positions: ArrayLike<number>
  ): void {
    this.buffer.catchUp(samples, scale, { t: now, aliveIds, pos: positions });
  }

  /**
   * True when sim time has run past more than one sample slot since the last
   * recorded sample — i.e. appending a single point here would skip history.
   */
  outranSampling(t: number): boolean {
    return this.buffer.outranSampling(t);
  }

  /** Cheap and idempotent within a slot, so it is safe to call every frame. */
  maybeRecord(
    t: number,
    aliveIds: readonly string[],
    positions: ArrayLike<number>,
    scale: number
  ): void {
    if (!this.buffer.shouldSample(t)) return;
    this.buffer.record(t, aliveIds, positions, scale);
  }

  /**
   * How many samples the buffer keeps. Raising this lengthens every trail as
   * new samples accumulate; lowering it shortens them at once.
   */
  setCapacity(capacity: number): void {
    this.buffer.capacity = capacity;
  }

  /**
   * Rebuild the drawn geometry for every tracked body in the given reference
   * frame. Called each frame; the per-body work is a copy into an existing
   * Float32Array unless the trail grew.
   *
   * `oldest` is the sim time an ordinary body's trail reaches back to;
   * `selectedId` reaches back to `selectedOldest` instead, so picking a body
   * reveals more of its history without lengthening every other trail in the
   * scene. Time bounds rather than sample counts because the ring holds mixed
   * sample spacing after a snapshot rebuild — see `TrailBuffer.pointsFor`.
   *
   * A body present in `anchors` is drawn against its anchor body instead of
   * `referenceId`, offset to the anchor's current position; the rest keep the
   * reference-frame behaviour.
   */
  update(
    referenceId: string | null,
    visible: boolean,
    oldest = -Infinity,
    selectedId: string | null = null,
    selectedOldest = oldest,
    anchors?: ReadonlyMap<string, TrailAnchor>
  ): void {
    this.group.visible = visible;
    if (!visible) return;

    // Geometry is a pure function of buffer contents, the subtraction target
    // and the draw limits — none of which change on a paused frame, or between
    // samples while playing (callers quantize `oldest` to the sample grid so
    // it holds still between slots). Rebuilding anyway (pointsFor allocation
    // plus the attribute re-uploads) dominated the frame budget at rest, so
    // identical frames skip it. Anchored lines still ride their parent's
    // current position, which is a placement write, not geometry.
    if (
      this.buffer.version === this.lastVersion &&
      referenceId === this.lastReferenceId &&
      oldest === this.lastOldest &&
      selectedId === this.lastSelectedId &&
      selectedOldest === this.lastSelectedOldest &&
      !this.anchorsChanged(anchors)
    ) {
      if (anchors) {
        for (const [id, anchor] of anchors) {
          const entry = this.entries.get(id);
          if (entry) {
            entry.line.position
              .set(anchor.position.x, anchor.position.y, anchor.position.z)
              .add(entry.origin);
          }
        }
      }
      return;
    }

    this.lastVersion = this.buffer.version;
    this.lastReferenceId = referenceId;
    this.lastOldest = oldest;
    this.lastSelectedId = selectedId;
    this.lastSelectedOldest = selectedOldest;
    this.lastAnchorIds.clear();
    if (anchors) for (const [id, anchor] of anchors) this.lastAnchorIds.set(id, anchor.id);

    for (const id of [...this.buffer.trackedIds]) {
      const anchor = anchors?.get(id);
      const relativeTo = anchor ? anchor.id : referenceId;
      const count = this.buffer.countFor(
        id,
        relativeTo,
        Infinity,
        id === selectedId ? selectedOldest : oldest
      );
      // Size the entry before filling: a grown trail swaps in a fresh, larger
      // attribute array, and points written to the old one would be discarded
      // with it.
      const entry = this.entryFor(id, count);

      if (count === 0) {
        entry.geometry.setDrawRange(0, 0);
        continue;
      }

      entry.origin.set(0, 0, 0);
      this.buffer.newestPointInto(id, relativeTo, entry.origin);
      if (anchor) {
        entry.line.position
          .set(anchor.position.x, anchor.position.y, anchor.position.z)
          .add(entry.origin);
      } else {
        entry.line.position.copy(entry.origin);
      }

      const attr = entry.geometry.getAttribute('position') as THREE.BufferAttribute;
      this.buffer.copyPointsInto(
        id,
        relativeTo,
        count,
        attr.array as Float32Array,
        entry.origin.x,
        entry.origin.y,
        entry.origin.z
      );
      attr.needsUpdate = true;

      // Fade toward the tail: alpha is per-vertex so the oldest end dissolves
      // instead of ending in a hard stop.
      const alpha = entry.geometry.getAttribute('alpha') as THREE.BufferAttribute;
      const alphaArray = alpha.array as Float32Array;
      for (let i = 0; i < count; i++) alphaArray[i] = (i / (count - 1)) ** 2;
      alpha.needsUpdate = true;

      entry.geometry.setDrawRange(0, count);
    }
  }

  private anchorsChanged(anchors?: ReadonlyMap<string, TrailAnchor>): boolean {
    if ((anchors?.size ?? 0) !== this.lastAnchorIds.size) return true;
    if (anchors) {
      for (const [id, anchor] of anchors) {
        if (this.lastAnchorIds.get(id) !== anchor.id) return true;
      }
    }
    return false;
  }

  /** Release a single body's GPU resources (deleted from the roster). */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      this.group.remove(entry.line);
      entry.geometry.dispose();
      entry.material.dispose();
      this.entries.delete(id);
    }
    this.buffer.forget(id);
    this.colors.delete(id);
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
    this.group.clear();
  }

  private entryFor(id: string, needed: number): TrailEntry {
    let entry = this.entries.get(id);

    if (entry && entry.reserved >= needed) return entry;

    // Grow in chunks so a steadily-lengthening trail doesn't reallocate every
    // sample; capacity is the hard ceiling.
    const reserved = Math.max(64, Math.min(this.buffer.capacity, Math.ceil(needed * 1.5)));

    if (entry) {
      entry.geometry.dispose();
    } else {
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(this.colors.get(id) ?? '#ffffff'),
        transparent: true,
        depthWrite: false,
      });
      // Per-vertex alpha via onBeforeCompile: LineBasicMaterial has no vertex
      // alpha, and a custom ShaderMaterial would lose fog/tone-mapping wiring.
      material.onBeforeCompile = (shader) => {
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

      const line = new THREE.Line(new THREE.BufferGeometry(), material);
      line.frustumCulled = false;
      this.group.add(line);
      entry = { line, geometry: line.geometry, material, reserved: 0, origin: new THREE.Vector3() };
      this.entries.set(id, entry);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(reserved * 3), 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(reserved), 1));
    geometry.setDrawRange(0, 0);

    entry.line.geometry = geometry;
    entry.geometry = geometry;
    entry.reserved = reserved;
    return entry;
  }
}

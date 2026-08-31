// Direct-manipulation input: click-to-place, body drags, velocity gizmo.
//
// Listeners go in the capture phase on the *container div*, not the canvas:
// TrackballControls registered on the canvas first, so only an ancestor capture
// listener is guaranteed to run before it. stopPropagation() on a claimed event
// keeps the camera controls and SceneCanvas's click-to-select out of it.

import * as THREE from 'three';
import { exaggerationFor, SCENE_SCALE, type SceneManager } from './sceneManager';
import {
  closestPointOnAxis,
  intersectZPlane,
  pointerNdc,
  sceneToWorldM,
  worldMToScene,
  worldZToSceneZ,
} from './dragMath';
import type { GizmoAxis } from './gizmo';
import { vec3, type Vec3 } from '../physics/vec3';
import { dominantAttractor, soiRadius } from '../physics/orbitInfo';
import { history } from '../state/history.svelte';
import { sim } from '../state/simInstance';
import { time } from '../state/time.svelte';
import { ui, type PlacementDraft } from '../state/ui.svelte';
import type { BodyType } from '../types';
import {
  addBodyAtPoint,
  liveStateOf,
  previewDrop,
  system,
  updateBody,
} from '../state/system.svelte';

/** Pointer travel beyond this many px is a drag, not a click (matches SceneCanvas). */
const CLICK_SLOP_PX = 4;

/**
 * The same threshold for touch. A fingertip covers ~40 px and rolls several of
 * them through a tap that the user experienced as stationary, so the mouse's
 * 4 px turns most taps on the move handle into an orbit edit.
 */
const TOUCH_SLOP_PX = 14;

/** True for fingers and pens — anything without a pixel-precise cursor. */
function isCoarse(e: PointerEvent): boolean {
  return e.pointerType !== 'mouse';
}

/**
 * Screen-space snap radius for click-to-place, px of pointer from a body's
 * projected position. Snapping must happen in screen space: at system zoom a
 * planet and its entire sphere of influence are sub-pixel, so aiming a drop
 * into an SOI by world position alone meant zooming way in first — the same
 * problem the picker's inflated hit spheres solve for selection.
 */
const SNAP_PX = 18;

/** Types that exist to orbit something get a wider reach for their parent. */
const ORBITER_SNAP_PX = 30;
const ORBITER_TYPES = new Set<BodyType>(['moon', 'satellite', 'asteroid']);

/**
 * Ceiling on a snapped drop's orbit radius, as a fraction of the parent's SOI.
 * The snap is decided on screen, so the plane hit can be astronomically far
 * from the target; pulling it into the band where the target actually wins the
 * SOI resolution is what makes "anywhere near Mars" read as a Mars orbit
 * rather than a Sun orbit that happens to pass through Mars.
 */
const SNAP_MAX_SOI_FRACTION = 0.5;

/** Gizmo axis directions, read-only. Must match `AXIS_DIRECTIONS` in gizmo.ts. */
const AXIS_VECTORS: Record<GizmoAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** An in-flight drag: armed at pointerdown, live once past the slop. */
interface BodyDrag {
  /** 'move' repositions the body; 'velocity' pulls one gizmo axis handle */
  mode: 'move' | 'velocity';
  pointerId: number;
  bodyId: string;
  /** which velocity component the drag edits ('velocity' mode only) */
  axis: GizmoAxis | null;
  /**
   * Grip point in scene units along the axis: subtracting it keeps the handle
   * under the cursor instead of snapping to the pointer. ('velocity' only.)
   */
  axisGrip: number;
  /** state at pointerdown, restored wholesale if Escape cancels the drag */
  baseline: { position: Vec3; velocity: Vec3 };
  /** drag plane, frozen at grab: world z (m) of the body when picked up */
  planeZM: number;
  /** gizmo length mapping frozen at grab, m/s per scene unit ('velocity') */
  k: number;
  /** true once the pointer cleared the click slop — commits are flowing */
  active: boolean;
  /** px of travel that promotes this drag, by the pointer type that armed it */
  slop: number;
  /** last committed value, to skip no-op commits */
  lastX: number;
  lastY: number;
  lastZ: number;
}

export class SceneInteraction {
  private readonly ndc = new THREE.Vector2();
  private readonly planeHit = new THREE.Vector3();
  private readonly ghostPoint = new THREE.Vector3();
  private readonly orbitCenter = new THREE.Vector3();
  private readonly orbitNormal = new THREE.Vector3();
  private readonly scratchR = new THREE.Vector3();
  private readonly scratchV = new THREE.Vector3();
  private readonly gizmoOffset = new THREE.Vector3();
  private readonly cursorA = new THREE.Vector3();
  private readonly cursorB = new THREE.Vector3();
  private readonly snapScene = new THREE.Vector3();

  /** last cursor written to the container, so idle frames don't touch style */
  private cursor = '';

  private downX = 0;
  private downY = 0;
  private moved = false;

  /** last pointer position over the scene, for the per-frame ghost preview */
  private hoverX = 0;
  private hoverY = 0;
  private hovering = false;

  private drag: BodyDrag | null = null;
  /** a body-hit pointerdown was claimed; swallow the click that follows it */
  private claimedClick = false;
  /**
   * Fingers currently down, so a second one can veto a drag.
   *
   * A count resynchronized from `isPrimary` on every down, rather than a set of
   * ids we maintain: a pointer that dies without a matching up — captured
   * elsewhere, lost to a gesture the browser took over — would leak an id
   * forever and wedge body dragging off entirely.
   */
  private pointersDown = 0;

  /** true while a body drag is past the slop and committing edits */
  get isDragging(): boolean {
    return this.drag?.active ?? false;
  }

  constructor(
    private readonly manager: SceneManager,
    private readonly container: HTMLElement
  ) {
    this.container.addEventListener('pointerdown', this.onPointerDown, true);
    this.container.addEventListener('pointermove', this.onPointerMove, true);
    this.container.addEventListener('pointerup', this.onPointerUp, true);
    this.container.addEventListener('pointercancel', this.onPointerCancel, true);
    this.container.addEventListener('pointerleave', this.onPointerLeave, true);
    this.container.addEventListener('click', this.onClick, true);
    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    this.setCursor('');
    this.container.removeEventListener('pointerdown', this.onPointerDown, true);
    this.container.removeEventListener('pointermove', this.onPointerMove, true);
    this.container.removeEventListener('pointerup', this.onPointerUp, true);
    this.container.removeEventListener('pointercancel', this.onPointerCancel, true);
    this.container.removeEventListener('pointerleave', this.onPointerLeave, true);
    this.container.removeEventListener('click', this.onClick, true);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private onPointerDown = (e: PointerEvent): void => {
    // `isPrimary` is the browser's own answer to "is this the first finger",
    // so it resynchronizes the count whatever happened to earlier pointers.
    this.pointersDown = e.isPrimary ? 1 : this.pointersDown + 1;

    // A second finger means a pinch, whatever the first one landed on. Drop any
    // drag it armed — including one already committing, since a pinch that
    // starts on the selected planet is a zoom, not a move.
    if (this.pointersDown > 1) {
      if (this.drag) this.cancelDrag();
      return;
    }

    this.downX = e.clientX;
    this.downY = e.clientY;
    this.moved = false;

    // While placement is armed the canvas belongs to the drop: no body grab
    // competes with the click, and the camera stays live for drags.
    if (ui.placement !== null) return;

    // Shift is the camera pan modifier; secondary pointers are pinch gestures.
    if (e.button !== 0 || e.shiftKey || !e.isPrimary || this.drag) return;

    // The gizmo tip outranks the body under it: smaller, deliberately grabbed,
    // and only present on the already-selected body.
    const selectedId = ui.selectedBodyId;
    const axis = selectedId === null ? null : this.manager.pickGizmoHandle(e);
    if (selectedId !== null && axis !== null) {
      const live = liveStateOf(selectedId);
      if (live) {
        // A gizmo handle is a deliberate target — it only exists on the already
        // selected body, and it's small — so it claims on contact even on touch.
        e.stopPropagation();
        this.claimedClick = true;
        this.manager.setGizmoFrozen(true);
        this.drag = this.makeDrag('velocity', e, selectedId, live, axis);
        return;
      }
    }

    // Paused-only: while time runs the bodies are moving targets, and a grab
    // meant as a camera pan would drag whatever it landed on. The gizmo hides
    // while playing, but its DOM lags a frame behind the state change.
    if (time.playing) return;

    // The move handle is the only reposition target. A press anywhere else on
    // the selected body stays with the camera — grabbing the body itself made
    // every close-up camera orbit a silent edit to its orbit. Like the gizmo
    // handles it's small and deliberate, so it claims on contact even on touch.
    if (selectedId !== null && this.manager.isMoveIconTarget(e.target)) {
      const live = liveStateOf(selectedId);
      if (live && selectedId !== ui.referenceBodyId) {
        e.stopPropagation();
        this.claimedClick = true;
        this.drag = this.makeDrag('move', e, selectedId, live);
        return;
      }
    }

    // A press on an unselected body selects it and leaves the gesture to the
    // camera; the move handle it reveals is the way to drag it.
    const id = this.manager.pick(e);
    if (id !== null && id !== ui.selectedBodyId) ui.selectedBodyId = id;
  };

  private makeDrag(
    mode: 'move' | 'velocity',
    e: PointerEvent,
    bodyId: string,
    live: { position: Vec3; velocity: Vec3 },
    axis: GizmoAxis | null = null
  ): BodyDrag {
    const k = this.manager.gizmoScale();
    return {
      mode,
      pointerId: e.pointerId,
      bodyId,
      axis,
      axisGrip: axis === null ? 0 : this.axisGripAt(bodyId, live, axis, k),
      baseline: { position: live.position, velocity: live.velocity },
      planeZM: live.position.z,
      k,
      active: false,
      slop: isCoarse(e) ? TOUCH_SLOP_PX : CLICK_SLOP_PX,
      lastX: NaN,
      lastY: NaN,
      lastZ: NaN,
    };
  }

  /**
   * Offset in scene units from the grab to the *component* it edits, making the
   * drag a pure delta. Measured against the component, not the knob's drawn
   * position: the knob has a minimum stand-off from the body, so anchoring to
   * the drawn one would snap a small velocity up to that floor on grab.
   */
  private axisGripAt(
    bodyId: string,
    live: { position: Vec3; velocity: Vec3 },
    axis: GizmoAxis,
    k: number
  ): number {
    const rect = this.manager.domElement.getBoundingClientRect();
    pointerNdc(this.downX, this.downY, rect, this.ndc);

    const ref = this.refWorld();
    worldMToScene(live.position, ref, this.ghostPoint);
    // The drawn axis lines run through the gizmo's offset origin, not the body.
    this.ghostPoint.add(this.manager.gizmoOriginOffset(this.gizmoOffset));
    const s = closestPointOnAxis(
      this.manager.camera,
      this.ndc,
      this.ghostPoint,
      AXIS_VECTORS[axis]
    );
    if (s === null) return 0;

    const vRel = this.relativeVelocity(bodyId, live.velocity);
    return s - (vRel === null ? 0 : vRel[axis] / k);
  }

  /**
   * Velocity relative to the dominant attractor — what the gizmo draws. Null
   * when the body has left the sim mid-drag.
   */
  private relativeVelocity(bodyId: string, velocity: Vec3): Vec3 | null {
    const parent = this.parentVelocity(bodyId);
    if (parent === null) return null;
    return vec3(velocity.x - parent.x, velocity.y - parent.y, velocity.z - parent.z);
  }

  /** Velocity of the body's dominant attractor (zero if it has none). */
  private parentVelocity(bodyId: string): Vec3 | null {
    const index = sim.aliveIds.indexOf(bodyId);
    if (index < 0) return null;
    const { mass, pos, vel, n } = sim.state;
    const parent = dominantAttractor(index, mass, pos, n);
    if (parent === null) return vec3(0, 0, 0);
    const p3 = parent * 3;
    return vec3(vel[p3], vel[p3 + 1], vel[p3 + 2]);
  }

  private onPointerMove = (e: PointerEvent): void => {
    this.hoverX = e.clientX;
    this.hoverY = e.clientY;
    this.hovering = true;

    // The click/drag threshold is the gesture's own: a finger that rolls 6 px
    // through a tap has not dragged, a mouse that moves 6 px has.
    const slop = this.drag?.slop ?? (isCoarse(e) ? TOUCH_SLOP_PX : CLICK_SLOP_PX);
    if (Math.abs(e.clientX - this.downX) > slop || Math.abs(e.clientY - this.downY) > slop) {
      this.moved = true;
    }

    if (this.drag && e.pointerId === this.drag.pointerId && !this.drag.active && this.moved) {
      // Past the slop: a move, not a click. Capture so the drag survives
      // leaving the window.
      this.drag.active = true;
      this.container.setPointerCapture(e.pointerId);
      // A focus-follow tracks the body, so dragging the focused body would
      // carry the camera along with each commit and the cursor would chase a
      // point moving with it. Drop the follow.
      if (this.drag.mode === 'move' && ui.focusedBodyId === this.drag.bodyId) ui.clearFocus();
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointersDown = Math.max(0, this.pointersDown - 1);
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.endDrag(e.pointerId);
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.pointersDown = Math.max(0, this.pointersDown - 1);
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.endDrag(e.pointerId);
    // No click follows a cancel, so don't leave one armed to be swallowed.
    this.claimedClick = false;
  };

  /**
   * Abandon a drag a second finger vetoed. Anything already committed is
   * rolled back: a pinch that began on the move handle must leave the body's
   * orbit alone.
   */
  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;

    if (drag.active) {
      // Same restore-then-drop dance as Escape: fold the undo of the partial
      // drag into its own entry, then drop it so no step survives.
      const group =
        drag.mode === 'move' ? `move:${drag.bodyId}` : `velocity:${drag.bodyId}:${drag.axis}`;
      updateBody(
        drag.bodyId,
        { position: drag.baseline.position, velocity: drag.baseline.velocity },
        group
      );
      history.dropLast();
    }

    this.endDrag(drag.pointerId);
    // The gesture became a camera move, so no click of ours follows it.
    this.claimedClick = false;
  }

  private onPointerLeave = (e: PointerEvent): void => {
    // Children (the label layer) also fire leave events on the container's
    // capture listener; only the container's own boundary matters.
    if (e.target === this.container) this.hovering = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.drag) return;
    const { mode, bodyId, axis, baseline, active, pointerId } = this.drag;
    const group = mode === 'move' ? `move:${bodyId}` : `velocity:${bodyId}:${axis}`;
    if (!active) {
      this.endDrag(pointerId);
      return;
    }
    // Restore *before* endDrag closes the coalescing group, and under the
    // drag's own label, so it folds into the drag's entry instead of pushing a
    // second one — then drop that entry: a cancelled drag leaves no undo step.
    updateBody(bodyId, { position: baseline.position, velocity: baseline.velocity }, group);
    history.dropLast();
    this.endDrag(pointerId);
  };

  private endDrag(pointerId: number): void {
    if (this.container.hasPointerCapture(pointerId)) {
      this.container.releasePointerCapture(pointerId);
    }
    this.manager.setGizmoFrozen(false);
    this.drag = null;
    // Close the undo group: a second drag of the same body is a second step,
    // not a continuation of the first.
    history.endCoalescing();
  }

  private onClick = (e: MouseEvent): void => {
    // The click ending a claimed body gesture must not fall through to
    // SceneCanvas's click-to-select, which would re-pick — or deselect, after a
    // drag that ended over empty sky.
    if (this.claimedClick) {
      this.claimedClick = false;
      e.stopPropagation();
      return;
    }

    // Placement drops on a clean click only — a drag-release is the camera
    // orbiting while armed, which stays live so the user can line up the shot.
    if (ui.placementType === null || this.moved) return;
    if (this.place(e)) e.stopPropagation();
  };

  /**
   * The reference body's world position (m), or null in the barycentric
   * frame — the offset SceneManager subtracts from everything it renders.
   */
  private refWorld(): Vec3 | null {
    const refId = ui.referenceBodyId;
    if (refId === null) return null;
    const p = sim.positionOf(refId);
    return p ? vec3(p.x, p.y, p.z) : null;
  }

  /**
   * World z (m) of the heaviest live body — the plane placement drops onto.
   * The plane must be chosen before the drop point exists, so the primary's
   * ecliptic is the one predictable choice; an empty system uses z = 0.
   */
  private anchorZ(): number {
    const { mass, pos, n } = sim.state;
    if (n === 0) return 0;
    let heaviest = 0;
    for (let j = 1; j < n; j++) if (mass[j] > mass[heaviest]) heaviest = j;
    return pos[heaviest * 3 + 2];
  }

  /** True when a body was created. */
  private place(e: MouseEvent): boolean {
    const placement = ui.placement;
    if (placement === null) return false;

    const point = this.placementPointAt(e.clientX, e.clientY, placement);
    if (!point) return false;

    const body = addBodyAtPoint(placement.type, point);
    ui.selectedBodyId = body.id;
    ui.cancelPlacement();
    return true;
  }

  /**
   * Index of the body a placement at this pointer position snaps to, or null:
   * the nearest eligible body within the snap radius on screen. Eligibility is
   * previewDrop's candidate floor — the parent must out-mass the new body.
   */
  private snapTargetAt(clientX: number, clientY: number, placement: PlacementDraft): number | null {
    const rect = this.manager.domElement.getBoundingClientRect();
    const camera = this.manager.camera;
    const ref = this.refWorld();
    const { mass, pos, n } = sim.state;

    let best: number | null = null;
    let bestPx = ORBITER_TYPES.has(placement.type) ? ORBITER_SNAP_PX : SNAP_PX;
    for (let j = 0; j < n; j++) {
      if (mass[j] <= placement.mass) continue;
      const j3 = j * 3;
      this.snapScene.set(
        (pos[j3] - (ref?.x ?? 0)) / SCENE_SCALE,
        (pos[j3 + 1] - (ref?.y ?? 0)) / SCENE_SCALE,
        (pos[j3 + 2] - (ref?.z ?? 0)) / SCENE_SCALE
      );
      // Projection split in two so bodies behind the camera can be rejected —
      // project() flips them into the viewport.
      this.snapScene.applyMatrix4(camera.matrixWorldInverse);
      if (this.snapScene.z >= 0) continue;
      this.snapScene.applyMatrix4(camera.projectionMatrix);
      const px = rect.left + ((this.snapScene.x + 1) / 2) * rect.width;
      const py = rect.top + ((1 - this.snapScene.y) / 2) * rect.height;
      const d = Math.hypot(px - clientX, py - clientY);
      if (d < bestPx) {
        bestPx = d;
        best = j;
      }
    }
    return best;
  }

  /**
   * Pull a snapped drop point inside the band where the snap target actually
   * wins the SOI resolution — left alone, previewDrop would hand the "snapped"
   * body straight back to the star. The minimum side needs no counterpart
   * here: previewDrop and pushOutOfVisual already push a too-close drop out.
   */
  private clampIntoSoi(point: Vec3, parent: number): Vec3 {
    const { mass, pos, n } = sim.state;
    let primary = 0;
    for (let j = 1; j < n; j++) if (mass[j] > mass[primary]) primary = j;

    // The primary's SOI is the whole system; nothing to clamp against.
    const max = SNAP_MAX_SOI_FRACTION * soiRadius(mass, pos, parent, primary);
    if (!Number.isFinite(max)) return point;

    const p3 = parent * 3;
    const dx = point.x - pos[p3];
    const dy = point.y - pos[p3 + 1];
    const dz = point.z - pos[p3 + 2];
    const r = Math.hypot(dx, dy, dz);
    // r = 0 is previewDrop's case: it pushes a dead-center drop out itself.
    if (r <= max || r === 0) return point;

    const pull = max / r;
    return vec3(pos[p3] + dx * pull, pos[p3 + 1] + dy * pull, pos[p3 + 2] + dz * pull);
  }

  /**
   * Pointer → the point a drop would use: plane intersection (on the snap
   * target's plane when one is in reach), SOI clamp, visual push-out. Shared
   * by place() and the ghost so the preview never lies.
   */
  private placementPointAt(
    clientX: number,
    clientY: number,
    placement: PlacementDraft
  ): Vec3 | null {
    const snap = this.snapTargetAt(clientX, clientY, placement);
    // The snapped parent's own plane, not the primary's: a snapped drop
    // belongs to the parent's neighborhood, wherever it sits in z.
    const zM = snap === null ? this.anchorZ() : sim.state.pos[snap * 3 + 2];
    const raw = this.dropPointAt(clientX, clientY, zM);
    if (!raw) return null;
    const point = snap === null ? raw : this.clampIntoSoi(raw, snap);
    return this.pushOutOfVisual(point, placement.mass, placement.radius);
  }

  /**
   * Push a drop point out past its attractor's *rendered* disc.
   *
   * `previewDrop` clamps against true radii, which isn't enough: at ×50 radius
   * exaggeration a physically fine orbit sits deep inside the drawn ball and
   * the body looks like it vanished. The user aims at the rendered disc.
   */
  private pushOutOfVisual(point: Vec3, bodyMass: number, bodyRadius: number): Vec3 {
    const first = previewDrop(point, bodyMass, bodyRadius);
    if (!first.parentId || !first.parent) return first.position;

    const parentVisualM = this.manager.visualRadius(first.parentId) * SCENE_SCALE;
    const min = 1.5 * (parentVisualM + bodyRadius);
    const dx = first.position.x - first.parent.position.x;
    const dy = first.position.y - first.parent.position.y;
    const dz = first.position.z - first.parent.position.z;
    const r = Math.hypot(dx, dy, dz);
    if (r >= min) return first.position;

    // r > 0: previewDrop already pushed the point off the parent itself.
    const push = min / r;
    return vec3(
      first.parent.position.x + dx * push,
      first.parent.position.y + dy * push,
      first.parent.position.z + dz * push
    );
  }

  /** Pointer position → world meters on the plane z = `zM`, or null. */
  private dropPointAt(clientX: number, clientY: number, zM: number): Vec3 | null {
    const rect = this.manager.domElement.getBoundingClientRect();
    pointerNdc(clientX, clientY, rect, this.ndc);

    const ref = this.refWorld();
    const planeZ = worldZToSceneZ(zM, ref);
    const hit = intersectZPlane(this.manager.camera, this.ndc, planeZ, this.planeHit);
    return hit ? sceneToWorldM(hit, ref) : null;
  }

  /**
   * Per-frame hook, before the render: commits the in-flight drag (at most one
   * edit per frame, however many pointer events arrived) and drives the ghost.
   */
  update(): void {
    this.updateCursor();

    if (this.drag?.active) {
      if (this.drag.mode === 'move') this.updateDrag(this.drag);
      else this.updateVelocityDrag(this.drag);
      return;
    }

    const placement = ui.placement;
    if (!placement || !this.hovering) {
      this.manager.hideGhost();
      if (ui.placementParentId !== null) ui.placementParentId = null;
      return;
    }

    // The same resolution a click runs, so the ghost never lies.
    const point = this.placementPointAt(this.hoverX, this.hoverY, placement);
    if (!point) {
      this.manager.hideGhost();
      if (ui.placementParentId !== null) ui.placementParentId = null;
      return;
    }

    const drop = previewDrop(point, placement.mass, placement.radius);
    // Publish the *resolved* parent, never the snap candidate: a clamped point
    // can still land inside a moon's SOI, and the banner and highlight ring
    // must name what the drop will actually do.
    if (ui.placementParentId !== drop.parentId) ui.placementParentId = drop.parentId;
    const ref = this.refWorld();
    worldMToScene(drop.position, ref, this.ghostPoint);

    const radiusScene =
      (placement.radius * exaggerationFor(placement.type, ui.radiusExaggeration)) / SCENE_SCALE;

    let orbit: { center: THREE.Vector3; radius: number; normal: THREE.Vector3 } | null = null;
    if (drop.parent) {
      worldMToScene(drop.parent.position, ref, this.orbitCenter);
      // Orbit plane normal: r × v of the relative motion.
      this.scratchR
        .set(drop.position.x, drop.position.y, drop.position.z)
        .sub(this.scratchV.set(drop.parent.position.x, drop.parent.position.y, drop.parent.position.z));
      this.scratchV.set(
        drop.velocity.x - drop.parent.velocity.x,
        drop.velocity.y - drop.parent.velocity.y,
        drop.velocity.z - drop.parent.velocity.z
      );
      this.orbitNormal.crossVectors(this.scratchR, this.scratchV);
      if (this.orbitNormal.lengthSq() === 0) this.orbitNormal.set(0, 0, 1);
      else this.orbitNormal.normalize();

      orbit = {
        center: this.orbitCenter,
        radius: this.ghostPoint.distanceTo(this.orbitCenter),
        normal: this.orbitNormal,
      };
    }

    this.manager.showGhost(this.ghostPoint, radiusScene, placement.color, orbit);
  }

  private setCursor(value: string): void {
    if (this.cursor === value) return;
    this.cursor = value;
    this.container.style.cursor = value;
  }

  /**
   * Per-frame cursor: what would a press here do? `grabbing` for an in-flight
   * move, a resize-arrow pair aligned with the axis for a velocity handle.
   * (The move handle's hover `grab` is CSS on the element itself — it takes
   * pointer events, so it can announce itself without a raycast.)
   */
  private updateCursor(): void {
    // Placement owns the cursor via CSS (crosshair); an inline value beats the
    // class rule, so it must be cleared here.
    if (ui.placement !== null) {
      this.setCursor('');
      return;
    }

    const drag = this.drag;
    if (drag) {
      this.setCursor(
        drag.mode === 'move' || drag.axis === null
          ? 'grabbing'
          : this.axisCursor(drag.axis, drag.bodyId)
      );
      return;
    }

    const selectedId = ui.selectedBodyId;
    if (!this.hovering || time.playing || selectedId === null) {
      this.setCursor('');
      return;
    }

    const axis = this.manager.pickGizmoHandle({ clientX: this.hoverX, clientY: this.hoverY });
    if (axis !== null) {
      this.setCursor(this.axisCursor(axis, selectedId));
      return;
    }

    this.setCursor('');
  }

  /**
   * The resize cursor whose arrows track the axis's on-screen direction — a
   * world axis can project anywhere, so the glyph is picked from the projected
   * angle, not the axis name.
   */
  private axisCursor(axis: GizmoAxis, bodyId: string): string {
    const live = liveStateOf(bodyId);
    if (!live) return 'default';

    const ref = this.refWorld();
    worldMToScene(live.position, ref, this.cursorA);
    this.cursorA.add(this.manager.gizmoOriginOffset(this.gizmoOffset));
    // Step size only sets projection precision; a camera-relative one keeps it
    // numerically sane at any zoom.
    const step = Math.max(this.manager.camera.position.distanceTo(this.cursorA) * 0.05, 1e-12);
    this.cursorB.copy(this.cursorA).addScaledVector(AXIS_VECTORS[axis], step);
    this.cursorA.project(this.manager.camera);
    this.cursorB.project(this.manager.camera);

    const rect = this.manager.domElement.getBoundingClientRect();
    const dx = (this.cursorB.x - this.cursorA.x) * rect.width;
    // NDC y is up, screen y is down.
    const dy = -(this.cursorB.y - this.cursorA.y) * rect.height;

    // Fold to a line orientation in [0°, 180°) and bucket into the four
    // bidirectional resize glyphs.
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg < 0) deg += 180;
    if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
    if (deg < 67.5) return 'nwse-resize';
    if (deg < 112.5) return 'ns-resize';
    return 'nesw-resize';
  }

  /**
   * One frame of a live body drag: pointer → drop point on the frozen plane →
   * commit position + re-circularized velocity.
   *
   * Re-circularizing matches a fresh drop; keeping the raw velocity would eject
   * or crash the body on almost any inward drag. The velocity gizmo is the tool
   * for eccentric orbits. A body with no attractor just moves.
   */
  private updateDrag(drag: BodyDrag): void {
    const body = system.byId(drag.bodyId);
    if (!body) return;

    const rect = this.manager.domElement.getBoundingClientRect();
    pointerNdc(this.hoverX, this.hoverY, rect, this.ndc);

    const ref = this.refWorld();
    const hit = intersectZPlane(
      this.manager.camera,
      this.ndc,
      worldZToSceneZ(drag.planeZM, ref),
      this.planeHit
    );
    // A grazing ray keeps the last valid position rather than jumping.
    if (!hit) return;

    // The dragged body never parents itself: the SOI candidate floor is its
    // own mass, the same rule dominantAttractor applies to existing bodies.
    const point = this.pushOutOfVisual(sceneToWorldM(hit, ref), body.mass, body.radius);
    const drop = previewDrop(point, body.mass, body.radius);

    // Each commit rebuilds physics state and trails, so skip no-op ones.
    if (
      drop.position.x === drag.lastX &&
      drop.position.y === drag.lastY &&
      drop.position.z === drag.lastZ
    ) {
      return;
    }
    drag.lastX = drop.position.x;
    drag.lastY = drop.position.y;
    drag.lastZ = drop.position.z;

    // One undo entry for the whole gesture (see history.record).
    const group = `move:${drag.bodyId}`;
    if (drop.parent) {
      updateBody(drag.bodyId, { position: drop.position, velocity: drop.velocity }, group);
    } else {
      updateBody(drag.bodyId, { position: drop.position }, group);
    }
  }

  /**
   * One frame of a velocity-gizmo drag: the grabbed handle follows the pointer
   * along its axis, setting that one component through the frozen mapping.
   *
   * The other two components pass through untouched. Reading the *live*
   * velocity each frame rather than the grab-time baseline keeps a concurrent
   * edit to another component (numeric field) from being clobbered.
   */
  private updateVelocityDrag(drag: BodyDrag): void {
    const axis = drag.axis;
    if (axis === null) return;
    const live = liveStateOf(drag.bodyId);
    if (!live) return;

    const rect = this.manager.domElement.getBoundingClientRect();
    pointerNdc(this.hoverX, this.hoverY, rect, this.ndc);

    // The axis line runs through the gizmo's offset origin — the same line the
    // handle was grabbed on. The offset is frozen for the drag, so it can't
    // slide as commits land.
    const ref = this.refWorld();
    worldMToScene(live.position, ref, this.ghostPoint);
    this.ghostPoint.add(this.manager.gizmoOriginOffset(this.gizmoOffset));
    const s = closestPointOnAxis(
      this.manager.camera,
      this.ndc,
      this.ghostPoint,
      AXIS_VECTORS[axis]
    );
    // A ray nearly down the axis keeps the last valid value rather than jumping.
    if (s === null) return;

    // The gizmo shows attractor-relative velocity, so the handle sets the
    // relative component and the attractor's own motion rides on top.
    const parent = this.parentVelocity(drag.bodyId);
    if (parent === null) return;

    const velocity = vec3(
      live.velocity.x,
      live.velocity.y,
      live.velocity.z
    );
    velocity[axis] = parent[axis] + (s - drag.axisGrip) * drag.k;

    if (velocity.x === drag.lastX && velocity.y === drag.lastY && velocity.z === drag.lastZ) {
      return;
    }
    drag.lastX = velocity.x;
    drag.lastY = velocity.y;
    drag.lastZ = velocity.z;

    // Per-axis group: pulling x then y is two undo steps, one per gesture.
    updateBody(drag.bodyId, { velocity }, `velocity:${drag.bodyId}:${axis}`);
  }
}

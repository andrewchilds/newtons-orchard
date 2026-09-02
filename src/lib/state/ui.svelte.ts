// Reactive UI state — selection, panel state, render settings.

import type { BodyType } from '../types';
import { time } from './time.svelte';
import { TYPE_DEFAULTS } from '../ui/units';

/**
 * What click-to-place is armed with. Carries the type's defaults so the scene
 * can preview the drop without importing `ui/units` — `scene/` may not depend
 * on `ui/`.
 */
export interface PlacementDraft {
  type: BodyType;
  /** type-default mass, kg — the SOI candidate floor for the drop's parent */
  mass: number;
  /** type-default radius, m — ghost sphere sizing */
  radius: number;
  /** type-default color — ghost tint */
  color: string;
}

/** Sentinel for the inertial frame in `referenceFrame`. */
export const BARYCENTER = 'barycenter';

/**
 * Quarter turns the camera buttons can ask for — pitch, yaw and roll, all
 * *screen-relative* so each button does the same visible thing from every
 * vantage point. A turn about a fixed world axis degenerates when the camera
 * sits on that axis; deriving the axis from the camera has no such pole.
 */
export type CameraTurn = 'down' | 'right' | 'roll';

/**
 * A camera move the UI can ask for, applied by the scene about whatever the
 * controls are targeting.
 *
 * - `quarterTurn` snaps a tumbled view onto the 90° grid, then steps a quarter
 *   turn from there. Snapping (rather than turning purely relatively) stops a
 *   free mouse tumble's arbitrary angle being carried around forever.
 * - `zoom` scales the target distance by `factor` (<1 moves in).
 */
export type CameraMove =
  | { kind: 'quarterTurn'; turn: CameraTurn }
  | { kind: 'zoom'; factor: number };

/** One click of the zoom buttons. Matches roughly one wheel notch. */
export const ZOOM_STEP = 1.4;

/** Radius exaggeration slider bounds (log-scaled in the UI). */
export const MIN_EXAGGERATION = 1;
export const MAX_EXAGGERATION = 2000;

/**
 * Trail length slider bounds, in sim-days of history (log-scaled in the UI).
 * The top is only reachable because `MAX_TRAIL_SAMPLES` in
 * `scene/sceneManager.ts` clears it on the default 6-hour grid — the two have
 * to move together or the slider's upper travel does nothing.
 */
export const MIN_TRAIL_DAYS = 1;
export const MAX_TRAIL_DAYS = 10 * 365;

/** The selected body draws this many times more history than the rest. */
export const SELECTED_TRAIL_MULTIPLIER = 4;

class UiState {
  selectedBodyId = $state<string | null>(null);
  /** in-flight mission panel expanded — collapses to its header alone */
  missionOpen = $state(true);
  /** roster panel expanded — collapses to its header alone */
  bodiesOpen = $state(true);
  /** selected-body properties panel expanded — collapses to its header alone */
  propertiesOpen = $state(true);
  /** reference frame: BARYCENTER or a body id — render-only, never physics */
  referenceFrame = $state<string>(BARYCENTER);
  /** render-only body-radius exaggeration factor, ×1–×2000 */
  radiusExaggeration = $state(20);
  showLabels = $state(true);
  showTrails = $state(true);
  /** trail history drawn per body, in sim-days — see MIN/MAX_TRAIL_DAYS */
  trailDays = $state(100);
  /**
   * Draw each trail around its sphere-of-influence parent instead of the view
   * center, so a moon traces an ellipse riding its planet rather than a helix.
   * Parentless bodies keep the view-frame trail.
   */
  parentRelativeTrails = $state(true);
  /** faint polar axis lines, so axial tilt is readable */
  showAxes = $state(false);
  /** shaded annulus per star where an earthlike planet keeps liquid water */
  showHabitableZone = $state(false);
  /** velocity + net-acceleration arrows per body */
  showVectors = $state(false);
  /** dashed forward-integrated path for the selected body */
  showPrediction = $state(false);
  /** Star bloom. Off is the escape hatch for weak GPUs — it's a post pass. */
  bloom = $state(true);

  /**
   * Gravitational lensing around black holes. Only a black hole triggers the
   * pass, so it costs nothing elsewhere. Off is the escape hatch when the warp
   * obscures the orbit geometry: the screen-space approximation overstates the
   * bending of the hole's own satellites.
   */
  lensing = $state(true);

  /**
   * Hide every floating control and leave the bare scene. Also what the
   * preset-screenshot script drives. Not persisted: a reload is the escape
   * hatch if the un-hide button is missed.
   */
  chromeHidden = $state(false);

  /**
   * Body the camera is focused on (and following), or null. The scene owns the
   * camera, so it clears this if the body merges away.
   */
  focusedBodyId = $state<string | null>(null);

  /**
   * Camera position relative to the view center, in metres. Written by the
   * scene once per frame for `CameraReadout.svelte`. One object replaced
   * wholesale, not three `$state` numbers: one invalidation per frame, and the
   * readout wants all three components from the same frame.
   *
   * Display state derived from the camera, so the "physics never in reactive
   * state" rule doesn't apply — a dropped frame only means a stale label.
   */
  cameraOffset = $state<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });

  /**
   * Bumped to ask the camera to re-frame the focused body. Watched rather than
   * called directly, so the request survives the frame boundary.
   */
  focusRequest = $state(0);

  /** Bumped to snap the camera back onto the center. Cancels focus-follow. */
  centerRequest = $state(0);

  /** Focus the camera on a body: select it, follow it, snap the framing. */
  focusBody(id: string): void {
    this.selectedBodyId = id;
    this.focusedBodyId = id;
    this.focusRequest += 1;
  }

  /** Snap the framing back onto the focused body (after panning away). */
  refocus(): void {
    if (this.focusedBodyId !== null) this.focusRequest += 1;
  }

  /** Stop following the focused body. The camera stays where it is. */
  clearFocus(): void {
    this.focusedBodyId = null;
  }

  /** Bring the center back into view (after panning away). */
  recenter(): void {
    this.clearFocus();
    this.centerRequest += 1;
  }

  /**
   * Queued camera moves, drained (and cleared) by the scene once per frame. A
   * queue, not "latest wins": these are *relative* moves, so three quick clicks
   * on "yaw +90°" must all land.
   */
  cameraMoves = $state<CameraMove[]>([]);

  /**
   * Ask the scene for a camera move on its next frame. Unlike `recenter`, does
   * not cancel a focus-follow: these moves are relative to the controls'
   * target, so they re-aim the shot without giving up the subject.
   */
  moveCamera(move: CameraMove): void {
    this.cameraMoves = [...this.cameraMoves, move];
  }

  /**
   * Pull the camera to this distance from its target (m) on the next frame,
   * then back to null. Consumed after any pending center/focus request. Set by
   * the screenshot script and by preset opening views, so both can frame a
   * system at a scale the standard framing doesn't reach.
   */
  zoomRequest = $state<number | null>(null);

  /**
   * Swing the camera to the sunlit side of its target on the next frame, then
   * back to false. Only the screenshot script sets this.
   *
   * The standard framing puts the camera opposite the subject's orbit parent,
   * which for a planet means looking straight at its night side — a real
   * photographic map then renders as a near-black disc. A card that wants the
   * body's surface asks for the lit side instead.
   */
  sunwardRequest = $state(false);

  /** null when the inertial frame is selected — the form the scene wants. */
  get referenceBodyId(): string | null {
    return this.referenceFrame === BARYCENTER ? null : this.referenceFrame;
  }

  /**
   * Armed click-to-place draft, or null. While set, the scene shows a ghost
   * under the cursor and the next click drops a body there.
   */
  placement = $state<PlacementDraft | null>(null);

  /** The armed type alone, for templates. */
  get placementType(): BodyType | null {
    return this.placement?.type ?? null;
  }

  /**
   * Body the armed placement would orbit, written by the scene's ghost preview
   * (guarded on change, like `cameraOffset`) so the hint banner can name the
   * parent and the scene can ring it. Null when the drop has no attractor or
   * no ghost is showing.
   */
  placementParentId = $state<string | null>(null);

  /**
   * Arm click-to-place. Pauses the sim: the ghost previews an orbit around the
   * drop point's attractor, which would slide out from under the cursor if the
   * attractor kept moving.
   */
  armPlacement(type: BodyType): void {
    const defaults = TYPE_DEFAULTS[type];
    this.placement = {
      type,
      mass: defaults.mass,
      radius: defaults.radius,
      color: defaults.color,
    };
    this.placementParentId = null;
    time.playing = false;
  }

  /** Disarm click-to-place (Escape, or after a successful drop). */
  cancelPlacement(): void {
    this.placement = null;
    this.placementParentId = null;
  }
}

export const ui = new UiState();

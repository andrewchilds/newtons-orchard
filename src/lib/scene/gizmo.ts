// The velocity gizmo: three draggable per-axis arrows *beside* the selected
// body, shown only while paused. Arrows show velocity *relative to the dominant
// attractor* — a moon's absolute velocity is dominated by its planet's 30 km/s,
// so local changes would be sub-pixel on an absolute arrow.
//
// The whole widget sits at a screen-space offset from the body rather than
// originating on it: with both parked on the body center, the velocity handles
// and the move handle contested the same few pixels and a grab meant as a
// reposition edited velocity (and vice versa). The move handle on the body
// center is the *only* reposition target — grabbing anywhere on the body's
// disc made every close-up camera orbit a silent edit to its orbit.
//
// One arrow per axis rather than one along the velocity: each handle lives on a
// known line and constrains its drag to it, so a grab changes one component and
// the pointer needn't be precise about direction. Cost: a diagonal change takes
// more than one gesture.
//
// Unlike `VectorArrows` (sqrt-compressed, display only), these lengths must be
// *invertible* — dragging a handle to a point maps back to exactly one
// velocity. Linear `speed = length · k`, shared across axes so their lengths
// stay comparable. The mapping freezes during a drag: an arrow growing under
// the cursor must not re-scale itself mid-gesture.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mount, unmount } from 'svelte';
import { Move } from 'lucide-svelte';

export type GizmoAxis = 'x' | 'y' | 'z';

export const GIZMO_AXES: readonly GizmoAxis[] = ['x', 'y', 'z'];

/** Sentinel `userData.bodyId` per pick target, so a `Picker.pick` hit names the grabbed axis. */
export const GIZMO_HANDLE_IDS: Record<GizmoAxis, string> = {
  x: '__velocity-gizmo-x__',
  y: '__velocity-gizmo-y__',
  z: '__velocity-gizmo-z__',
};

const AXIS_BY_HANDLE_ID = new Map<string, GizmoAxis>(
  GIZMO_AXES.map((axis) => [GIZMO_HANDLE_IDS[axis], axis])
);

export function axisForHandleId(id: string | null): GizmoAxis | null {
  return id === null ? null : (AXIS_BY_HANDLE_ID.get(id) ?? null);
}

/** x red, y green, z blue — the same mapping the scene's axes overlay uses. */
const AXIS_COLORS: Record<GizmoAxis, number> = {
  x: 0xff6b6b,
  y: 0x7ddf64,
  z: 0x6ea8ff,
};

const AXIS_DIRECTIONS: Record<GizmoAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** Visible knob at each arrow tip, screen px (radius). */
const KNOB_PX = 5;
/** Invisible pick sphere around each knob, screen px (radius) — a fat target. */
const HANDLE_PX = 16;
/**
 * Floor on knob distance from the gizmo origin, so the three stay grabbable
 * and don't pile onto each other when the velocity is small.
 */
const MIN_KNOB_PX = 44;
/**
 * Gap between an arrow's tip and its knob, screen px. Touching, the head cone
 * and the dot melt into one blob; the gap is what makes the knob read as a
 * separate grabbable thing rather than part of the arrow.
 */
const KNOB_GAP_PX = 12;
/**
 * Screen px between the body's rendered disc and the gizmo origin. Close
 * enough to read as the body's own widget; the cost is that a floor-length
 * knob whose axis happens to project straight back at the body can graze the
 * disc — the hover cursor is what disambiguates that case.
 */
const ORIGIN_OFFSET_PX = 40;
/** Dot at the gizmo origin, screen px (radius) — anchors near-zero arrows. */
const ORIGIN_DOT_PX = 3;

/**
 * Fraction of camera distance a full-scale arrow spans. Generous on purpose:
 * the arrows are the grab targets, and longer is easier to see and to hit.
 */
const ARROW_VIEW_FRACTION = 0.3;

class AxisArrow {
  readonly object = new THREE.Group();
  readonly arrow: THREE.ArrowHelper;
  readonly knob: THREE.Mesh;
  readonly handle: THREE.Mesh;
  private readonly knobMaterial: THREE.MeshBasicMaterial;
  private readonly label: CSS2DObject;
  private readonly labelElement: HTMLDivElement;
  private readonly direction = new THREE.Vector3();

  constructor(
    readonly axis: GizmoAxis,
    sphereGeometry: THREE.SphereGeometry,
    handleMaterial: THREE.MeshBasicMaterial
  ) {
    const color = AXIS_COLORS[axis];

    this.arrow = new THREE.ArrowHelper(
      AXIS_DIRECTIONS[axis].clone(),
      new THREE.Vector3(),
      1,
      color,
      0.3,
      0.18
    );
    this.object.add(this.arrow);

    this.knobMaterial = new THREE.MeshBasicMaterial({ color, depthTest: false });
    this.knob = new THREE.Mesh(sphereGeometry, this.knobMaterial);
    this.knob.frustumCulled = false;
    this.knob.renderOrder = 10;
    this.object.add(this.knob);

    this.handle = new THREE.Mesh(sphereGeometry, handleMaterial);
    this.handle.frustumCulled = false;
    this.handle.userData.bodyId = GIZMO_HANDLE_IDS[axis];
    this.object.add(this.handle);

    this.labelElement = document.createElement('div');
    this.labelElement.className = `gizmo-speed axis-${axis}`;
    this.label = new CSS2DObject(this.labelElement);
    this.label.center.set(0.5, -0.6);
    this.knob.add(this.label);
  }

  /** `component` is the signed velocity component (m/s), `k` the shared m/s-per-scene-unit mapping. */
  update(
    origin: THREE.Vector3,
    component: number,
    k: number,
    cameraDistance: number,
    perPixel: number
  ): void {
    // Sign rides in the direction, so the arrow points the way the component
    // does and its length stays a magnitude.
    const length = Math.abs(component) / k;
    const sign = component < 0 ? -1 : 1;
    this.direction.copy(AXIS_DIRECTIONS[this.axis]).multiplyScalar(sign);

    this.arrow.position.copy(origin);
    this.arrow.setDirection(this.direction);
    if (length > 0) {
      const head = Math.min(length * 0.28, cameraDistance * perPixel * 14);
      this.arrow.setLength(length, head, head * 0.55);
      this.arrow.visible = true;
    } else {
      this.arrow.visible = false;
    }

    // The knob floats just past the tip and never collapses onto the origin —
    // a zero-component axis still needs a graspable handle.
    const minKnob = cameraDistance * perPixel * MIN_KNOB_PX;
    const knobDistance = Math.max(length, minKnob) + cameraDistance * perPixel * KNOB_GAP_PX;
    // Screen-sized against the camera-to-body distance; the knob sits within a
    // view-fraction of the body, so the error is a few percent.
    this.knob.position.copy(origin).addScaledVector(this.direction, knobDistance);
    this.knob.scale.setScalar(Math.max(cameraDistance * perPixel * KNOB_PX, 1e-9));
    this.handle.position.copy(this.knob.position);
    this.handle.scale.setScalar(Math.max(cameraDistance * perPixel * HANDLE_PX, 1e-9));

    this.labelElement.textContent = `${this.axis} ${formatSpeed(component)}`;
  }

  dispose(): void {
    this.knob.remove(this.label);
    this.labelElement.remove();
    this.knobMaterial.dispose();
    this.arrow.line.geometry.dispose();
    (this.arrow.line.material as THREE.Material).dispose();
    this.arrow.cone.geometry.dispose();
    (this.arrow.cone.material as THREE.Material).dispose();
  }
}

export class VelocityGizmo {
  readonly object = new THREE.Group();
  private readonly sphereGeometry = new THREE.SphereGeometry(1, 16, 12);
  private readonly handleMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private readonly arrows: Record<GizmoAxis, AxisArrow>;
  private readonly originDotMaterial: THREE.MeshBasicMaterial;
  private readonly originDot: THREE.Mesh;
  private readonly moveIcon: CSS2DObject;
  private readonly moveIconElement: HTMLDivElement;
  /** mounted lucide component, held only so dispose can unmount it */
  private readonly moveIconApp: ReturnType<typeof mount>;

  /** m/s per scene unit, shared across the three axes */
  private k = 1;
  /** body → gizmo origin, scene units; frozen with `k` across a drag */
  private readonly offset = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private frozen = false;

  constructor() {
    this.object.name = 'velocity-gizmo';
    this.object.visible = false;

    this.arrows = {
      x: new AxisArrow('x', this.sphereGeometry, this.handleMaterial),
      y: new AxisArrow('y', this.sphereGeometry, this.handleMaterial),
      z: new AxisArrow('z', this.sphereGeometry, this.handleMaterial),
    };
    for (const axis of GIZMO_AXES) this.object.add(this.arrows[axis].object);

    this.originDotMaterial = new THREE.MeshBasicMaterial({ color: 0xc8cede, depthTest: false });
    this.originDot = new THREE.Mesh(this.sphereGeometry, this.originDotMaterial);
    this.originDot.frustumCulled = false;
    this.originDot.renderOrder = 10;
    this.object.add(this.originDot);

    // CSS2D wants a raw element, so the icon component is mounted imperatively
    // rather than living in a .svelte file.
    this.moveIconElement = document.createElement('div');
    this.moveIconElement.className = 'gizmo-move';
    this.moveIconApp = mount(Move, {
      target: this.moveIconElement,
      props: { size: 13, strokeWidth: 2 },
    });
    this.moveIcon = new CSS2DObject(this.moveIconElement);
    this.object.add(this.moveIcon);
  }

  /** m/s per scene unit of the mapping currently drawn. */
  get scale(): number {
    return this.k;
  }

  /** The invisible pick targets for hit-testing grabs, one per axis. */
  get handleObjects(): THREE.Object3D[] {
    return GIZMO_AXES.map((axis) => this.arrows[axis].handle);
  }

  /**
   * True when a pointer event landed on the move handle. A DOM containment
   * check, not a raycast — the handle is a CSS2D element above the canvas, so
   * it never reaches the picker. Visibility gates it because the flags (and
   * the display style derived from them) lag a frame behind a state change.
   */
  isMoveTarget(target: EventTarget | null): boolean {
    return (
      this.object.visible &&
      this.moveIcon.visible &&
      target instanceof Node &&
      this.moveIconElement.contains(target)
    );
  }

  /** Freeze the length mapping and origin offset across a drag gesture. */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /**
   * Body → gizmo origin, scene units — the offset drag math must add to the
   * body's position to land on the drawn axis lines.
   */
  originOffset(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.offset);
  }

  /**
   * `bodyPosition` is the body's rendered position, `right` the camera-right
   * direction the widget offsets along, `vRel` the velocity relative to the
   * attractor (m/s), `refSpeed` the speed drawn at full view fraction,
   * `perPixel` the scene-units-per-pixel factor at unit distance (picking.ts
   * formula), `bodyRadius` the rendered radius the origin must clear.
   * `movable` hides the move icon on a body that can't be dragged (the
   * reference body).
   */
  update(
    bodyPosition: THREE.Vector3,
    right: THREE.Vector3,
    vRel: THREE.Vector3,
    refSpeed: number,
    cameraDistance: number,
    perPixel: number,
    bodyRadius = 0,
    movable = true
  ): void {
    if (!this.frozen) {
      const fullLength = Math.max(cameraDistance * ARROW_VIEW_FRACTION, 1e-9);
      this.k = Math.max(refSpeed, 1) / fullLength;
      // The offset freezes with the mapping: mid-drag the axis lines must not
      // slide out from under the grip they were grabbed at.
      this.offset
        .copy(right)
        .setLength(bodyRadius + cameraDistance * perPixel * ORIGIN_OFFSET_PX);
    }

    this.origin.copy(bodyPosition).add(this.offset);

    for (const axis of GIZMO_AXES) {
      this.arrows[axis].update(this.origin, vRel[axis], this.k, cameraDistance, perPixel);
    }

    this.originDot.position.copy(this.origin);
    this.originDot.scale.setScalar(Math.max(cameraDistance * perPixel * ORIGIN_DOT_PX, 1e-9));
    this.moveIcon.position.copy(bodyPosition);
    this.moveIcon.visible = movable;

    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }

  dispose(): void {
    for (const axis of GIZMO_AXES) this.arrows[axis].dispose();
    this.object.remove(this.moveIcon);
    void unmount(this.moveIconApp);
    this.moveIconElement.remove();
    this.originDotMaterial.dispose();
    this.sphereGeometry.dispose();
    this.handleMaterial.dispose();
  }
}

/** "1,234 m/s" below a kilometer a second, "12.34 km/s" above. */
function formatSpeed(speed: number): string {
  const magnitude = Math.abs(speed);
  const sign = speed < 0 ? '−' : '';
  if (magnitude < 1000) return `${sign}${Math.round(magnitude).toLocaleString()} m/s`;
  const km = magnitude / 1000;
  return `${sign}${km >= 100 ? km.toFixed(0) : km.toFixed(2)} km/s`;
}

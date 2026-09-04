// Key-driven camera drives: a smoothed rate that ramps toward where the held
// keys point and glides back to rest on release. Plain arrows fly the camera
// like a spaceship — the caller translates camera and target together by each
// frame's step, a pan, so orbit, zoom and follows keep composing with it.
// Option swaps the forward/back arrows for climb/descend along the camera's
// up. Shift-arrows orbit instead, swinging the camera about the target.
// Plus and minus dolly toward and away from it.
import * as THREE from 'three';

/** Cruise speed as a fraction of the camera–target distance per second.
 *  Distance-scaled so flying feels the same at moon scale and system scale;
 *  the target translates too, so the distance — and the speed — hold steady
 *  under a held key. */
export const FLIGHT_RATE = 0.6;

/** Orbit cruise, radians per second — a full circuit in about 15 s. Deliberately
 *  leisurely: the keys are for a slow survey, the mouse for a quick tumble. */
export const ORBIT_RATE = 0.4;

/** Zoom cruise in e-folds of camera–target distance per second: a held key
 *  halves or doubles the distance in a little under a second. Exponential so
 *  the feel is the same at every scale, like the wheel. */
export const ZOOM_RATE = 0.8;

/** Seconds for the velocity to close ~63% of the gap to its target. */
const SMOOTHING_TAU = 0.18;

/** Below this fraction of cruise speed the release glide reads as stopped. */
const STOP_FRACTION = 0.005;

/** Frames stall under a blocked main thread or a backgrounded tab; a raw
 *  wall delta there would turn the resting glide into one giant leap. */
const MAX_STEP_SECONDS = 0.1;

export type FlightKey = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down';

/** Plain arrows, and what the same arrows mean with Option held. Left and
 *  right stay put so a diagonal climb reads as forward-plus-turn would. */
const KEY_MAP: Record<string, { plain: FlightKey; vertical: FlightKey }> = {
  ArrowUp: { plain: 'forward', vertical: 'up' },
  ArrowDown: { plain: 'back', vertical: 'down' },
  ArrowLeft: { plain: 'left', vertical: 'left' },
  ArrowRight: { plain: 'right', vertical: 'right' },
};

export function flightKeyFor(key: string, vertical = false): FlightKey | null {
  const entry = KEY_MAP[key];
  if (!entry) return null;
  return vertical ? entry.vertical : entry.plain;
}

export type ZoomKey = 'in' | 'out';

/** `=` counts as in so the unshifted key works too, as in browsers; `_` is
 *  what Shift makes of minus, so a Shift held for orbiting doesn't lock out
 *  zooming out. */
const ZOOM_KEY_MAP: Record<string, ZoomKey> = {
  '+': 'in',
  '=': 'in',
  '-': 'out',
  _: 'out',
};

export function zoomKeyFor(key: string): ZoomKey | null {
  return ZOOM_KEY_MAP[key] ?? null;
}

/** For releases only: `code` names the physical key, which on a non-US
 *  layout may not be a plus or minus at all, so a press must go by `key`. */
const ZOOM_CODE_MAP: Record<string, ZoomKey> = {
  Equal: 'in',
  NumpadAdd: 'in',
  Minus: 'out',
  NumpadSubtract: 'out',
};

export function zoomKeyForCode(code: string): ZoomKey | null {
  return ZOOM_CODE_MAP[code] ?? null;
}

/** One axis of a drive: the key that pushes it positive and the key that
 *  pushes it negative. */
type Axis<K extends string> = readonly [positive: K, negative: K];

/**
 * Held keys plus the smoothed rate they drive along up to three axes, in
 * whatever unit the caller's `speed` is. Flight, Orbit and Zoom map the same
 * drive onto a translation, a pair of angles and a distance.
 */
class KeyDrive<K extends string> {
  private readonly held = new Set<K>();
  private readonly velocity = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

  constructor(private readonly axes: readonly Axis<K>[]) {}

  press(key: K): void {
    this.held.add(key);
  }

  release(key: K): void {
    this.held.delete(key);
  }

  releaseAll(): void {
    this.held.clear();
  }

  get active(): boolean {
    return this.velocity.lengthSq() > 0 || this.held.size > 0;
  }

  /** This frame's displacement into `out`; false — `out` untouched — at rest. */
  step(dt: number, speed: number, out: THREE.Vector3): boolean {
    this.desired.set(0, 0, 0);
    this.axes.forEach(([positive, negative], i) => {
      const push = (this.held.has(positive) ? 1 : 0) - (this.held.has(negative) ? 1 : 0);
      this.desired.setComponent(i, push);
    });
    const pushing = this.desired.lengthSq() > 0;
    // Normalized, or a diagonal would cruise √2 faster than a straight run.
    if (pushing) this.desired.normalize().multiplyScalar(speed);

    const clamped = Math.min(dt, MAX_STEP_SECONDS);
    // Exponential approach — frame-rate independent, unlike a fixed lerp factor.
    this.velocity.lerp(this.desired, 1 - Math.exp(-clamped / SMOOTHING_TAU));

    if (!pushing && this.velocity.length() < speed * STOP_FRACTION) {
      this.velocity.set(0, 0, 0);
      return false;
    }
    out.copy(this.velocity).multiplyScalar(clamped);
    return true;
  }
}

const FLIGHT_AXES: readonly Axis<FlightKey>[] = [
  ['right', 'left'],
  ['forward', 'back'],
  ['up', 'down'],
];

export class Flight {
  private readonly drive = new KeyDrive(FLIGHT_AXES);
  private readonly delta = new THREE.Vector3();

  press(key: FlightKey): void {
    this.drive.press(key);
  }

  release(key: FlightKey): void {
    this.drive.release(key);
  }

  /** For window blur — a keyup the page never sees wedges the camera in motion. */
  releaseAll(): void {
    this.drive.releaseAll();
  }

  get active(): boolean {
    return this.drive.active;
  }

  /**
   * Advance the smoothed velocity by `dt` seconds and write this frame's
   * world-space translation into `out`. `forward`, `right` and `up` must be
   * unit vectors; `speed` is the cruise speed in scene units per second.
   * Returns false — leaving `out` untouched — once the glide has decayed to
   * rest.
   */
  step(
    dt: number,
    forward: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    speed: number,
    out: THREE.Vector3
  ): boolean {
    if (!this.drive.step(dt, speed, this.delta)) return false;
    out
      .copy(forward)
      .multiplyScalar(this.delta.y)
      .addScaledVector(right, this.delta.x)
      .addScaledVector(up, this.delta.z);
    return true;
  }
}

export class Orbit {
  // Only the four plain arrows reach here; the vertical pair has no orbit
  // meaning, so the drive has no axis for it.
  private readonly drive = new KeyDrive<FlightKey>(FLIGHT_AXES.slice(0, 2));
  private readonly delta = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();

  press(key: FlightKey): void {
    this.drive.press(key);
  }

  release(key: FlightKey): void {
    this.drive.release(key);
  }

  releaseAll(): void {
    this.drive.releaseAll();
  }

  get active(): boolean {
    return this.drive.active;
  }

  /**
   * Advance by `dt` seconds and swing `position` about `target` by this
   * frame's angles: yaw about `up`, pitch about `right`. Screen-relative like
   * the quarter-turn buttons, so the keys never hit a pole. Pitch tilts `up`
   * too, or the camera would keep re-levelling against the axis it just
   * rotated past. `rate` is radians per second. Returns false — touching
   * nothing — once the glide has decayed to rest.
   */
  step(
    dt: number,
    rate: number,
    target: THREE.Vector3,
    up: THREE.Vector3,
    right: THREE.Vector3,
    position: THREE.Vector3
  ): boolean {
    if (!this.drive.step(dt, rate, this.delta)) return false;
    position.sub(target);
    // With (right, up, back) right-handed, +yaw about up carries the camera
    // toward its right, but +pitch about right carries it *down* — negated so
    // the up arrow lifts the camera over the target.
    this.rotation.setFromAxisAngle(up, this.delta.x);
    position.applyQuaternion(this.rotation);
    this.rotation.setFromAxisAngle(right, -this.delta.y);
    position.applyQuaternion(this.rotation);
    up.applyQuaternion(this.rotation).normalize();
    position.add(target);
    return true;
  }
}

export class Zoom {
  private readonly drive = new KeyDrive<ZoomKey>([['in', 'out']]);
  private readonly delta = new THREE.Vector3();

  press(key: ZoomKey): void {
    this.drive.press(key);
  }

  release(key: ZoomKey): void {
    this.drive.release(key);
  }

  releaseAll(): void {
    this.drive.releaseAll();
  }

  get active(): boolean {
    return this.drive.active;
  }

  /**
   * Advance by `dt` seconds and return the factor to multiply the camera–
   * target distance by this frame — below 1 zooming in — or exactly 1 once
   * the glide has decayed to rest. `rate` is e-folds per second.
   */
  step(dt: number, rate: number): number {
    if (!this.drive.step(dt, rate, this.delta)) return 1;
    return Math.exp(-this.delta.x);
  }
}

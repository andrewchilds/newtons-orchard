// Arrow-key camera drives: a smoothed rate that ramps toward where the held
// keys point and glides back to rest on release. Plain arrows fly the camera
// like a spaceship — the caller translates camera and target together by each
// frame's step, a pan, so orbit, zoom and follows keep composing with it.
// Shift-arrows orbit instead, swinging the camera about the target.
import * as THREE from 'three';

/** Cruise speed as a fraction of the camera–target distance per second.
 *  Distance-scaled so flying feels the same at moon scale and system scale;
 *  the target translates too, so the distance — and the speed — hold steady
 *  under a held key. */
export const FLIGHT_RATE = 0.6;

/** Orbit cruise, radians per second — a full circuit in about 15 s. Deliberately
 *  leisurely: the keys are for a slow survey, the mouse for a quick tumble. */
export const ORBIT_RATE = 0.4;

/** Seconds for the velocity to close ~63% of the gap to its target. */
const SMOOTHING_TAU = 0.18;

/** Below this fraction of cruise speed the release glide reads as stopped. */
const STOP_FRACTION = 0.005;

/** Frames stall under a blocked main thread or a backgrounded tab; a raw
 *  wall delta there would turn the resting glide into one giant leap. */
const MAX_STEP_SECONDS = 0.1;

export type FlightKey = 'forward' | 'back' | 'left' | 'right';

const KEY_MAP: Record<string, FlightKey> = {
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

export function flightKeyFor(key: string): FlightKey | null {
  return KEY_MAP[key] ?? null;
}

/**
 * Held keys plus the smoothed 2D rate they drive — x starboard, y ahead — in
 * whatever unit the caller's `speed` is. Flight and Orbit map the same drive
 * onto a translation and a pair of angles.
 */
class KeyDrive {
  private readonly held: Record<FlightKey, boolean> = {
    forward: false,
    back: false,
    left: false,
    right: false,
  };
  private readonly velocity = new THREE.Vector2();
  private readonly desired = new THREE.Vector2();

  press(key: FlightKey): void {
    this.held[key] = true;
  }

  release(key: FlightKey): void {
    this.held[key] = false;
  }

  releaseAll(): void {
    this.held.forward = this.held.back = this.held.left = this.held.right = false;
  }

  get active(): boolean {
    return (
      this.velocity.lengthSq() > 0 ||
      this.held.forward ||
      this.held.back ||
      this.held.left ||
      this.held.right
    );
  }

  /** This frame's displacement into `out`; false — `out` untouched — at rest. */
  step(dt: number, speed: number, out: THREE.Vector2): boolean {
    const ahead = (this.held.forward ? 1 : 0) - (this.held.back ? 1 : 0);
    const starboard = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);

    this.desired.set(starboard, ahead);
    // Normalized, or a diagonal would cruise √2 faster than a straight run.
    if (ahead !== 0 || starboard !== 0) this.desired.normalize().multiplyScalar(speed);

    const clamped = Math.min(dt, MAX_STEP_SECONDS);
    // Exponential approach — frame-rate independent, unlike a fixed lerp factor.
    this.velocity.lerp(this.desired, 1 - Math.exp(-clamped / SMOOTHING_TAU));

    if (ahead === 0 && starboard === 0 && this.velocity.length() < speed * STOP_FRACTION) {
      this.velocity.set(0, 0);
      return false;
    }
    out.copy(this.velocity).multiplyScalar(clamped);
    return true;
  }
}

export class Flight {
  private readonly drive = new KeyDrive();
  private readonly delta = new THREE.Vector2();

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
   * world-space translation into `out`. `forward` and `right` must be unit
   * vectors; `speed` is the cruise speed in scene units per second. Returns
   * false — leaving `out` untouched — once the glide has decayed to rest.
   */
  step(
    dt: number,
    forward: THREE.Vector3,
    right: THREE.Vector3,
    speed: number,
    out: THREE.Vector3
  ): boolean {
    if (!this.drive.step(dt, speed, this.delta)) return false;
    out.copy(forward).multiplyScalar(this.delta.y).addScaledVector(right, this.delta.x);
    return true;
  }
}

export class Orbit {
  private readonly drive = new KeyDrive();
  private readonly delta = new THREE.Vector2();
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

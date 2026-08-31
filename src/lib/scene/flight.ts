// Arrow-key spaceship flight: a smoothed velocity that ramps toward where the
// held keys point and glides back to rest on release. The caller translates
// camera and target together by each frame's step — a pan, so orbit, zoom and
// follows keep composing with it.
import * as THREE from 'three';

/** Cruise speed as a fraction of the camera–target distance per second.
 *  Distance-scaled so flying feels the same at moon scale and system scale;
 *  the target translates too, so the distance — and the speed — hold steady
 *  under a held key. */
export const FLIGHT_RATE = 0.6;

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

export class Flight {
  private readonly held: Record<FlightKey, boolean> = {
    forward: false,
    back: false,
    left: false,
    right: false,
  };
  private readonly velocity = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

  press(key: FlightKey): void {
    this.held[key] = true;
  }

  release(key: FlightKey): void {
    this.held[key] = false;
  }

  /** For window blur — a keyup the page never sees wedges the camera in motion. */
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
    const ahead = (this.held.forward ? 1 : 0) - (this.held.back ? 1 : 0);
    const starboard = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);

    this.desired.set(0, 0, 0);
    if (ahead !== 0 || starboard !== 0) {
      this.desired.addScaledVector(forward, ahead).addScaledVector(right, starboard);
      // Normalized, or a diagonal would cruise √2 faster than a straight run.
      this.desired.normalize().multiplyScalar(speed);
    }

    const clamped = Math.min(dt, MAX_STEP_SECONDS);
    // Exponential approach — frame-rate independent, unlike a fixed lerp factor.
    this.velocity.lerp(this.desired, 1 - Math.exp(-clamped / SMOOTHING_TAU));

    if (ahead === 0 && starboard === 0 && this.velocity.length() < speed * STOP_FRACTION) {
      this.velocity.set(0, 0, 0);
      return false;
    }
    out.copy(this.velocity).multiplyScalar(clamped);
    return true;
  }
}

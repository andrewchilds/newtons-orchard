// Snapshot store for time scrubbing.
//
// Snapshots carry mass/radius/roster (not just pos/vel) because collision
// merges change them mid-timeline — seeking to before a merge must resurrect
// the absorbed body. Stored every fixed interval of sim time (default
// 1 sim-day), capped ~100k; decimate oldest 2× when hit.

import type { PhysicsState } from '../physics/integrator';

export interface Snapshot {
  /** sim time, seconds */
  t: number;
  /** ids of bodies alive at t, index-aligned with the arrays below */
  aliveIds: string[];
  mass: Float64Array;
  radius: Float64Array;
  /** Schwarzschild radii — nonzero only for black holes (see PhysicsState.rs) */
  rs: Float64Array;
  /** xyz interleaved */
  pos: Float64Array;
  /** xyz interleaved */
  vel: Float64Array;
}

/** Default cap on stored snapshots before decimation kicks in. */
export const DEFAULT_MAX_SNAPSHOTS = 100_000;

/**
 * A growing, time-ordered list of snapshots supporting binary-search lookup of
 * the latest snapshot at or before a given time.
 *
 * Accelerations are deliberately not stored: they're a pure function of the
 * positions and masses, so a restore recomputes them.
 */
export class SnapshotStore {
  private snapshots: Snapshot[] = [];

  /**
   * Sim-time spacing between retained snapshots. Doubles on every decimation,
   * so the store degrades resolution rather than coverage as a run gets long.
   */
  private currentInterval: number;

  constructor(
    /** requested spacing, seconds — the store may retain coarser than this */
    readonly baseInterval: number,
    readonly maxSnapshots = DEFAULT_MAX_SNAPSHOTS
  ) {
    this.currentInterval = baseInterval;
  }

  get count(): number {
    return this.snapshots.length;
  }

  /** Current retained spacing — grows by 2× per decimation. */
  get interval(): number {
    return this.currentInterval;
  }

  /** Time of the newest snapshot, or -Infinity when empty. */
  get latestTime(): number {
    const last = this.snapshots[this.snapshots.length - 1];
    return last === undefined ? -Infinity : last.t;
  }

  /**
   * Whether `t` is due for a snapshot. A compare against the latest rather
   * than a modulo on sim time, which would drift and would fight decimation's
   * widened interval.
   */
  shouldRecord(t: number): boolean {
    const latest = this.latestTime;
    return latest === -Infinity || t >= latest + this.currentInterval;
  }

  /**
   * Copy `state` into the store, tagged with `t` and the roster `aliveIds`
   * (index-aligned with the state arrays). Decimates if the cap is exceeded.
   */
  record(t: number, aliveIds: readonly string[], state: PhysicsState): void {
    this.snapshots.push({
      t,
      aliveIds: aliveIds.slice(),
      mass: state.mass.slice(),
      radius: state.radius.slice(),
      rs: state.rs.slice(),
      pos: state.pos.slice(),
      vel: state.vel.slice(),
    });

    if (this.snapshots.length > this.maxSnapshots) this.decimate();
  }

  /**
   * The latest snapshot at or before `t`, or null if `t` precedes the oldest.
   * Binary search: the store holds 100k entries and seek runs on the frame path.
   */
  findAtOrBefore(t: number): Snapshot | null {
    let lo = 0;
    let hi = this.snapshots.length - 1;
    let found: Snapshot | null = null;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.snapshots[mid].t <= t) {
        found = this.snapshots[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return found;
  }

  /**
   * Snapshots in `[from, to]`, oldest→newest. Lets the scene rebuild trail
   * history from stored state rather than from the instants frames landed on:
   * a frame during a long catch-up advances the sim thousands of steps, so
   * frame-sampled history chords straight across an orbit. Snapshots sit on
   * their own sim-time grid regardless of frame pacing.
   */
  between(from: number, to: number): readonly Snapshot[] {
    const out: Snapshot[] = [];
    for (const s of this.snapshots) {
      if (s.t < from) continue;
      if (s.t > to) break;
      out.push(s);
    }
    return out;
  }

  /** Drop every snapshot strictly after `t`. Used when an edit invalidates the future. */
  dropAfter(t: number): void {
    let keep = this.snapshots.length;
    while (keep > 0 && this.snapshots[keep - 1].t > t) keep -= 1;
    if (keep < this.snapshots.length) this.snapshots.length = keep;
  }

  clear(): void {
    this.snapshots.length = 0;
    this.currentInterval = this.baseInterval;
  }

  /**
   * Keep every other snapshot and double the interval to match, so the thinned
   * spacing stays uniform across the timeline. Index 0 always survives, so a
   * seek to t = 0 can always land. A coarser grid only means more
   * re-integration between snapshot and target, never a wrong state.
   */
  private decimate(): void {
    const kept: Snapshot[] = [];
    for (let i = 0; i < this.snapshots.length; i += 2) kept.push(this.snapshots[i]);
    this.snapshots = kept;
    this.currentInterval *= 2;
  }
}

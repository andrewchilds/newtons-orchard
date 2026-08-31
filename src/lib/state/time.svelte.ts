// Reactive time state and the frame tick that drives the simulation.
//
// Wall-clock time only decides *what sim time to ask for*, never the size of a
// physics step. The integrator's dt is fixed: a slow frame means more steps, not
// longer ones.

import { Simulation, DEFAULT_MAX_STEPS } from '../sim/simulation';
import { DAY, HOUR, YEAR } from '../physics/constants';

/** Warp presets: sim-seconds per wall-second. */
export const WARP_PRESETS = [
  { label: '1 min/s', value: 60 },
  { label: '1 hr/s', value: HOUR },
  { label: '1 day/s', value: DAY },
  { label: '1 wk/s', value: 7 * DAY },
  { label: '1 mo/s', value: 30 * DAY },
  { label: '1 yr/s', value: YEAR },
] as const;

/**
 * Cap on the wall-clock delta a single frame may consume, seconds. Without it,
 * returning to a backgrounded tab requests a multi-hour sim jump the app grinds
 * through for minutes. So one `tick` can never advance more than
 * `MAX_FRAME_DELTA × rate`, whatever wall delta is passed in.
 */
export const MAX_FRAME_DELTA = 0.1;

class TimeState {
  /** current sim time, seconds */
  simTime = $state(0);
  playing = $state(false);
  /** sim-seconds per wall-second */
  timeWarp = $state<number>(WARP_PRESETS[2].value);
  /** how far the sim has been computed, seconds */
  computedUntil = $state(0);
  /** true when the sim is behind the requested time (step budget hit) */
  computing = $state(false);

  /**
   * Bumped whenever the sim state jumps discontinuously (seek, reset, edit) so
   * the scene can clear history-based visuals like trails.
   */
  seekGeneration = $state(0);

  /**
   * Live shuttle rate in sim-seconds per wall-second, 0 when centered. While
   * held it overrides `playing`/`timeWarp` entirely — an absolute rate control,
   * not a multiplier on the warp preset.
   */
  shuttleRate = $state(0);

  /**
   * True while the shuttle is held, including inside the deadzone. Separate from
   * `shuttleRate` because held-at-center and released both read 0 rate but mean
   * opposite things; only release hands the clock back.
   */
  shuttleHeld = $state(false);
}

export const time = new TimeState();

/**
 * Advance `sim` by the requested wall-clock delta and sync reactive time state.
 * Call once per animation frame. `simTime` is the *requested* time and may run
 * ahead of the sim while it catches up; the scene renders the sim's own `time`.
 */
export function tick(sim: Simulation, wallDelta: number, maxSteps = DEFAULT_MAX_STEPS): void {
  const delta = Math.min(wallDelta, MAX_FRAME_DELTA);

  // While held, the shuttle governs time entirely, ignoring `playing` and the
  // warp preset. Inside the deadzone that means rate 0 — the clock stops until
  // the handle is released.
  if (time.shuttleHeld) {
    time.simTime = Math.max(0, time.simTime + delta * time.shuttleRate);
  } else if (time.playing) {
    time.simTime += delta * time.timeWarp;
  }

  const movingBackward = time.simTime < sim.time;

  const budgetHit = sim.seek(time.simTime, maxSteps);
  time.computing = budgetHit;

  if (budgetHit) {
    // Hold the request at the reachable edge so playback lags instead of the
    // target running away and never being caught.
    time.simTime = sim.time;
  }

  // Backward motion invalidates history-derived visuals: trails must be rebuilt
  // rather than extended.
  if (movingBackward) time.seekGeneration += 1;

  time.computedUntil = sim.computedUntil;
}

/**
 * Jump straight to `t`, outside the frame tick. Used by rewind and by the edit
 * path, which must land on the edit time before invalidating.
 */
export function seekTo(sim: Simulation, t: number): void {
  const target = Math.max(0, t);
  const wasBackward = target < sim.time;

  sim.seek(target);
  time.simTime = sim.time;
  time.computedUntil = sim.computedUntil;
  time.computing = false;

  if (wasBackward) time.seekGeneration += 1;
}

/** Reset the clock to t = 0 without touching the roster. */
export function rewind(sim: Simulation): void {
  seekTo(sim, 0);
}

import { beforeEach, describe, expect, it } from 'vitest';
import { time, tick, seekTo, rewind, MAX_FRAME_DELTA } from './time.svelte';
import { Simulation } from '../sim/simulation';
import { DAY, EARTH_MASS, EARTH_ORBIT, EARTH_RADIUS, SUN_MASS, SUN_RADIUS } from '../physics/constants';
import { circularOrbit } from '../physics/kepler';
import { testBody, AT_ORIGIN } from '../physics/testUtils';
import type { Body } from '../types';

function twoBody(): Body[] {
  const earth = circularOrbit(SUN_MASS, AT_ORIGIN, EARTH_ORBIT, 0, 0, EARTH_MASS);
  return [
    testBody({ id: 'sun', type: 'star', mass: SUN_MASS, radius: SUN_RADIUS }),
    testBody({
      id: 'earth',
      mass: EARTH_MASS,
      radius: EARTH_RADIUS,
      position: earth.position,
      velocity: earth.velocity,
    }),
  ];
}

function freshSim() {
  return new Simulation(twoBody(), { dt: 600, snapshotInterval: DAY });
}

// The time state is a module-level singleton, so each test resets it.
beforeEach(() => {
  time.simTime = 0;
  time.playing = false;
  time.timeWarp = DAY;
  time.computedUntil = 0;
  time.computing = false;
  time.seekGeneration = 0;
  time.shuttleRate = 0;
  time.shuttleHeld = false;
});

/** Hold the shuttle at `rate` — the state a pointer on the handle produces. */
function holdShuttle(rate: number) {
  time.shuttleRate = rate;
  time.shuttleHeld = true;
}

describe('tick', () => {
  it('does nothing while paused and centered', () => {
    const sim = freshSim();
    tick(sim, 1 / 60);
    expect(time.simTime).toBe(0);
    expect(sim.time).toBe(0);
  });

  it('advances at the warp rate while playing', () => {
    const sim = freshSim();
    time.playing = true;
    time.timeWarp = DAY;

    // A frame shorter than the clamp passes through untouched.
    tick(sim, 0.05);
    expect(time.simTime).toBeCloseTo(0.05 * DAY, 6);
  });

  it('clamps an oversized wall delta so a backgrounded tab does not stall', () => {
    const sim = freshSim();
    time.playing = true;
    time.timeWarp = DAY;

    // 30 wall-seconds would be 30 sim-days without the clamp.
    tick(sim, 30);
    expect(time.simTime).toBeCloseTo(MAX_FRAME_DELTA * DAY, 6);
  });

  it('applies the same clamp to shuttle scrubbing', () => {
    const sim = freshSim();
    holdShuttle(DAY);

    tick(sim, 30);
    expect(time.simTime).toBeCloseTo(MAX_FRAME_DELTA * DAY, 6);
  });

  it('tracks the computed extent', () => {
    const sim = freshSim();
    time.playing = true;
    tick(sim, 1);
    expect(time.computedUntil).toBe(sim.computedUntil);
    expect(time.computedUntil).toBeGreaterThan(0);
  });
});

describe('shuttle override', () => {
  it('scrubs forward at the shuttle rate, ignoring the warp preset', () => {
    const sim = freshSim();
    time.playing = false;
    time.timeWarp = 60; // deliberately different from the shuttle rate
    holdShuttle(10 * DAY);

    tick(sim, MAX_FRAME_DELTA);
    expect(time.simTime).toBeCloseTo(MAX_FRAME_DELTA * 10 * DAY, 6);
  });

  it('overrides playback rather than adding to it', () => {
    const sim = freshSim();
    time.playing = true;
    time.timeWarp = DAY;
    holdShuttle(5 * DAY);

    tick(sim, MAX_FRAME_DELTA);
    // The shuttle rate alone — the warp preset contributes nothing.
    expect(time.simTime).toBeCloseTo(MAX_FRAME_DELTA * 5 * DAY, 6);
  });

  // The deadzone reads as rate 0, which is also what a released shuttle reads.
  // Holding the handle over the center has to keep time stopped rather than
  // handing the clock back to playback under the user's thumb.
  it('holds time still while the handle is held inside the deadzone', () => {
    const sim = freshSim();
    sim.advanceTo(10 * DAY, Infinity);
    time.simTime = 10 * DAY;
    time.playing = true;
    time.timeWarp = DAY;

    holdShuttle(0);
    tick(sim, MAX_FRAME_DELTA);

    expect(time.simTime).toBe(10 * DAY);
    expect(sim.time).toBe(10 * DAY);
  });

  it('stays put across many frames held at center', () => {
    const sim = freshSim();
    time.playing = true;
    holdShuttle(0);

    for (let i = 0; i < 30; i++) tick(sim, MAX_FRAME_DELTA);
    expect(time.simTime).toBe(0);
  });

  it('resumes playback once the shuttle is released', () => {
    const sim = freshSim();
    time.playing = true;
    time.timeWarp = DAY;

    holdShuttle(0);
    tick(sim, MAX_FRAME_DELTA);
    expect(time.simTime).toBe(0);

    // Release: rate and hold both drop, and the warp preset takes over again.
    time.shuttleRate = 0;
    time.shuttleHeld = false;
    tick(sim, MAX_FRAME_DELTA);
    expect(time.simTime).toBeCloseTo(MAX_FRAME_DELTA * DAY, 6);
  });

  // Dragging back through center mid-gesture is the same hold: the rate passes
  // through 0 without the pointer ever coming up.
  it('stops when dragged back to center without releasing', () => {
    const sim = freshSim();
    time.playing = true;
    time.timeWarp = DAY;

    holdShuttle(10 * DAY);
    tick(sim, MAX_FRAME_DELTA);
    const scrubbed = time.simTime;
    expect(scrubbed).toBeGreaterThan(0);

    holdShuttle(0);
    tick(sim, MAX_FRAME_DELTA);
    expect(time.simTime).toBe(scrubbed);
  });

  it('holds time still at center even while paused', () => {
    const sim = freshSim();
    time.playing = false;
    holdShuttle(0);

    tick(sim, MAX_FRAME_DELTA);
    expect(time.simTime).toBe(0);
  });

  it('scrubs backward and the sim follows', () => {
    const sim = freshSim();
    sim.advanceTo(20 * DAY, Infinity);
    time.simTime = 20 * DAY;

    // 0.1 s at 50 day/s reverse ⇒ back 5 days.
    holdShuttle(-50 * DAY);
    tick(sim, MAX_FRAME_DELTA);

    expect(time.simTime).toBeCloseTo(15 * DAY, 6);
    expect(sim.time).toBe(15 * DAY);
  });

  it('clamps at t = 0 when reversing past the start', () => {
    const sim = freshSim();
    sim.advanceTo(2 * DAY, Infinity);
    time.simTime = 2 * DAY;

    holdShuttle(-100 * DAY);
    tick(sim, 1);

    expect(time.simTime).toBe(0);
    expect(sim.time).toBe(0);
  });

  it('bumps seekGeneration on backward motion so trails rebuild', () => {
    const sim = freshSim();
    sim.advanceTo(20 * DAY, Infinity);
    time.simTime = 20 * DAY;

    const before = time.seekGeneration;
    holdShuttle(-DAY);
    tick(sim, 1);

    expect(time.seekGeneration).toBeGreaterThan(before);
  });

  it('leaves seekGeneration alone when moving forward', () => {
    const sim = freshSim();
    time.playing = true;
    const before = time.seekGeneration;

    tick(sim, 1);
    expect(time.seekGeneration).toBe(before);
  });

  it('reverse scrubbing reproduces the forward trajectory exactly', () => {
    const sim = freshSim();

    // Play forward, sampling the state at a known time.
    sim.advanceTo(30 * DAY, Infinity);
    sim.seek(10 * DAY);
    const forwardPositions = Array.from(sim.state.pos);

    // Return to the end, then shuttle back to the same instant.
    sim.seek(30 * DAY);
    time.simTime = 30 * DAY;
    holdShuttle(-200 * DAY); // 0.1 s × 200 day/s ⇒ back 20 days
    tick(sim, MAX_FRAME_DELTA);

    expect(sim.time).toBe(10 * DAY);
    expect(Array.from(sim.state.pos)).toEqual(forwardPositions);
  });
});

describe('seekTo and rewind', () => {
  it('seekTo lands on the requested time', () => {
    const sim = freshSim();
    seekTo(sim, 12 * DAY);
    expect(sim.time).toBe(12 * DAY);
    expect(time.simTime).toBe(12 * DAY);
  });

  it('seekTo clamps negatives to zero', () => {
    const sim = freshSim();
    seekTo(sim, 5 * DAY);
    seekTo(sim, -100);
    expect(time.simTime).toBe(0);
  });

  it('rewind returns to t = 0 and flags the discontinuity', () => {
    const sim = freshSim();
    seekTo(sim, 15 * DAY);
    const before = time.seekGeneration;

    rewind(sim);
    expect(time.simTime).toBe(0);
    expect(sim.time).toBe(0);
    expect(time.seekGeneration).toBeGreaterThan(before);
  });

  it('rewind preserves the computed extent', () => {
    const sim = freshSim();
    seekTo(sim, 15 * DAY);
    rewind(sim);
    expect(time.computedUntil).toBe(15 * DAY);
  });
});

import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import {
  DAY,
  EARTH_MASS,
  EARTH_ORBIT,
  EARTH_RADIUS,
  MOON_MASS,
  MOON_ORBIT,
  MOON_RADIUS,
  SUN_MASS,
  SUN_RADIUS,
  YEAR,
} from '../physics/constants';
import { circularOrbit } from '../physics/kepler';
import { vec3 } from '../physics/vec3';
import { testBody, AT_ORIGIN } from '../physics/testUtils';
import type { Body } from '../types';

/** Sun + Earth + Moon — the placeholder system, built independently here. */
function sunEarthMoon(): Body[] {
  const earth = circularOrbit(SUN_MASS, AT_ORIGIN, EARTH_ORBIT, 0, 0, EARTH_MASS);
  const moon = circularOrbit(EARTH_MASS, earth, MOON_ORBIT, 5.145, 0, MOON_MASS);

  return [
    testBody({ id: 'sun', name: 'Sun', type: 'star', mass: SUN_MASS, radius: SUN_RADIUS }),
    testBody({
      id: 'earth',
      name: 'Earth',
      mass: EARTH_MASS,
      radius: EARTH_RADIUS,
      position: earth.position,
      velocity: earth.velocity,
    }),
    testBody({
      id: 'moon',
      name: 'Moon',
      type: 'moon',
      mass: MOON_MASS,
      radius: MOON_RADIUS,
      position: moon.position,
      velocity: moon.velocity,
    }),
  ];
}

/**
 * Relative error. Masses and momenta here run to 1e27, where `toBeCloseTo`'s
 * absolute tolerance sits far below a single float64 ulp and can never pass.
 */
function relError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

/** Every number describing the sim's current instant, for bit-exact compares. */
function snapshotOf(sim: Simulation) {
  return {
    time: sim.time,
    ids: [...sim.aliveIds],
    mass: Array.from(sim.state.mass),
    radius: Array.from(sim.state.radius),
    pos: Array.from(sim.state.pos),
    vel: Array.from(sim.state.vel),
  };
}

describe('time grid', () => {
  it('only ever sits on exact multiples of dt', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600 });
    // Off-grid requests floor to the step below — never a partial step, which
    // is what makes replay at a different frame rate reproduce the trajectory.
    sim.advanceTo(1000);
    expect(sim.time).toBe(600);

    sim.advanceTo(1199);
    expect(sim.time).toBe(600);

    sim.advanceTo(1200);
    expect(sim.time).toBe(1200);
  });

  it('advancing to a past time is a no-op', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600 });
    sim.advanceTo(10 * DAY);
    const before = snapshotOf(sim);
    sim.advanceTo(DAY);
    expect(snapshotOf(sim)).toEqual(before);
  });
});

describe('seek determinism', () => {
  it('play to T, seek 0, seek T reproduces T bit for bit', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    const T = 90 * DAY;

    sim.advanceTo(T, Infinity);
    const atT = snapshotOf(sim);

    sim.seek(0);
    expect(sim.time).toBe(0);

    sim.seek(T);
    expect(snapshotOf(sim)).toEqual(atT);
  });

  it('reproduces the same state regardless of how many hops it took to get there', () => {
    const T = 40 * DAY;

    const direct = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    direct.advanceTo(T, Infinity);

    const wandering = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    wandering.advanceTo(60 * DAY, Infinity);
    wandering.seek(5 * DAY);
    wandering.seek(55 * DAY);
    wandering.seek(2 * DAY);
    wandering.seek(T);

    expect(snapshotOf(wandering)).toEqual(snapshotOf(direct));
  });

  it('scrubbing back and forth across many points never drifts', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    sim.advanceTo(30 * DAY, Infinity);

    const reference = new Map<number, ReturnType<typeof snapshotOf>>();
    for (const days of [3, 11, 19, 27]) {
      sim.seek(days * DAY);
      reference.set(days, snapshotOf(sim));
    }

    // Same targets, visited in a different order and interleaved with others.
    for (const days of [27, 3, 19, 11, 3, 27]) {
      sim.seek(days * DAY);
      expect(snapshotOf(sim)).toEqual(reference.get(days));
    }
  });

  it('seek past the computed edge extends the timeline', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    sim.advanceTo(5 * DAY, Infinity);
    expect(sim.computedUntil).toBe(5 * DAY);

    sim.seek(20 * DAY);
    expect(sim.time).toBe(20 * DAY);
    expect(sim.computedUntil).toBe(20 * DAY);
  });

  it('clamps negative seeks to zero', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600 });
    sim.advanceTo(3 * DAY, Infinity);
    sim.seek(-1e9);
    expect(sim.time).toBe(0);
  });
});

describe('snapshot decimation', () => {
  it('keeps seek exact after the store decimates', () => {
    // A tiny cap forces several decimations over the run.
    const sim = new Simulation(sunEarthMoon(), {
      dt: 600,
      snapshotInterval: DAY,
      maxSnapshots: 8,
    });

    const T = 100 * DAY;
    sim.advanceTo(T, Infinity);
    const atT = snapshotOf(sim);

    sim.seek(0);
    sim.seek(T);
    expect(snapshotOf(sim)).toEqual(atT);
  });

  it('can still seek to intermediate times not on the thinned grid', () => {
    const dense = new Simulation(sunEarthMoon(), {
      dt: 600,
      snapshotInterval: DAY,
      maxSnapshots: 100_000,
    });
    const thin = new Simulation(sunEarthMoon(), {
      dt: 600,
      snapshotInterval: DAY,
      maxSnapshots: 6,
    });

    dense.advanceTo(80 * DAY, Infinity);
    thin.advanceTo(80 * DAY, Infinity);

    const target = 37 * DAY;
    dense.seek(target);
    thin.seek(target);

    // Different snapshot grids, identical re-integrated state.
    expect(snapshotOf(thin)).toEqual(snapshotOf(dense));
  });
});

describe('step budget', () => {
  it('caps per-frame work and reports that it did', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600 });
    const hit = sim.advanceTo(YEAR, 100);

    expect(hit).toBe(true);
    expect(sim.time).toBe(100 * 600);
  });

  it('does not report a cap when the request fits the budget', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600 });
    const hit = sim.advanceTo(50 * 600, 100);

    expect(hit).toBe(false);
    expect(sim.time).toBe(50 * 600);
  });

  it('repeated capped calls reach the same state as one uncapped call', () => {
    const capped = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    const uncapped = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });

    const T = 20 * DAY;
    uncapped.advanceTo(T, Infinity);
    while (capped.time < T) capped.advanceTo(T, 37);

    expect(snapshotOf(capped)).toEqual(snapshotOf(uncapped));
  });
});

describe('collisions', () => {
  /**
   * Two bodies closing head-on along x, guaranteed to overlap. Separation and
   * closing speed are set so the merge lands around t ≈ 2.5 d — comfortably
   * after the 1-day mark the pre-merge assertions below sample at.
   */
  function collisionCourse(): Body[] {
    return [
      testBody({
        id: 'a',
        name: 'Alpha',
        mass: 2 * EARTH_MASS,
        radius: EARTH_RADIUS,
        position: vec3(-5e7, 0, 0),
        velocity: vec3(100, 0, 0),
      }),
      testBody({
        id: 'b',
        name: 'Beta',
        mass: EARTH_MASS,
        radius: EARTH_RADIUS,
        position: vec3(5e7, 0, 0),
        velocity: vec3(-100, 0, 0),
      }),
    ];
  }

  function momentumOf(sim: Simulation) {
    const { n, mass, vel } = sim.state;
    const p = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) p[k] += mass[i] * vel[i * 3 + k];
    }
    return p;
  }

  it('merges on overlap, conserving mass and momentum', () => {
    const sim = new Simulation(collisionCourse(), { dt: 600, snapshotInterval: DAY });
    const before = momentumOf(sim);

    sim.advanceTo(5 * DAY, Infinity);

    expect(sim.aliveIds).toEqual(['a']);
    expect(relError(sim.state.mass[0], 3 * EARTH_MASS)).toBeLessThan(1e-12);

    // Relative, not absolute: momentum here is ~1e27, where toBeCloseTo's
    // absolute tolerance is far below one float64 ulp and always fails.
    const after = momentumOf(sim);
    const scale = Math.hypot(before[0], before[1], before[2]);
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(after[k] - before[k]) / scale).toBeLessThan(1e-12);
    }
  });

  it('the more massive body survives regardless of ordering', () => {
    const reversed = collisionCourse().reverse();
    const sim = new Simulation(reversed, { dt: 600 });
    sim.advanceTo(5 * DAY, Infinity);
    expect(sim.aliveIds).toEqual(['a']);
  });

  /**
   * Three bodies overlapping simultaneously. Collision pairs are reported by
   * the force loop during the step, but a merge moves the survivor and grows
   * its radius, invalidating every other pair in that report — so the resolve
   * loop must take one pair at a time and re-read a refreshed list rather than
   * draining the stale one. Three mutually-overlapping bodies is the smallest
   * case that tells those two behaviours apart.
   */
  it('resolves a three-body pile-up in a single step', () => {
    const overlapping = [
      testBody({
        id: 'small',
        name: 'Small',
        mass: EARTH_MASS,
        radius: EARTH_RADIUS,
        position: vec3(0, 0, 0),
        velocity: vec3(0, 0, 0),
      }),
      testBody({
        id: 'big',
        name: 'Big',
        mass: 5 * EARTH_MASS,
        radius: EARTH_RADIUS,
        position: vec3(EARTH_RADIUS, 0, 0),
        velocity: vec3(0, 0, 0),
      }),
      testBody({
        id: 'mid',
        name: 'Mid',
        mass: 2 * EARTH_MASS,
        radius: EARTH_RADIUS,
        position: vec3(-EARTH_RADIUS, 0, 0),
        velocity: vec3(0, 0, 0),
      }),
    ];

    const sim = new Simulation(overlapping, { dt: 600 });
    const before = momentumOf(sim);

    sim.advanceTo(600, Infinity);

    // Everything collapses into the most massive body, in one step.
    expect(sim.aliveIds).toEqual(['big']);
    expect(sim.state.n).toBe(1);
    expect(relError(sim.state.mass[0], 8 * EARTH_MASS)).toBeLessThan(1e-12);
    expect(sim.merges).toHaveLength(2);

    // Both merges are stamped at the same instant and conserve momentum.
    expect(sim.merges[0].t).toBe(sim.merges[1].t);
    const after = momentumOf(sim);
    for (let k = 0; k < 3; k++) expect(Math.abs(after[k] - before[k])).toBeLessThan(1e15);
  });

  it('records the merge as a timeline event', () => {
    const sim = new Simulation(collisionCourse(), { dt: 600 });
    sim.advanceTo(5 * DAY, Infinity);

    expect(sim.merges).toHaveLength(1);
    const merge = sim.merges[0];
    expect(merge.survivorId).toBe('a');
    expect(merge.absorbedId).toBe('b');
    expect(merge.absorbedName).toBe('Beta');
    expect(merge.t).toBeGreaterThan(0);
  });

  it('notifies merge listeners', () => {
    const sim = new Simulation(collisionCourse(), { dt: 600 });
    const seen: string[] = [];
    sim.onMerge((e) => seen.push(e.absorbedId));

    sim.advanceTo(5 * DAY, Infinity);
    expect(seen).toEqual(['b']);
  });

  it('summed volumes set the survivor radius', () => {
    const sim = new Simulation(collisionCourse(), { dt: 600 });
    sim.advanceTo(5 * DAY, Infinity);
    expect(relError(sim.state.radius[0], Math.cbrt(2) * EARTH_RADIUS)).toBeLessThan(1e-12);
  });

  /** When the pair merges, and a sampling time comfortably before that. */
  function mergeTiming() {
    const probe = new Simulation(collisionCourse(), { dt: 600 });
    probe.advanceTo(5 * DAY, Infinity);
    const mergeTime = probe.merges[0].t;
    // Half way in is safely clear of both t = 0 and the merge itself.
    const beforeMerge = Math.floor(mergeTime / 2 / 600) * 600;
    return { mergeTime, beforeMerge };
  }

  it('seeking to before the merge restores both bodies exactly', () => {
    const { beforeMerge } = mergeTiming();
    const sim = new Simulation(collisionCourse(), { dt: 600, snapshotInterval: 3600 });

    // Capture the true pre-merge state on the first pass forward.
    sim.advanceTo(beforeMerge, Infinity);
    expect(sim.aliveIds).toHaveLength(2);
    const preMerge = snapshotOf(sim);

    sim.advanceTo(5 * DAY, Infinity);
    expect(sim.aliveIds).toHaveLength(1);

    sim.seek(beforeMerge);
    expect(sim.aliveIds).toEqual(['a', 'b']);
    expect(snapshotOf(sim)).toEqual(preMerge);
  });

  it('drops merge events when seeking back before them, and re-emits on replay', () => {
    const { beforeMerge } = mergeTiming();
    const sim = new Simulation(collisionCourse(), { dt: 600, snapshotInterval: 3600 });
    sim.advanceTo(5 * DAY, Infinity);
    expect(sim.merges).toHaveLength(1);

    sim.seek(beforeMerge);
    expect(sim.merges).toHaveLength(0);

    sim.seek(5 * DAY);
    expect(sim.merges).toHaveLength(1);
  });

  it('the post-merge trajectory is identical whether replayed or computed once', () => {
    const { beforeMerge } = mergeTiming();

    const once = new Simulation(collisionCourse(), { dt: 600, snapshotInterval: 3600 });
    once.advanceTo(6 * DAY, Infinity);

    // Rewinding to before the merge and replaying re-runs the merge itself,
    // so this covers the whole restore → re-collide → continue path.
    const replayed = new Simulation(collisionCourse(), { dt: 600, snapshotInterval: 3600 });
    replayed.advanceTo(6 * DAY, Infinity);
    replayed.seek(beforeMerge);
    replayed.seek(6 * DAY);

    expect(snapshotOf(replayed)).toEqual(snapshotOf(once));
  });

  it('resolves a three-body pile-up in a single step', () => {
    // Three overlapping bodies at t = 0's first step: all should collapse to one.
    const bodies = [
      testBody({ id: 'a', mass: 3e24, radius: 1e7, position: vec3(0, 0, 0) }),
      testBody({ id: 'b', mass: 2e24, radius: 1e7, position: vec3(5e6, 0, 0) }),
      testBody({ id: 'c', mass: 1e24, radius: 1e7, position: vec3(-5e6, 0, 0) }),
    ];
    const sim = new Simulation(bodies, { dt: 600 });
    sim.advanceTo(600, Infinity);

    expect(sim.aliveIds).toEqual(['a']);
    expect(relError(sim.state.mass[0], 6e24)).toBeLessThan(1e-12);
    expect(sim.merges).toHaveLength(2);
  });

  it('an edit after the merge does not resurrect the absorbed body', () => {
    const sim = new Simulation(collisionCourse(), { dt: 600 });
    sim.advanceTo(5 * DAY, Infinity);
    expect(sim.aliveIds).toEqual(['a']);

    // An unrelated edit hands the sim the full roster, dead entry included —
    // that entry must not get a slot in the rebuilt state.
    sim.applyBodyEdits(sim.bodies);

    expect(sim.aliveIds).toEqual(['a']);
    // The roster keeps the dead body (snapshots from before the merge still
    // need its metadata), but flags it stale so saves can exclude it.
    expect(sim.bodies.map((b) => b.id)).toEqual(['a', 'b']);
    expect([...sim.staleBodyIds]).toEqual(['b']);
  });

  it('an edit after the merge leaves scrubbing back before it intact', () => {
    const { beforeMerge } = mergeTiming();
    const sim = new Simulation(collisionCourse(), { dt: 600, snapshotInterval: 3600 });
    sim.advanceTo(5 * DAY, Infinity);
    sim.applyBodyEdits(sim.bodies);

    sim.seek(beforeMerge);
    expect(sim.aliveIds).toEqual(['a', 'b']);
  });

  it('staleness clears once a seek back re-enlivens the body and an edit rebases again', () => {
    const { beforeMerge } = mergeTiming();
    const sim = new Simulation(collisionCourse(), { dt: 600, snapshotInterval: 3600 });
    sim.advanceTo(5 * DAY, Infinity);
    sim.applyBodyEdits(sim.bodies);
    expect([...sim.staleBodyIds]).toEqual(['b']);

    // Seeking back before the merge drops its event and restores both bodies;
    // the next rebase sees nothing dead.
    sim.seek(beforeMerge);
    sim.applyBodyEdits(sim.bodies);
    expect(sim.staleBodyIds.size).toBe(0);
    expect(sim.aliveIds).toEqual(['a', 'b']);
  });

  it('a load clears staleness with everything else', () => {
    const sim = new Simulation(collisionCourse(), { dt: 600 });
    sim.advanceTo(5 * DAY, Infinity);
    sim.applyBodyEdits(sim.bodies);
    expect(sim.staleBodyIds.size).toBe(1);

    sim.load(collisionCourse());
    expect(sim.staleBodyIds.size).toBe(0);
  });
});

describe('invalidation and edits', () => {
  it('invalidateAfter pulls the computed edge back', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    sim.advanceTo(50 * DAY, Infinity);
    sim.seek(10 * DAY);

    sim.invalidateAfter(sim.time);
    expect(sim.computedUntil).toBe(10 * DAY);
  });

  it('a mid-flight mass edit changes the future but not the past', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    sim.advanceTo(30 * DAY, Infinity);

    sim.seek(10 * DAY);
    const atEditTime = snapshotOf(sim);

    const edited = sim.bodies.map((b) =>
      b.id === 'earth' ? { ...b, mass: b.mass * 10 } : b
    );
    sim.applyBodyEdits(edited);

    // The instant of the edit keeps its positions; only the mass moved.
    expect(sim.time).toBe(10 * DAY);
    expect(Array.from(sim.state.pos)).toEqual(atEditTime.pos);
    expect(relError(sim.state.mass[1], EARTH_MASS * 10)).toBeLessThan(1e-12);

    // The future is gone and recomputes differently.
    expect(sim.computedUntil).toBe(10 * DAY);

    const unedited = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    unedited.seek(30 * DAY);
    sim.seek(30 * DAY);
    expect(Array.from(sim.state.pos)).not.toEqual(Array.from(unedited.state.pos));
  });

  it('seeking back to the edit time restores the edited values, not the originals', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    sim.advanceTo(30 * DAY, Infinity);
    sim.seek(10 * DAY);

    sim.applyBodyEdits(
      sim.bodies.map((b) => (b.id === 'earth' ? { ...b, mass: b.mass * 10 } : b))
    );
    const afterEdit = snapshotOf(sim);

    sim.seek(20 * DAY);
    sim.seek(10 * DAY);
    expect(snapshotOf(sim)).toEqual(afterEdit);
  });

  it('adding a body mid-flight keeps the existing bodies where they were', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    sim.seek(10 * DAY);
    const before = Array.from(sim.state.pos);

    const extra = testBody({
      id: 'newcomer',
      mass: EARTH_MASS,
      radius: EARTH_RADIUS,
      position: vec3(2 * EARTH_ORBIT, 0, 0),
      velocity: vec3(0, 21_000, 0),
    });
    sim.applyBodyEdits([...sim.bodies, extra]);

    expect(sim.aliveIds).toEqual(['sun', 'earth', 'moon', 'newcomer']);
    expect(Array.from(sim.state.pos).slice(0, 9)).toEqual(before);
    expect(sim.state.pos[9]).toBe(2 * EARTH_ORBIT);
  });

  it('deleting a body mid-flight removes it from the live state', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    sim.seek(10 * DAY);

    sim.applyBodyEdits(sim.bodies.filter((b) => b.id !== 'moon'));
    expect(sim.aliveIds).toEqual(['sun', 'earth']);
    expect(sim.state.n).toBe(2);
  });

  it('editing at t = 0 rebuilds from the roster', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600 });
    const moved = sim.bodies.map((b) =>
      b.id === 'earth' ? { ...b, position: vec3(2 * EARTH_ORBIT, 0, 0) } : b
    );
    sim.applyBodyEdits(moved);

    expect(sim.time).toBe(0);
    expect(sim.state.pos[3]).toBe(2 * EARTH_ORBIT);
  });
});

describe('orbital sanity', () => {
  it('Earth returns to its start after one year', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });
    const start = { x: sim.state.pos[3], y: sim.state.pos[4] };

    sim.advanceTo(YEAR, Infinity);

    const end = { x: sim.state.pos[3], y: sim.state.pos[4] };
    const drift = Math.hypot(end.x - start.x, end.y - start.y);
    // Within 1% of the orbit radius after a full revolution.
    expect(drift / EARTH_ORBIT).toBeLessThan(0.01);
  });

  it('the Moon stays bound to Earth over a year', () => {
    const sim = new Simulation(sunEarthMoon(), { dt: 600, snapshotInterval: DAY });

    for (let day = 10; day <= 365; day += 10) {
      sim.advanceTo(day * DAY, Infinity);
      const separation = Math.hypot(
        sim.state.pos[6] - sim.state.pos[3],
        sim.state.pos[7] - sim.state.pos[4],
        sim.state.pos[8] - sim.state.pos[5]
      );
      // Circular start ⇒ separation should stay near MOON_ORBIT throughout.
      expect(separation).toBeGreaterThan(0.9 * MOON_ORBIT);
      expect(separation).toBeLessThan(1.1 * MOON_ORBIT);
    }
  });
});

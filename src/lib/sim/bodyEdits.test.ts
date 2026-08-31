// The correctness crux: creating a body from orbital elements must
// produce the orbit the UI previewed, and editing a body must invalidate the
// future without disturbing the past.
//
// These exercise `Simulation` directly rather than through the Svelte state
// module: the rune modules need a component context, and the behavior under
// test is the sim's, not the wrapper's.

import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import { circularOrbit, elementsToStateVector, orbitalPeriod } from '../physics/kepler';
import { AU, DAY, EARTH_MASS, SUN_MASS, YEAR } from '../physics/constants';
import { AT_ORIGIN, testBody } from '../physics/testUtils';
import type { Body } from '../types';

function sunAndEarth(): Body[] {
  const earth = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, 0, EARTH_MASS);
  return [
    testBody({ mass: SUN_MASS, radius: 6.957e8, name: 'Sun', type: 'star' }),
    testBody({ mass: EARTH_MASS, radius: 6.371e6, name: 'Earth', ...earth }),
  ];
}

/**
 * Measure a body's orbital period in-sim by watching its angle about the
 * parent and detecting the wrap back past the starting angle.
 */
function measurePeriod(sim: Simulation, id: string, parentId: string, maxTime: number): number {
  const angleNow = () => {
    const p = sim.positionOf(id)!;
    const c = sim.positionOf(parentId)!;
    return Math.atan2(p.y - c.y, p.x - c.x);
  };

  const start = angleNow();
  let previous = start;
  let unwrapped = 0;

  const stepSize = DAY;
  for (let t = sim.time + stepSize; t <= maxTime; t += stepSize) {
    sim.advanceTo(t, Infinity);
    const a = angleNow();

    let delta = a - previous;
    // Unwrap across the ±π seam so the total swept angle grows monotonically.
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    unwrapped += delta;
    previous = a;

    if (Math.abs(unwrapped) >= 2 * Math.PI) {
      // Linear interpolation inside the last day for sub-step resolution.
      const overshoot = (Math.abs(unwrapped) - 2 * Math.PI) / Math.abs(delta);
      return sim.time - overshoot * stepSize;
    }
  }
  return NaN;
}

describe('creating a body from orbital elements', () => {
  it('produces the period the dialog previews, within 1%', () => {
    // Exactly what the create dialog does: Kepler's third law for the preview,
    // elements → state vector for the actual placement.
    const distance = 1.5 * AU;
    const previewed = orbitalPeriod(distance, SUN_MASS, EARTH_MASS);

    const placed = elementsToStateVector(
      SUN_MASS,
      AT_ORIGIN,
      { a: distance, e: 0, i: 0, lan: 0, argPeriapsis: 0, trueAnomaly: 0 },
      EARTH_MASS
    );

    const bodies = [
      testBody({ mass: SUN_MASS, radius: 6.957e8, name: 'Star', type: 'star' }),
      testBody({ mass: EARTH_MASS, radius: 6.371e6, name: 'New', ...placed }),
    ];

    const sim = new Simulation(bodies);
    const measured = measurePeriod(sim, bodies[1].id, bodies[0].id, 4 * YEAR);

    expect(measured).toBeGreaterThan(0);
    expect(Math.abs(measured - previewed) / previewed).toBeLessThan(0.01);
  });

  it('places an eccentric orbit at its periapsis when phase is 0', () => {
    const a = 2 * AU;
    const e = 0.5;
    const placed = elementsToStateVector(
      SUN_MASS,
      AT_ORIGIN,
      { a, e, i: 0, lan: 0, argPeriapsis: 0, trueAnomaly: 0 },
      0
    );
    const r = Math.hypot(placed.position.x, placed.position.y, placed.position.z);
    expect(r).toBeCloseTo(a * (1 - e), -3);
  });
});

describe('applyBodyEdits', () => {
  it('truncates the computed range at the current time', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);

    // `advanceTo` is bounded by the per-frame step budget, so reaching a
    // distant time takes an explicit unbounded seek.
    sim.seek(300 * DAY, Infinity);
    const computedBefore = sim.computedUntil;
    expect(computedBefore).toBeCloseTo(300 * DAY, 6);

    sim.seek(100 * DAY, Infinity);
    expect(sim.computedUntil).toBeCloseTo(computedBefore, 6); // seeking alone keeps it

    const roster = bodies.map((b) => ({ ...b }));
    roster[1] = { ...roster[1], mass: EARTH_MASS * 10 };
    sim.applyBodyEdits(roster);

    // The edit is what discards the future: the computed range collapses to
    // the edit instant and must be recomputed from there.
    expect(sim.time).toBeCloseTo(100 * DAY, 6);
    expect(sim.computedUntil).toBeCloseTo(sim.time, 6);
    expect(sim.computedUntil).toBeLessThan(computedBefore);
  });

  it('keeps bodies where they are and changes only what follows', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.advanceTo(100 * DAY);

    const before = sim.positionOf(bodies[1].id)!;

    const roster = bodies.map((b) => ({ ...b }));
    roster[1] = { ...roster[1], mass: EARTH_MASS * 300 };
    sim.applyBodyEdits(roster);

    // The edit is not a teleport: position at the edit instant is untouched.
    const after = sim.positionOf(bodies[1].id)!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
  });

  it('re-simulates the future with the new mass', () => {
    // A heavier planet pulls the Sun harder, so the *Sun's* displacement at a
    // later time reads directly on whether the new mass took effect.
    //
    // The comparison is against a control edit that changes nothing, not a
    // fixed number: re-applying the roster mid-flight re-snapshots and
    // re-integrates, which perturbs the trajectory slightly on its own. The
    // control measures that floor (~2e5 m here) so the assertion is about the
    // mass, not about round-off.
    const sunDriftAfterEdit = (massFactor: number) => {
      const bodies = sunAndEarth();

      const baseline = new Simulation(bodies);
      baseline.advanceTo(400 * DAY);
      const sunBaseline = baseline.positionOf(bodies[0].id)!;

      const edited = new Simulation(bodies);
      edited.advanceTo(100 * DAY);
      const roster = bodies.map((b) => ({ ...b }));
      roster[1] = { ...roster[1], mass: EARTH_MASS * massFactor };
      edited.applyBodyEdits(roster);
      edited.advanceTo(400 * DAY);
      const sunEdited = edited.positionOf(bodies[0].id)!;

      return Math.hypot(
        sunEdited.x - sunBaseline.x,
        sunEdited.y - sunBaseline.y,
        sunEdited.z - sunBaseline.z
      );
    };

    const control = sunDriftAfterEdit(1);
    const heavier = sunDriftAfterEdit(300);

    expect(heavier).toBeGreaterThan(control * 20);
  });

  it('leaves the past reproducible after an edit', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);

    sim.seek(50 * DAY);
    const pastBefore = sim.positionOf(bodies[1].id)!;

    sim.advanceTo(150 * DAY);
    const roster = bodies.map((b) => ({ ...b }));
    roster[1] = { ...roster[1], mass: EARTH_MASS * 50 };
    sim.applyBodyEdits(roster);

    // Scrubbing back before the edit must restore the original trajectory:
    // snapshots before the edit time were never invalidated.
    sim.seek(50 * DAY);
    const pastAfter = sim.positionOf(bodies[1].id)!;

    expect(pastAfter.x).toBeCloseTo(pastBefore.x, 6);
    expect(pastAfter.y).toBeCloseTo(pastBefore.y, 6);
    expect(pastAfter.z).toBeCloseTo(pastBefore.z, 6);
  });

  it('adds a body mid-timeline without disturbing the others', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.advanceTo(100 * DAY);

    const earthBefore = sim.positionOf(bodies[1].id)!;

    const placed = circularOrbit(SUN_MASS, AT_ORIGIN, 5 * AU, 0, 0, EARTH_MASS);
    const added = testBody({ mass: EARTH_MASS, radius: 6.371e6, name: 'Added', ...placed });
    sim.applyBodyEdits([...bodies, added]);

    expect(sim.aliveIds).toContain(added.id);

    // The new body enters at the state it was created with...
    const addedPos = sim.positionOf(added.id)!;
    expect(addedPos.x).toBeCloseTo(placed.position.x, 6);

    // ...and the existing bodies stay exactly where they were.
    const earthAfter = sim.positionOf(bodies[1].id)!;
    expect(earthAfter.x).toBeCloseTo(earthBefore.x, 6);
    expect(earthAfter.y).toBeCloseTo(earthBefore.y, 6);
  });

  it('removes a deleted body from the live state', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.advanceTo(100 * DAY);

    sim.applyBodyEdits([bodies[0]]);

    expect(sim.aliveIds).not.toContain(bodies[1].id);
    expect(sim.positionOf(bodies[1].id)).toBeNull();
  });

  it('takes an edited state vector verbatim when marked authoritative', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.advanceTo(100 * DAY);

    const sunBefore = sim.positionOf(bodies[0].id)!;

    // A drag: same roster shape, new position/velocity for one body, flagged.
    const roster = bodies.map((b) => ({ ...b }));
    const moved = circularOrbit(SUN_MASS, AT_ORIGIN, 2 * AU, 0, 90, EARTH_MASS);
    roster[1] = { ...roster[1], position: moved.position, velocity: moved.velocity };
    sim.applyBodyEdits(roster, new Set([roster[1].id]));

    // The flagged body lands exactly where the edit put it...
    const earth = sim.positionOf(bodies[1].id)!;
    expect(earth.x).toBeCloseTo(moved.position.x, 6);
    expect(earth.y).toBeCloseTo(moved.position.y, 6);

    // ...while the unflagged Sun keeps its live state instead of teleporting
    // back to the roster's t = 0 coordinates.
    const sunAfter = sim.positionOf(bodies[0].id)!;
    expect(sunAfter.x).toBeCloseTo(sunBefore.x, 6);
    expect(sunAfter.y).toBeCloseTo(sunBefore.y, 6);
  });

  it('keeps drag churn deterministic: past intact, endpoint reproducible', () => {
    // A drag is dozens of authoritative edits while paused at one instant.
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);

    sim.seek(50 * DAY, Infinity);
    const past = sim.positionOf(bodies[1].id)!;

    sim.seek(100 * DAY, Infinity);
    let final = { x: 0, y: 0, z: 0 };
    for (let step = 1; step <= 40; step++) {
      const roster = bodies.map((b) => ({ ...b }));
      const target = circularOrbit(SUN_MASS, AT_ORIGIN, (1 + step / 40) * AU, 0, step, EARTH_MASS);
      roster[1] = { ...roster[1], position: target.position, velocity: target.velocity };
      sim.applyBodyEdits(roster, new Set([roster[1].id]));
      final = target.position;
    }

    expect(sim.time).toBeCloseTo(100 * DAY, 6);
    expect(sim.positionOf(bodies[1].id)!.x).toBeCloseTo(final.x, 6);

    // Playing on and scrubbing back to the drag instant restores the final
    // dragged state, not any intermediate commit: each commit re-snapshots
    // the instant, and the last one wins.
    sim.advanceTo(160 * DAY, Infinity);
    sim.seek(100 * DAY, Infinity);
    const endpoint = sim.positionOf(bodies[1].id)!;
    expect(endpoint.x).toBeCloseTo(final.x, 6);
    expect(endpoint.y).toBeCloseTo(final.y, 6);

    // The pre-drag past is untouched by any amount of churn at day 100.
    sim.seek(50 * DAY, Infinity);
    const pastAfter = sim.positionOf(bodies[1].id)!;
    expect(pastAfter.x).toBeCloseTo(past.x, 6);
    expect(pastAfter.y).toBeCloseTo(past.y, 6);
  });

  it('replays an added body when playing forward across its creation time', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.seek(100 * DAY, Infinity);

    const placed = circularOrbit(SUN_MASS, AT_ORIGIN, 5 * AU, 0, 0, EARTH_MASS);
    const added = testBody({ mass: EARTH_MASS, radius: 6.371e6, name: 'Added', ...placed });
    sim.applyBodyEdits([...bodies, added]);
    sim.advanceTo(160 * DAY, Infinity);
    const addedAt160 = sim.positionOf(added.id)!;

    // Rewind to before the creation: the body must be absent, and its birth
    // visible on the timeline ahead.
    sim.seek(0, Infinity);
    expect(sim.aliveIds).not.toContain(added.id);
    expect(sim.appearsAt(added.id)).toBeCloseTo(100 * DAY, 6);

    // Playing forward across day 100 re-introduces it — this used to require
    // scrubbing backward until a post-edit snapshot happened to restore it.
    sim.advanceTo(50 * DAY, Infinity);
    expect(sim.aliveIds).not.toContain(added.id);
    sim.advanceTo(160 * DAY, Infinity);
    expect(sim.aliveIds).toContain(added.id);
    expect(sim.appearsAt(added.id)).toBeNull();

    // Bit-for-bit the trajectory the first pass computed.
    const replayed = sim.positionOf(added.id)!;
    expect(replayed.x).toBe(addedAt160.x);
    expect(replayed.y).toBe(addedAt160.y);
    expect(replayed.z).toBe(addedAt160.z);
  });

  it('replays a property edit when playing forward across it', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.seek(100 * DAY, Infinity);

    const roster = bodies.map((b) => ({ ...b }));
    roster[1] = { ...roster[1], mass: EARTH_MASS * 300 };
    sim.applyBodyEdits(roster);
    sim.advanceTo(200 * DAY, Infinity);
    const sunAfterEdit = sim.positionOf(bodies[0].id)!;

    sim.seek(0, Infinity);
    expect(sim.state.mass[1]).toBeCloseTo(EARTH_MASS, 6);

    sim.advanceTo(200 * DAY, Infinity);
    expect(sim.state.mass[sim.aliveIds.indexOf(bodies[1].id)]).toBeCloseTo(EARTH_MASS * 300, 6);
    const sunReplayed = sim.positionOf(bodies[0].id)!;
    expect(sunReplayed.x).toBe(sunAfterEdit.x);
    expect(sunReplayed.y).toBe(sunAfterEdit.y);
  });

  it('replays a deletion when playing forward across it', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.seek(100 * DAY, Infinity);

    sim.applyBodyEdits([bodies[0]]);

    sim.seek(0, Infinity);
    expect(sim.aliveIds).toContain(bodies[1].id);

    sim.advanceTo(160 * DAY, Infinity);
    expect(sim.aliveIds).not.toContain(bodies[1].id);
  });

  it('keeps a deleted body renderable in its past', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.seek(100 * DAY, Infinity);

    sim.applyBodyEdits([bodies[0]]);

    // The metadata survives (the scene draws from the roster), the save filter
    // knows it's gone, and the record dates the removal.
    expect(sim.bodies.map((b) => b.id)).toContain(bodies[1].id);
    expect(sim.staleBodyIds.has(bodies[1].id)).toBe(true);
    expect(sim.deletedAt(bodies[1].id)).toBeCloseTo(100 * DAY, 6);

    // Before the deletion it is simply alive — and not reported deleted.
    sim.seek(50 * DAY, Infinity);
    expect(sim.aliveIds).toContain(bodies[1].id);
    expect(sim.deletedAt(bodies[1].id)).toBeNull();
  });

  it('keeps a deleted body dead through unrelated later edits', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.seek(100 * DAY, Infinity);

    sim.applyBodyEdits([bodies[0]]);
    sim.advanceTo(160 * DAY, Infinity);

    // The state layer's edit rosters exclude dead bodies, so an unrelated edit
    // arrives without the deleted one — it must not resurrect.
    const sun = { ...bodies[0], mass: SUN_MASS * 1.1 };
    sim.applyBodyEdits([sun]);
    expect(sim.aliveIds).not.toContain(bodies[1].id);
    expect(sim.staleBodyIds.has(bodies[1].id)).toBe(true);
  });

  it('revives a deleted body handed back state-authoritative (undo)', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.seek(100 * DAY, Infinity);

    const preDelete = bodies.map((b) => ({ ...b }));
    sim.applyBodyEdits([bodies[0]]);
    sim.advanceTo(160 * DAY, Infinity);

    // What restoreRoster does: the recorded pre-delete roster, every body
    // state-authoritative.
    sim.applyBodyEdits(preDelete, new Set(preDelete.map((b) => b.id)));
    expect(sim.aliveIds).toContain(bodies[1].id);
    expect(sim.staleBodyIds.has(bodies[1].id)).toBe(false);
    const revived = sim.positionOf(bodies[1].id)!;
    expect(revived.x).toBeCloseTo(preDelete[1].position.x, 6);

    // The timeline keeps the gap: absent between deletion and revival, back
    // after it, on both scrub and forward replay.
    sim.seek(130 * DAY, Infinity);
    expect(sim.aliveIds).not.toContain(bodies[1].id);
    sim.advanceTo(200 * DAY, Infinity);
    expect(sim.aliveIds).toContain(bodies[1].id);

    // And once revived, later edits leave it alone.
    sim.applyBodyEdits([{ ...bodies[0], mass: SUN_MASS * 1.1 }, preDelete[1]]);
    expect(sim.aliveIds).toContain(bodies[1].id);
  });

  it('drops a deletion when an edit before it invalidates the future', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.seek(100 * DAY, Infinity);

    sim.applyBodyEdits([bodies[0]]);

    sim.seek(50 * DAY, Infinity);
    sim.applyBodyEdits(bodies.map((b) => ({ ...b, mass: b.mass * 1.01 })));

    sim.advanceTo(160 * DAY, Infinity);
    expect(sim.aliveIds).toContain(bodies[1].id);
    expect(sim.deletedAt(bodies[1].id)).toBeNull();
  });

  it('drops a recorded edit when an earlier edit invalidates it', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    sim.seek(100 * DAY, Infinity);

    const placed = circularOrbit(SUN_MASS, AT_ORIGIN, 5 * AU, 0, 0, EARTH_MASS);
    const added = testBody({ mass: EARTH_MASS, radius: 6.371e6, name: 'Added', ...placed });
    sim.applyBodyEdits([...bodies, added]);

    // An edit at day 50 rewrites the timeline from there; the day-100 record
    // now describes an invalidated future. The added body enters at day 50
    // instead — edits apply the whole roster at the current time.
    sim.seek(50 * DAY, Infinity);
    const roster = [...bodies, added].map((b) => ({ ...b }));
    roster[0] = { ...roster[0], mass: SUN_MASS * 1.1 };
    sim.applyBodyEdits(roster);

    expect(sim.appearsAt(added.id)).toBeNull();
    expect(sim.aliveIds).toContain(added.id);
  });

  it('rebuilds from the roster when edited at t = 0', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);

    const roster = bodies.map((b) => ({ ...b }));
    roster[1] = { ...roster[1], mass: EARTH_MASS * 2 };
    sim.applyBodyEdits(roster);

    expect(sim.time).toBe(0);
    expect(sim.state.mass[1]).toBeCloseTo(EARTH_MASS * 2, 6);
  });

  // `lastEditTime` is what the save/share UI warns off: a nonzero value means
  // the roster was rebased mid-timeline and a written file starts there, not
  // at the original day 0.
  it('reports the last edit time the roster was rebased onto', () => {
    const bodies = sunAndEarth();
    const sim = new Simulation(bodies);
    expect(sim.lastEditTime).toBe(0);

    sim.seek(100 * DAY, Infinity);
    const roster = bodies.map((b) => ({ ...b }));
    roster[1] = { ...roster[1], mass: EARTH_MASS * 2 };
    sim.applyBodyEdits(roster);
    expect(sim.lastEditTime).toBe(sim.time);

    // An earlier edit invalidates the day-100 record; the flatten point moves
    // back with it.
    sim.seek(50 * DAY, Infinity);
    sim.applyBodyEdits(roster.map((b) => ({ ...b })));
    expect(sim.lastEditTime).toBe(50 * DAY);

    // An edit at t = 0 rebuilds from scratch — the file is true initial
    // conditions again and no warning is due.
    sim.seek(0, Infinity);
    sim.applyBodyEdits(roster.map((b) => ({ ...b })));
    expect(sim.lastEditTime).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ARTEMIS_II_FLOWN_ALTITUDE,
  ARTEMIS_II_PROFILE,
  ARTEMIS_II_TIMING,
  artemisII,
} from './artemisII';
import { DAY, MOON_ORBIT, MOON_RADIUS } from '../physics/constants';
import { Simulation } from '../sim/simulation';
import type { Body } from '../types';

/** Fractional difference, so tolerances read as percentages of the figure. */
function relative(actual: number, expected: number): number {
  return Math.abs(actual - expected) / expected;
}

/**
 * Fly the preset and record the encounter geometry.
 *
 * This runs at the preset's own `dt`, deliberately: the trajectory is tuned to
 * the timestep the preset ships (`ARTEMIS_II_TIMING`), and a test at any other
 * dt would pass for trajectories the app then flies differently.
 */
function flight(bodies: Body[], span: number) {
  const dt = ARTEMIS_II_TIMING.dt;
  const sim = new Simulation(bodies, { dt, snapshotInterval: 5 * DAY });
  const probe = bodies.find((b) => b.name === 'Orion')!;
  const earth = bodies.find((b) => b.name === 'Earth')!;
  const moon = bodies.find((b) => b.name === 'Moon')!;

  let flybyDistance = Infinity;
  let flybyTime = 0;
  let maxEarthDistance = 0;

  // Per-step sampling only while the probe flies; once the entry merge takes
  // it, the rest of the span integrates in one call — nothing left to sample.
  const steps = Math.floor(span / dt);
  for (let n = 1; n <= steps; n++) {
    sim.advanceTo(n * dt, Infinity);

    const p = sim.positionOf(probe.id);
    const e = sim.positionOf(earth.id);
    const m = sim.positionOf(moon.id);
    if (!p || !e || !m) break;

    const dEarth = Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z);
    const dMoon = Math.hypot(p.x - m.x, p.y - m.y, p.z - m.z);

    if (dMoon < flybyDistance) {
      flybyDistance = dMoon;
      flybyTime = sim.time;
    }
    if (dEarth > maxEarthDistance) maxEarthDistance = dEarth;
  }
  sim.advanceTo(span, Infinity);

  const entry = sim.merges.find(
    (m) => m.absorbedName === 'Orion' && m.survivorName === 'Earth'
  );
  return { flybyDistance, flybyTime, maxEarthDistance, entryTime: entry?.t ?? null, sim };
}

describe('Artemis II', () => {
  const bodies = artemisII();

  it('is the Sun, Earth, Moon and one probe', () => {
    expect(bodies.map((b) => b.name)).toEqual(['Sun', 'Earth', 'Moon', 'Orion']);
    expect(bodies.filter((b) => b.type === 'satellite')).toHaveLength(1);
  });

  it('has zero net momentum, so the system does not drift', () => {
    let px = 0;
    let py = 0;
    let pz = 0;
    let mass = 0;
    for (const b of bodies) {
      px += b.mass * b.velocity.x;
      py += b.mass * b.velocity.y;
      pz += b.mass * b.velocity.z;
      mass += b.mass;
    }
    expect(Math.hypot(px, py, pz) / mass).toBeLessThan(1e-3);
  });

  // The claim the preset's name makes. Everything else here checks the sim is
  // self-consistent; this checks it against the mission that actually flew.
  it('matches the pericynthion altitude Artemis II flew, to within 1%', () => {
    const f = flight(artemisII(), 10 * DAY);
    const altitude = f.flybyDistance - MOON_RADIUS;

    expect(relative(altitude, ARTEMIS_II_FLOWN_ALTITUDE)).toBeLessThan(0.01);
  });

  it('flies past the Moon and comes home to entry on the encounter alone', () => {
    const f = flight(artemisII(), 10 * DAY);

    // Close enough to be a flyby, far enough not to be a crash.
    expect(f.flybyDistance).toBeGreaterThan(MOON_RADIUS);
    expect(f.flybyDistance).toBeLessThan(0.1 * MOON_ORBIT);
    // Within 2% of the profile the doc comment quotes — tight enough that
    // retuning the preset without updating the figures fails here.
    expect(relative(f.flybyDistance, ARTEMIS_II_PROFILE.flybyDistance)).toBeLessThan(0.02);
    expect(relative(f.flybyTime, ARTEMIS_II_PROFILE.flybyTime)).toBeLessThan(0.02);

    // The re-entry: the probe merges with Earth — after the flyby, on the
    // encounter's own terms. That's what makes the return *free*.
    expect(f.entryTime).not.toBeNull();
    expect(f.entryTime!).toBeGreaterThan(f.flybyTime);
    expect(relative(f.entryTime!, ARTEMIS_II_PROFILE.entryTime)).toBeLessThan(0.02);
  });

  it('actually uses the Moon — without it the probe never comes down', () => {
    // Same probe, Moon deleted. The 200 km starting perigee is above the
    // surface, so an unperturbed ellipse never touches Earth: the flyby is
    // what turns the probe around *and* drops its perigee into the ground.
    const withoutMoon = artemisII().filter((b) => b.name !== 'Moon');
    const sim = new Simulation(withoutMoon, {
      dt: ARTEMIS_II_TIMING.dt,
      snapshotInterval: 5 * DAY,
    });
    sim.advanceTo(20 * DAY, Infinity);
    expect(sim.merges).toHaveLength(0);

    // Whereas the full preset ends in exactly one merge: Orion into Earth.
    const f = flight(artemisII(), 10 * DAY);
    expect(f.entryTime).not.toBeNull();
    expect(f.sim.merges).toHaveLength(1);
  });

  // A close flyby is exactly where a fixed-dt integrator is most likely to leak
  // energy, so this guards the whole preset: a probe that lost the encounter to
  // integration error escapes to millions of km instead of coming home. It also
  // pins the mission's outer bound against the flown record (406,771 km), and
  // checks the leftover Earth–Moon system stays quiet for the year after.
  it('never strays past the flown record by more than 2%, then leaves a quiet Earth–Moon system', () => {
    const roster = artemisII();
    const f = flight(roster, 365 * DAY);

    expect(f.maxEarthDistance).toBeLessThan(1.02 * 4.06771e8);
    // The entry at day 8 is the only merge a year holds.
    expect(f.sim.merges).toHaveLength(1);
    // The Moon is still on its orbit, not scattered by anything numerical.
    const moon = roster.find((b) => b.name === 'Moon')!;
    expect(f.sim.positionOf(moon.id)).not.toBeNull();
  });

  // The preset re-places the Moon along its orbit, so its lock is re-aimed
  // *and* re-paced: the integrated mean month depends on the t = 0 phase
  // against the Sun, and at MOON_PHASE it is 27.7835 d — 2.6% off the roster
  // Moon's. This pins both numbers: with the roster period kept, the near
  // side drifts tens of degrees a year and blows through this bound.
  it('keeps the Moon’s tidally locked near side facing Earth for two years', () => {
    const fresh = artemisII();
    const earth = fresh.find((b) => b.name === 'Earth')!;
    const moon = fresh.find((b) => b.name === 'Moon')!;
    const sim = new Simulation(fresh, {
      dt: ARTEMIS_II_TIMING.dt,
      snapshotInterval: 5 * DAY,
    });

    let worst = 0;
    for (let d = 1; d <= 2 * 365; d++) {
      sim.advanceTo(d * DAY, Infinity);
      const e = sim.positionOf(earth.id)!;
      const m = sim.positionOf(moon.id)!;
      const azimuth = (Math.atan2(e.y - m.y, e.x - m.x) * 180) / Math.PI;
      const facing = (moon.rotationPhase ?? 0) + (360 * sim.time) / moon.rotationPeriod;
      const err = Math.abs((((azimuth - facing) % 360) + 540) % 360 - 180);
      worst = Math.max(worst, err);
    }

    // The remainder is bounded optical libration; measured worst is 12.4°.
    expect(worst).toBeLessThan(16);
  });

  it('builds a fresh roster each call', () => {
    expect(artemisII()[0].id).not.toBe(artemisII()[0].id);
  });
});

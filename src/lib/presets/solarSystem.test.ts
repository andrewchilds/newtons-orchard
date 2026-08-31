import { describe, expect, it } from 'vitest';
import { KNOWN_PERIODS, solarSystem } from './solarSystem';
import { stateVectorToElements, orbitalPeriod } from '../physics/kepler';
import { AU, DAY, MOON_ORBIT, SUN_MASS } from '../physics/constants';
import { Simulation } from '../sim/simulation';
import type { Body } from '../types';

const bodies = solarSystem();
const byName = (name: string): Body => {
  const b = bodies.find((x) => x.name === name);
  if (!b) throw new Error(`no body named ${name}`);
  return b;
};

/**
 * Reference for recovering heliocentric elements: the Sun's position, but at
 * rest.
 *
 * The preset gives the Sun a recoil velocity so the barycenter doesn't drift,
 * which is physically right but means elements measured against the *moving*
 * Sun aren't the heliocentric ones the J2000 table quotes. The difference is
 * small in absolute terms and large in relative ones for a near-circular orbit:
 * Earth's eccentricity reads 0.01711 against the moving Sun versus its input
 * 0.016711, a 2.4% shift, and Neptune's shifts by a third. Measured from a
 * stationary Sun every planet recovers its tabulated elements exactly, which is
 * what these tests check — that the elements → state conversion is faithful.
 */
const heliocentric = () => ({ position: byName('Sun').position, velocity: { x: 0, y: 0, z: 0 } });

describe('solar system preset', () => {
  it('has the Sun, eight planets, the Moon and five dwarf planets', () => {
    expect(bodies.map((b) => b.name)).toEqual([
      'Sun',
      'Mercury',
      'Venus',
      'Earth',
      'Mars',
      'Ceres',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
      'Pluto',
      'Haumea',
      'Makemake',
      'Eris',
      'Moon',
    ]);
    expect(bodies.filter((b) => b.type === 'star')).toHaveLength(1);
    expect(bodies.filter((b) => b.type === 'dwarf').map((b) => b.name)).toEqual([
      'Ceres',
      'Pluto',
      'Haumea',
      'Makemake',
      'Eris',
    ]);
  });

  it('gives every body a unique id', () => {
    expect(new Set(bodies.map((b) => b.id)).size).toBe(bodies.length);
  });

  it('gives the planets, the Moon and Ceres photographic maps, and nothing else', () => {
    const textured = new Map(bodies.filter((b) => b.texture).map((b) => [b.name, b.texture]));
    expect(textured).toEqual(
      new Map([
        ['Mercury', 'mercury'],
        ['Venus', 'venus'],
        ['Earth', 'earth'],
        ['Mars', 'mars'],
        ['Ceres', 'ceres'],
        ['Jupiter', 'jupiter'],
        ['Saturn', 'saturn'],
        ['Uranus', 'uranus'],
        ['Neptune', 'neptune'],
        ['Moon', 'moon'],
      ])
    );
  });

  // The headline check: elements → state → elements must reproduce each
  // planet's real period. This catches a wrong semi-major axis or a bungled μ,
  // either of which leaves the orbit looking fine but running at the wrong rate.
  it('reproduces each planet’s sidereal period within 2%', () => {
    const sunState = heliocentric();

    for (const [name, expected] of Object.entries(KNOWN_PERIODS)) {
      const body = byName(name);
      const elements = stateVectorToElements(
        SUN_MASS,
        sunState,
        { position: body.position, velocity: body.velocity },
        body.mass
      );
      const period = orbitalPeriod(elements.a, SUN_MASS, body.mass);
      expect(Math.abs(period - expected) / expected).toBeLessThan(0.02);
    }
  });

  it('reproduces each planet’s eccentricity and inclination', () => {
    const sunState = heliocentric();

    // Every planet, since a wrong element in any one of them is a wrong orbit.
    // These are the J2000 table values the preset was built from, so recovery
    // should be near-exact — the loose 1e-4 is for the perifocal round trip,
    // not for physical approximation.
    const expectations: [string, number, number][] = [
      ['Mercury', 0.20563593, 7.00497902],
      ['Venus', 0.00677672, 3.39467605],
      ['Earth', 0.01671123, 0],
      ['Mars', 0.0933941, 1.84969142],
      ['Jupiter', 0.04838624, 1.30439695],
      ['Saturn', 0.05386179, 2.48599187],
      ['Uranus', 0.04725744, 0.77263783],
      ['Neptune', 0.00859048, 1.77004347],
      ['Pluto', 0.2488273, 17.14001206],
      ['Ceres', 0.078, 10.5867],
      ['Haumea', 0.19489, 28.2137],
      ['Makemake', 0.16126, 28.9835],
      ['Eris', 0.43607, 44.0402],
    ];

    for (const [name, e, i] of expectations) {
      const body = byName(name);
      const elements = stateVectorToElements(
        SUN_MASS,
        sunState,
        { position: body.position, velocity: body.velocity },
        body.mass
      );
      expect(elements.e).toBeCloseTo(e, 4);
      expect(elements.i).toBeCloseTo(i, 3);
    }
  });

  it('places the Moon near Earth, not near the Sun', () => {
    const earth = byName('Earth');
    const moon = byName('Moon');
    const separation = Math.hypot(
      moon.position.x - earth.position.x,
      moon.position.y - earth.position.y,
      moon.position.z - earth.position.z
    );

    // Between perigee and apogee of the real lunar orbit.
    expect(separation).toBeGreaterThan(0.9 * MOON_ORBIT);
    expect(separation).toBeLessThan(1.1 * MOON_ORBIT);
  });

  it('gives the Moon a ~27.3 day period around Earth', () => {
    const earth = byName('Earth');
    const moon = byName('Moon');
    const elements = stateVectorToElements(
      earth.mass,
      { position: earth.position, velocity: earth.velocity },
      { position: moon.position, velocity: moon.velocity },
      moon.mass
    );
    const period = orbitalPeriod(elements.a, earth.mass, moon.mass);
    expect(Math.abs(period - 27.32 * DAY) / (27.32 * DAY)).toBeLessThan(0.02);
  });

  // The lock is a pace as well as an aim: `rotationPeriod` must equal the mean
  // month the integrator actually produces, which the catalog sidereal month
  // does not — it drifted the near side around Earth at ~44°/yr. Five years is
  // decisive: that drift accumulates ~220° while libration stays under ~13.2°.
  it('keeps the Moon’s tidally locked near side facing Earth for five years', () => {
    const earth = byName('Earth');
    const moon = byName('Moon');
    const sim = new Simulation(bodies);

    let worst = 0;
    for (let d = 1; d <= 5 * 365; d++) {
      sim.advanceTo(d * DAY, Infinity);
      const e = sim.positionOf(earth.id)!;
      const m = sim.positionOf(moon.id)!;
      // Moon→Earth azimuth vs the spin angle the scene draws
      // (`applyOrientation`: phase + simTime/rotationPeriod), wrapped to
      // [-180°, 180°].
      const azimuth = (Math.atan2(e.y - m.y, e.x - m.x) * 180) / Math.PI;
      const facing = (moon.rotationPhase ?? 0) + (360 * sim.time) / moon.rotationPeriod;
      const err = Math.abs((((azimuth - facing) % 360) + 540) % 360 - 180);
      worst = Math.max(worst, err);
    }

    // What remains is optical libration, which is physical and bounded: ±2e ≈
    // ±6.3° from eccentricity plus solar-perturbation terms, offset by the
    // t = 0 aim landing off libration center. Measured worst is 13.2° and
    // doesn't grow between five and ten years.
    expect(worst).toBeLessThan(16);
  });

  // Without balancing, the planets' momentum (Jupiter alone is ~2e29 kg·m/s)
  // has no counterweight and the entire system translates out of frame.
  it('has zero net momentum, so the barycenter does not drift', () => {
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

    // Expressed as the barycenter's drift speed, which is the thing that
    // actually matters: under a millimeter per second.
    expect(Math.hypot(px, py, pz) / mass).toBeLessThan(1e-3);
  });

  it('gives the Sun a recoil velocity rather than leaving it at rest', () => {
    const sun = byName('Sun');
    const speed = Math.hypot(sun.velocity.x, sun.velocity.y, sun.velocity.z);
    // The real Sun moves ~10–15 m/s about the solar system barycenter,
    // dominated by Jupiter.
    expect(speed).toBeGreaterThan(1);
    expect(speed).toBeLessThan(50);
  });

  it('keeps the inner planets on their orbits over a simulated year', () => {
    const sim = new Simulation(bodies);
    const start = new Map(bodies.map((b) => [b.id, b.position]));

    sim.advanceTo(365.256 * DAY, Infinity);

    // After one Earth year, Earth should be back where it started. This is the
    // end-to-end check that the preset's state vectors and the integrator agree
    // — a self-consistent but wrong preset passes the element tests above and
    // fails here.
    const earth = byName('Earth');
    const now = sim.positionOf(earth.id);
    const then = start.get(earth.id)!;
    expect(now).not.toBeNull();

    const drift = Math.hypot(now!.x - then.x, now!.y - then.y, now!.z - then.z);
    expect(drift / AU).toBeLessThan(0.02);
  });

  it('does not merge any bodies during the first simulated year', () => {
    const sim = new Simulation(bodies);
    sim.advanceTo(365 * DAY, Infinity);
    expect(sim.merges).toHaveLength(0);
    expect(sim.aliveIds).toHaveLength(bodies.length);
  });
});

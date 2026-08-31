import { describe, expect, it } from 'vitest';
import {
  asteroidBelt,
  cometSwarm,
  planetesimalDisk,
  satelliteSwarm,
  SATELLITE_TIMING,
} from './swarms';
import { AU, DAY, EARTH_MASS, EARTH_RADIUS, G, SUN_MASS } from '../physics/constants';
import { stateVectorToElements } from '../physics/kepler';
import { dominantAttractor } from '../physics/orbitInfo';
import { Simulation } from '../sim/simulation';
import type { Body } from '../types';

function netMomentumSpeed(bodies: Body[]): number {
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
  return Math.hypot(px, py, pz) / mass;
}

/** Everything except the random id, for determinism comparisons. */
function fingerprint(bodies: Body[]) {
  return bodies.map(({ id: _id, ...rest }) => rest);
}

describe.each([
  ['asteroid belt', asteroidBelt],
  ['comet swarm', cometSwarm],
  ['planetesimal disk', planetesimalDisk],
  ['satellite swarm', satelliteSwarm],
])('%s', (_name, build) => {
  const bodies = build();

  it('stays within the ~100-body design target', () => {
    expect(bodies.length).toBeGreaterThan(20);
    expect(bodies.length).toBeLessThanOrEqual(100);
  });

  it('has zero net momentum', () => {
    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-3);
  });

  // Seeded PRNG: the same preset must build the same system every time, so
  // tests (including these) can assert against the output.
  it('builds deterministically, apart from ids', () => {
    expect(fingerprint(build())).toEqual(fingerprint(bodies));
    expect(build()[1].id).not.toBe(bodies[1].id);
  });
});

describe('asteroid belt', () => {
  const bodies = asteroidBelt();
  const sun = bodies.find((b) => b.name === 'Sun')!;

  it('keeps Mars and Jupiter as shepherds', () => {
    expect(bodies.some((b) => b.name === 'Mars')).toBe(true);
    expect(bodies.some((b) => b.name === 'Jupiter')).toBe(true);
  });

  it('puts every asteroid in the belt annulus', () => {
    const rocks = bodies.filter((b) => b.type === 'asteroid' || b.type === 'dwarf');
    expect(rocks.length).toBeGreaterThanOrEqual(80);
    for (const rock of rocks) {
      const r = Math.hypot(
        rock.position.x - sun.position.x,
        rock.position.y - sun.position.y,
        rock.position.z - sun.position.z
      );
      // Eccentricity ≤ ~0.23 around a 2.1–3.3 AU semi-major axis.
      expect(r / AU).toBeGreaterThan(1.6);
      expect(r / AU).toBeLessThan(4.2);
    }
  });
});

describe('comet swarm', () => {
  const bodies = cometSwarm();
  const sun = bodies[0];

  it('puts every comet on a bound, highly eccentric orbit', () => {
    const comets = bodies.filter((b) => b.type === 'ice');
    expect(comets.length).toBeGreaterThanOrEqual(20);
    for (const comet of comets) {
      const elements = stateVectorToElements(
        SUN_MASS,
        { position: sun.position, velocity: { x: 0, y: 0, z: 0 } },
        { position: comet.position, velocity: comet.velocity }
      );
      expect(elements.a).toBeGreaterThan(0); // bound
      expect(elements.e).toBeGreaterThan(0.6);
      expect(elements.e).toBeLessThan(0.96);
      // Periapsis inside the 4 AU tail-activity radius.
      expect((elements.a * (1 - elements.e)) / AU).toBeLessThan(1.5);
    }
  });
});

describe('satellite swarm', () => {
  const bodies = satelliteSwarm();
  const earth = bodies.find((b) => b.name === 'Earth')!;
  const satellites = bodies.filter((b) => b.type === 'satellite');

  it('puts every satellite on a bound orbit its own timing grids can resolve', () => {
    expect(satellites.length).toBe(41);
    for (const sat of satellites) {
      const elements = stateVectorToElements(
        EARTH_MASS,
        { position: earth.position, velocity: earth.velocity },
        { position: sat.position, velocity: sat.velocity }
      );
      // Bound to Earth, well inside its Hill sphere (~1.5e9 m).
      expect(elements.a).toBeGreaterThan(0);
      expect(elements.a).toBeLessThan(6e8);
      // Above the surface: these are real altitudes now, so nothing may be
      // inside the Earth. Perigee, not `a` — the Molniya loops are eccentric.
      expect(elements.a * (1 - elements.e)).toBeGreaterThan(EARTH_RADIUS);
      // The preset's own dt (60 s) has to give the fastest orbit here enough
      // steps to integrate. 50/orbit is the floor; LEO gets ~93.
      const period = 2 * Math.PI * Math.sqrt(elements.a ** 3 / (G * EARTH_MASS));
      expect(period / SATELLITE_TIMING.dt).toBeGreaterThan(50);
    }
  });

  it('flies the real spacecraft at their true altitudes and periods', () => {
    // The preset used to remap every semi-major axis onto a resolvable shell
    // because the app's single 600 s grid couldn't integrate LEO. Per-system
    // timing removed that compromise, so these are now checkable against the
    // real spacecraft — which is the point, and what makes a regression to the
    // scaled geometry fail loudly.
    //
    // Altitudes are mean (above a 6371 km spherical Earth) in km, periods in
    // minutes, both with enough slack for the eccentricity and for a body
    // being quoted at a slightly different epoch.
    const expected: Record<string, { altitude: number; period: number }> = {
      ISS: { altitude: 409, period: 92.6 },
      Hubble: { altitude: 483, period: 94.1 },
      Tiangong: { altitude: 390, period: 92.2 },
      'GPS III Vespucci': { altitude: 20190, period: 718 }, // 11.97 hr
      'Galileo Tara': { altitude: 23231, period: 845 }, // 14.08 hr
      'GOES-18': { altitude: 35793, period: 1436 }, // geostationary, 23.93 hr
      TESS: { altitude: 235629, period: 19747 }, // 13.7 days, 2:1 lunar resonance
    };

    for (const [name, want] of Object.entries(expected)) {
      const body = bodies.find((b) => b.name === name)!;
      const elements = stateVectorToElements(
        EARTH_MASS,
        { position: earth.position, velocity: earth.velocity },
        { position: body.position, velocity: body.velocity }
      );
      const altitude = (elements.a - EARTH_RADIUS) / 1000;
      expect(altitude, `${name} altitude`).toBeGreaterThan(want.altitude * 0.98);
      expect(altitude, `${name} altitude`).toBeLessThan(want.altitude * 1.02);

      const period = (2 * Math.PI * Math.sqrt(elements.a ** 3 / (G * EARTH_MASS))) / 60;
      expect(period, `${name} period`).toBeGreaterThan(want.period * 0.98);
      expect(period, `${name} period`).toBeLessThan(want.period * 1.02);
    }
  });

  it('reports orbital speed near the textbook figure for LEO', () => {
    // The number a satellite is normally quoted by is its speed *relative to
    // Earth* (~7.6 km/s in LEO). The inertial speed the readout's top line
    // shows is ~30 km/s larger, because Earth is carrying it around the Sun —
    // that difference is the one thing here most likely to read as a bug.
    const hubble = bodies.find((b) => b.name === 'Hubble')!;
    const relative = Math.hypot(
      hubble.velocity.x - earth.velocity.x,
      hubble.velocity.y - earth.velocity.y,
      hubble.velocity.z - earth.velocity.z
    );
    expect(relative).toBeGreaterThan(7400);
    expect(relative).toBeLessThan(7800);
  });

  it('includes the notable real spacecraft', () => {
    const names = [
      'ISS',
      'Hubble',
      'Tiangong',
      'Vanguard 1',
      'GPS III Vespucci',
      'GLONASS-K2',
      'BeiDou-3 M19',
      'Molniya 3-53',
      'Chandra',
      'TESS',
      'GOES-18',
    ];
    for (const name of names) {
      expect(bodies.some((b) => b.name === name)).toBe(true);
    }
  });

  it('gives the named spacecraft their real masses and orbit shapes', () => {
    const named = (name: string) => bodies.find((b) => b.name === name)!;
    const elementsOf = (b: Body) =>
      stateVectorToElements(
        EARTH_MASS,
        { position: earth.position, velocity: earth.velocity },
        { position: b.position, velocity: b.velocity }
      );

    // Real masses, spanning over five decades from Vanguard 1 to the station.
    expect(named('ISS').mass).toBeCloseTo(4.2e5, -3);
    expect(named('Hubble').mass).toBeCloseTo(1.111e4, -2);
    expect(named('Starlink').mass).toBeLessThan(1e3);
    expect(named('Vanguard 1').mass).toBeCloseTo(1.46, 1);

    // Inclination and eccentricity are the real values, not scaled.
    expect(elementsOf(named('ISS')).i).toBeCloseTo(51.64, 1);
    expect(elementsOf(named('Hubble')).i).toBeCloseTo(28.47, 1);
    // Sun-synchronous orbits are retrograde — inclination above 90°.
    expect(elementsOf(named('Landsat 9')).i).toBeGreaterThan(90);
    expect(elementsOf(named('Sentinel-2')).i).toBeGreaterThan(90);
    // The Molniya keeps its highly eccentric, critically inclined loop.
    expect(elementsOf(named('Molniya 3-53')).e).toBeCloseTo(0.74, 2);
    expect(elementsOf(named('Molniya 3-53')).i).toBeCloseTo(63.4, 1);
    // Geostationary birds sit flat on the equator on a circular orbit.
    expect(elementsOf(named('GOES-18')).i).toBeLessThan(1);
    expect(elementsOf(named('GOES-18')).e).toBeLessThan(0.01);
  });

  it('keeps the named spacecraft ordered by real altitude', () => {
    // LEO under MEO under GEO under the deep ellipses — the tier ordering the
    // whole roster is built around.
    const a = (name: string) =>
      stateVectorToElements(
        EARTH_MASS,
        { position: earth.position, velocity: earth.velocity },
        {
          position: bodies.find((b) => b.name === name)!.position,
          velocity: bodies.find((b) => b.name === name)!.velocity,
        }
      ).a;

    expect(a('ISS')).toBeLessThan(a('Hubble'));
    expect(a('Hubble')).toBeLessThan(a('Landsat 9'));
    expect(a('Landsat 9')).toBeLessThan(a('GPS III Vespucci'));
    expect(a('GPS III Vespucci')).toBeLessThan(a('GOES-18'));
    expect(a('GOES-18')).toBeLessThan(a('TESS'));
  });

  it('anchors every satellite to Earth (or the Moon) by sphere of influence', () => {
    // Parent-relative trails and the info panel both hang off this inference;
    // a satellite attributed to the Sun would draw its trail as a 1 AU helix.
    const mass = Float64Array.from(bodies.map((b) => b.mass));
    const pos = new Float64Array(bodies.length * 3);
    bodies.forEach((b, i) => {
      pos[i * 3] = b.position.x;
      pos[i * 3 + 1] = b.position.y;
      pos[i * 3 + 2] = b.position.z;
    });

    const earthIndex = bodies.indexOf(earth);
    const moonIndex = bodies.findIndex((b) => b.name === 'Moon');
    for (const sat of satellites) {
      const parent = dominantAttractor(bodies.indexOf(sat), mass, pos, bodies.length);
      expect([earthIndex, moonIndex]).toContain(parent);
    }
  });

  it('never places two satellites on top of each other', () => {
    // Several groups share one semi-major axis — the GEO belt, the GPS planes,
    // the GRACE-FO pair 220 km apart — and their LAN/phase are hand-chosen in
    // the roster, so a careless edit there can drop two craft onto the same
    // point: they render as one body and become each other's dominant
    // attractor. Guard the whole swarm.
    for (let i = 0; i < satellites.length; i++) {
      for (let j = i + 1; j < satellites.length; j++) {
        const a = satellites[i].position;
        const b = satellites[j].position;
        const sep = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        expect(sep).toBeGreaterThan(1e5);
      }
    }
  });

  // At the preset's own dt, deliberately: at the app default these orbits are
  // nine steps around and the LEO satellites spiral out. That the preset is
  // only correct under its own timing is the thing worth pinning.
  it('keeps the swarm bound to Earth over a week of simulation', () => {
    const sim = new Simulation(bodies, SATELLITE_TIMING);
    sim.advanceTo(7 * DAY, Infinity);

    const earthPos = sim.positionOf(earth.id)!;
    for (const sat of satellites) {
      const pos = sim.positionOf(sat.id);
      expect(pos).not.toBeNull();
      const r = Math.hypot(pos!.x - earthPos.x, pos!.y - earthPos.y, pos!.z - earthPos.z);
      // Inside the Hill sphere: nothing escaped or fell out of its shell.
      expect(r).toBeLessThan(1.5e9);
      expect(r).toBeGreaterThan(6.4e6); // and nothing deorbited into Earth
    }
  });

  it('holds the ISS at its real altitude rather than spiralling it out', () => {
    // The failure mode the preset's dt exists to prevent, measured: at the app
    // default the semi-major axis grows ~2.75% in ten days, lifting the station
    // from 408 km to over 1300 km. At 60 s it holds to a few parts in 10⁵.
    const iss = bodies.find((b) => b.name === 'ISS')!;
    const sim = new Simulation(bodies, SATELLITE_TIMING);
    sim.advanceTo(7 * DAY, Infinity);

    const earthPos = sim.positionOf(earth.id)!;
    const pos = sim.positionOf(iss.id)!;
    const r = Math.hypot(pos.x - earthPos.x, pos.y - earthPos.y, pos.z - earthPos.z);
    const altitude = (r - EARTH_RADIUS) / 1000; // km
    expect(altitude).toBeGreaterThan(380);
    expect(altitude).toBeLessThan(460);
  });
});

describe('planetesimal disk', () => {
  const bodies = planetesimalDisk();

  it('survives a month of simulation without blowing up', () => {
    const sim = new Simulation(bodies);
    sim.advanceTo(30 * DAY, Infinity);

    let alive = 0;
    for (const b of bodies) {
      const pos = sim.positionOf(b.id);
      if (!pos) continue; // merged away — expected in this preset
      alive++;
      expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
      // Nothing flung to interstellar distances this fast.
      expect(Math.hypot(pos.x, pos.y, pos.z) / AU).toBeLessThan(10);
    }
    expect(alive).toBeGreaterThan(bodies.length / 2);
  });

  it('separates the drawn radius from the one that merges', () => {
    // The merge rate is tuned via `collisionRadius` alone. The drawn radius
    // stays at the ×4 the preset's camera and thumbnail are framed around, so
    // retuning merges can never silently resize the bodies on screen.
    for (const b of bodies) {
      if (b.type !== 'rocky') continue;
      const trueRadius = Math.cbrt((3 * b.mass) / (4 * Math.PI * 1500));
      expect(b.radius / trueRadius).toBeCloseTo(4, 5);
      expect(b.collisionRadius! / trueRadius).toBeCloseTo(80, 5);
    }
  });

  it('actually merges within a few years', () => {
    // The whole point of the preset. Merges are rare enough at honest radii
    // that this silently produced zero of them for a long time — the inflation
    // factor is tuned against this test, so keep the horizon short enough that
    // it reflects what someone scrubbing the timeline would see.
    const sim = new Simulation(planetesimalDisk());
    sim.advanceTo(2 * 365.25 * DAY, Infinity);
    expect(sim.merges.length).toBeGreaterThan(0);
  }, 30000);
});

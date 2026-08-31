import { describe, expect, it } from 'vitest';
import {
  MOON_PERIOD_MAX,
  MOON_PERIOD_MIN,
  PLANET_COUNT_MAX,
  PLANET_COUNT_MIN,
  randomSystem,
} from './randomSystem';
import { AU, DAY, G } from '../physics/constants';
import { stateVectorToElements } from '../physics/kepler';
import { dominantAttractor } from '../physics/orbitInfo';
import { DEFAULT_DT, Simulation } from '../sim/simulation';
import type { Body } from '../types';

// A spread of arbitrary seeds — the generator must hold its invariants for
// any seed, not a curated few, so these are just fixed dice rolls.
const SEEDS = [1, 42, 0x2c9f1e4d, 7654321, 0xdeadbeef, 987654, 0x00c0ffee, 31415926, 271828, 0xfeedface];

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

function moonsOf(bodies: Body[]) {
  return bodies.filter((b) => b.type === 'moon');
}

function planetsOf(bodies: Body[]) {
  return bodies.filter((b) => b.type !== 'moon' && b.type !== 'star');
}

/** A moon is named "<planet> <numeral>"; its parent is everything before the last token. */
function parentOf(moon: Body, bodies: Body[]): Body {
  const parentName = moon.name.replace(/ [IVX]+$/, '');
  const parent = bodies.find((b) => b.name === parentName);
  expect(parent, `parent of ${moon.name}`).toBeDefined();
  return parent!;
}

describe('random system', () => {
  it('builds deterministically per seed, apart from ids', () => {
    const first = randomSystem(42);
    const second = randomSystem(42);
    expect(fingerprint(second.bodies)).toEqual(fingerprint(first.bodies));
    expect(second.name).toBe(first.name);
    expect(second.bodies[1].id).not.toBe(first.bodies[1].id);
  });

  it('builds different systems from different seeds', () => {
    expect(fingerprint(randomSystem(1).bodies)).not.toEqual(fingerprint(randomSystem(2).bodies));
  });

  it.each(SEEDS)('seed %d holds the structural invariants', (seed) => {
    const { name, bodies } = randomSystem(seed);
    const star = bodies[0];
    const planets = planetsOf(bodies);
    const moons = moonsOf(bodies);

    expect(star.type).toBe('star');
    expect(bodies.filter((b) => b.type === 'star')).toHaveLength(1);
    expect(name).toBe(`${star.name} System`);

    expect(planets.length).toBeGreaterThanOrEqual(PLANET_COUNT_MIN);
    expect(planets.length).toBeLessThanOrEqual(PLANET_COUNT_MAX);
    expect(moons.length).toBeLessThanOrEqual(planets.length);

    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-3);
  });

  it.each(SEEDS)('seed %d puts every planet on a bound, near-circular orbit', (seed) => {
    const { bodies } = randomSystem(seed);
    const star = bodies[0];
    for (const planet of planetsOf(bodies)) {
      const elements = stateVectorToElements(
        star.mass,
        { position: star.position, velocity: star.velocity },
        { position: planet.position, velocity: planet.velocity },
        planet.mass
      );
      expect(elements.a).toBeGreaterThan(0.05 * AU);
      expect(elements.a).toBeLessThan(60 * AU);
      expect(elements.e).toBeLessThan(0.12);
    }
  });

  it.each(SEEDS)('seed %d keeps every moon in its planet grip', (seed) => {
    const { bodies } = randomSystem(seed);
    const star = bodies[0];

    const mass = Float64Array.from(bodies.map((b) => b.mass));
    const pos = new Float64Array(bodies.length * 3);
    bodies.forEach((b, i) => {
      pos[i * 3] = b.position.x;
      pos[i * 3 + 1] = b.position.y;
      pos[i * 3 + 2] = b.position.z;
    });

    for (const moon of moonsOf(bodies)) {
      const planet = parentOf(moon, bodies);
      const elements = stateVectorToElements(
        planet.mass,
        { position: planet.position, velocity: planet.velocity },
        { position: moon.position, velocity: moon.velocity },
        moon.mass
      );

      // Inside the region where the planet, not the star, owns the orbit —
      // the SOI inference is what parent-relative trails and the info panel
      // hang off, so a moon the star wins would render as a 1 AU helix.
      const attractor = dominantAttractor(bodies.indexOf(moon), mass, pos, bodies.length);
      expect(bodies[attractor!].name, moon.name).toBe(planet.name);

      // Periods the app's *default* grids can integrate and draw — the whole
      // point of the generator's period clamp is needing no custom timing.
      const period = 2 * Math.PI * Math.sqrt(elements.a ** 3 / (G * (planet.mass + moon.mass)));
      expect(period).toBeGreaterThan(MOON_PERIOD_MIN * 0.95);
      expect(period).toBeLessThan(MOON_PERIOD_MAX * 1.05);
      expect(period / DEFAULT_DT).toBeGreaterThan(1000);

      expect(elements.e).toBeLessThan(0.1);
      expect(elements.a * (1 - elements.e)).toBeGreaterThan(3 * planet.radius);

      // Tidally locked: spin matches the two-body month.
      expect(moon.rotationPeriod).toBeCloseTo(period, -3);
    }
  });

  it('survives a year of simulation with every moon still bound', () => {
    const { bodies } = randomSystem(0x2c9f1e4d);
    const sim = new Simulation(bodies);
    sim.advanceTo(365 * DAY, Infinity);

    for (const b of bodies) {
      const p = sim.positionOf(b.id);
      expect(p, b.name).not.toBeNull();
      expect(Number.isFinite(p!.x + p!.y + p!.z)).toBe(true);
    }

    for (const moon of moonsOf(bodies)) {
      const planet = parentOf(moon, bodies);
      const moonPos = sim.positionOf(moon.id)!;
      const planetPos = sim.positionOf(planet.id)!;
      const r = Math.hypot(moonPos.x - planetPos.x, moonPos.y - planetPos.y, moonPos.z - planetPos.z);

      const star = bodies[0];
      const aPlanet = Math.hypot(
        planet.position.x - star.position.x,
        planet.position.y - star.position.y,
        planet.position.z - star.position.z
      );
      const rHill = aPlanet * Math.cbrt(planet.mass / (3 * star.mass));
      expect(r, moon.name).toBeLessThan(rHill);
      expect(r, moon.name).toBeGreaterThan(planet.radius);
    }
  });
});

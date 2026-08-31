import { describe, expect, it } from 'vitest';
import { AU, DAY, EARTH_MASS, MOON_MASS, MOON_ORBIT, SUN_MASS, YEAR } from './constants';
import { circularOrbit, elementsToStateVector, type OrbitalElements } from './kepler';
import {
  dominantAttractor,
  dominantAttractorAtPoint,
  summarizeOrbit,
} from './orbitInfo';
import { AT_ORIGIN } from './testUtils';

describe('summarizeOrbit: period and apsides', () => {
  it("recovers Earth's period from a circular 1 AU state vector", () => {
    const earth = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, 0, EARTH_MASS);
    const info = summarizeOrbit(SUN_MASS, AT_ORIGIN, earth, EARTH_MASS);

    expect(info.bound).toBe(true);
    expect(info.period! / YEAR).toBeCloseTo(1, 2);
    // The manual acceptance criterion is "≈ 365 d".
    expect(info.period! / DAY).toBeGreaterThan(360);
    expect(info.period! / DAY).toBeLessThan(370);
  });

  it('round-trips apsides against the elements that built the state', () => {
    const elements: OrbitalElements = {
      a: 2 * AU,
      e: 0.4,
      i: 20,
      lan: 55,
      argPeriapsis: 110,
      trueAnomaly: 200,
    };
    const sv = elementsToStateVector(SUN_MASS, AT_ORIGIN, elements);
    const info = summarizeOrbit(SUN_MASS, AT_ORIGIN, sv);

    expect(info.semiMajorAxis / elements.a).toBeCloseTo(1, 9);
    expect(info.eccentricity).toBeCloseTo(elements.e, 9);
    expect(info.inclination).toBeCloseTo(elements.i, 8);
    expect(info.apoapsis! / (elements.a * (1 + elements.e))).toBeCloseTo(1, 9);
    expect(info.periapsis / (elements.a * (1 - elements.e))).toBeCloseTo(1, 9);
  });

  it('reports distance and relative speed at periapsis and apoapsis', () => {
    const base = { a: AU, e: 0.5, i: 0, lan: 0, argPeriapsis: 0 };
    const peri = elementsToStateVector(SUN_MASS, AT_ORIGIN, { ...base, trueAnomaly: 0 });
    const apo = elementsToStateVector(SUN_MASS, AT_ORIGIN, { ...base, trueAnomaly: 180 });

    const atPeri = summarizeOrbit(SUN_MASS, AT_ORIGIN, peri);
    const atApo = summarizeOrbit(SUN_MASS, AT_ORIGIN, apo);

    // The current distance equals the apsis the body is sitting at.
    expect(atPeri.distance / atPeri.periapsis).toBeCloseTo(1, 6);
    expect(atApo.distance / atApo.apoapsis!).toBeCloseTo(1, 6);
    // Both describe the same orbit, so the derived elements agree.
    expect(atPeri.period! / atApo.period!).toBeCloseTo(1, 9);
    expect(atPeri.relativeSpeed).toBeGreaterThan(atApo.relativeSpeed);
  });

  it("derives the Moon's period around a moving Earth", () => {
    const earth = { position: { x: AU, y: 0, z: 0 }, velocity: { x: 0, y: 29800, z: 0 } };
    const moon = circularOrbit(EARTH_MASS, earth, MOON_ORBIT, 0, 0, MOON_MASS);
    const info = summarizeOrbit(EARTH_MASS, earth, moon, MOON_MASS);

    // Sidereal month, ~27.3 d — and it must not be polluted by Earth's own
    // orbital motion, which is 30× the Moon's relative speed.
    expect(info.period! / DAY).toBeGreaterThan(27);
    expect(info.period! / DAY).toBeLessThan(27.6);
    expect(info.distance).toBeCloseTo(MOON_ORBIT, 0);
  });

  it('marks an unbound orbit as such, with no period or apoapsis', () => {
    const escape = Math.sqrt((2 * 6.6743e-11 * SUN_MASS) / AU);
    const sv = { position: { x: AU, y: 0, z: 0 }, velocity: { x: 0, y: escape * 1.5, z: 0 } };
    const info = summarizeOrbit(SUN_MASS, AT_ORIGIN, sv);

    expect(info.bound).toBe(false);
    expect(info.period).toBeNull();
    expect(info.apoapsis).toBeNull();
    // A hyperbolic orbit still has a closest approach.
    expect(info.periapsis).toBeGreaterThan(0);
  });
});

describe('dominantAttractor', () => {
  // Sun at the origin, Earth at 1 AU, Moon just outside Earth.
  const mass = [SUN_MASS, EARTH_MASS, MOON_MASS];
  const pos = [0, 0, 0, AU, 0, 0, AU + MOON_ORBIT, 0, 0];

  it("names the star as a planet's attractor", () => {
    expect(dominantAttractor(1, mass, pos, 3)).toBe(0);
  });

  it("names the planet as its moon's attractor, not the far more massive star", () => {
    // The case that rules out "strongest pull": the Sun actually pulls the
    // Moon ~2× harder than Earth does. Earth wins because the Moon sits well
    // inside Earth's sphere of influence (~0.93e9 m vs the Moon's 0.384e9 m).
    expect(dominantAttractor(2, mass, pos, 3)).toBe(1);
  });

  it("keeps a distant planet under the star even when a moon is nearby in mass", () => {
    // A second planet far from Earth is outside Earth's SOI, so it stays solar.
    const m = [SUN_MASS, EARTH_MASS, EARTH_MASS];
    const p = [0, 0, 0, AU, 0, 0, -1.6 * AU, 0, 0];
    expect(dominantAttractor(2, m, p, 3)).toBe(0);
  });

  it('never reports a body as orbiting something less massive than itself', () => {
    // Asked about Earth, with only its own Moon as an alternative candidate.
    expect(dominantAttractor(1, mass, pos, 3)).not.toBe(2);
  });

  it('returns null when the body is alone', () => {
    expect(dominantAttractor(0, [SUN_MASS], [0, 0, 0], 1)).toBeNull();
  });

  it('returns null for the most massive body, which orbits nothing', () => {
    expect(dominantAttractor(0, mass, pos, 3)).toBeNull();
  });
});

describe('dominantAttractorAtPoint', () => {
  const mass = [SUN_MASS, EARTH_MASS, MOON_MASS];
  const pos = [0, 0, 0, AU, 0, 0, AU + MOON_ORBIT, 0, 0];

  it('assigns a point just outside a planet to that planet', () => {
    expect(dominantAttractorAtPoint(AU + MOON_ORBIT / 2, 0, 0, mass, pos, 3)).toBe(1);
  });

  it('assigns a point in deep space to the star', () => {
    expect(dominantAttractorAtPoint(-2 * AU, AU, 0, mass, pos, 3)).toBe(0);
  });

  it('respects the minimum candidate mass', () => {
    // Placing something Earth-mass right next to Earth: Earth is no longer a
    // valid parent, so the point falls to the Sun.
    expect(dominantAttractorAtPoint(AU + MOON_ORBIT / 2, 0, 0, mass, pos, 3, EARTH_MASS)).toBe(0);
  });

  it('agrees with dominantAttractor when evaluated at an existing body', () => {
    // At the Moon's own position with the Moon's mass as the floor: the Moon
    // itself is filtered by the mass test, so the answers must match.
    expect(dominantAttractorAtPoint(AU + MOON_ORBIT, 0, 0, mass, pos, 3, MOON_MASS)).toBe(
      dominantAttractor(2, mass, pos, 3)
    );
  });

  it('returns null for an empty system', () => {
    expect(dominantAttractorAtPoint(0, 0, 0, [], [], 0)).toBeNull();
  });

  it('returns null when nothing clears the mass floor', () => {
    expect(dominantAttractorAtPoint(0, AU, 0, mass, pos, 3, 2 * SUN_MASS)).toBeNull();
  });
});

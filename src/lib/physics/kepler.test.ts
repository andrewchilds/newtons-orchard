import { describe, expect, it } from 'vitest';
import { AU, DAY, EARTH_MASS, MOON_MASS, MOON_ORBIT, SUN_MASS, YEAR } from './constants';
import {
  circularOrbit,
  circularVelocityAt,
  elementsToStateVector,
  orbitalPeriod,
  stateVectorToElements,
  visViva,
  type OrbitalElements,
} from './kepler';
import { length } from './vec3';
import { AT_ORIGIN } from './testUtils';

describe('kepler: period', () => {
  it("Earth's orbital period matches a year", () => {
    // Sun + Earth, so μ = G(M☉ + M⊕).
    const period = orbitalPeriod(AU, SUN_MASS, EARTH_MASS);
    expect(period / YEAR).toBeCloseTo(1, 2);
  });

  it("the Moon's period is ~27.3 days (sidereal)", () => {
    const period = orbitalPeriod(MOON_ORBIT, EARTH_MASS, MOON_MASS);
    expect(period / DAY).toBeGreaterThan(27);
    expect(period / DAY).toBeLessThan(27.6);
  });

  it('scales as a^{3/2} (Kepler III)', () => {
    const inner = orbitalPeriod(AU, SUN_MASS);
    const outer = orbitalPeriod(4 * AU, SUN_MASS);
    expect(outer / inner).toBeCloseTo(8, 6); // 4^{3/2}
  });
});

describe('kepler: elements → state vector', () => {
  it('places a circular orbit at the right radius and speed', () => {
    const sv = circularOrbit(SUN_MASS, AT_ORIGIN, AU);
    const r = length(sv.position);
    const v = length(sv.velocity);

    expect(r).toBeCloseTo(AU, 0);
    // Circular speed sqrt(μ/r) ≈ 29.78 km/s.
    expect(v).toBeCloseTo(Math.sqrt((6.6743e-11 * SUN_MASS) / AU), 3);
    expect(v / 1000).toBeGreaterThan(29.7);
    expect(v / 1000).toBeLessThan(29.9);
  });

  it('is perpendicular for a circular orbit, at every phase', () => {
    for (const phase of [0, 37, 90, 180, 271]) {
      const sv = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, phase);
      const { position: p, velocity: v } = sv;
      const cosAngle = (p.x * v.x + p.y * v.y + p.z * v.z) / (length(p) * length(v));
      expect(Math.abs(cosAngle)).toBeLessThan(1e-12);
    }
  });

  it('matches vis-viva speed on an eccentric orbit at arbitrary anomaly', () => {
    const elements: OrbitalElements = {
      a: 2 * AU,
      e: 0.5,
      i: 15,
      lan: 40,
      argPeriapsis: 70,
      trueAnomaly: 123,
    };
    const sv = elementsToStateVector(SUN_MASS, AT_ORIGIN, elements);
    const r = length(sv.position);
    const v = length(sv.velocity);

    expect(v).toBeCloseTo(visViva(r, elements.a, SUN_MASS), 6);
  });

  it('gives the correct apoapsis/periapsis ratio for e = 0.5', () => {
    const a = AU;
    const e = 0.5;
    const base = { a, e, i: 0, lan: 0, argPeriapsis: 0 };

    const peri = elementsToStateVector(SUN_MASS, AT_ORIGIN, { ...base, trueAnomaly: 0 });
    const apo = elementsToStateVector(SUN_MASS, AT_ORIGIN, { ...base, trueAnomaly: 180 });

    const rPeri = length(peri.position);
    const rApo = length(apo.position);

    expect(rPeri).toBeCloseTo(a * (1 - e), 0); // 0.5 AU
    expect(rApo).toBeCloseTo(a * (1 + e), 0); // 1.5 AU
    // (1+e)/(1−e) = 3 for e = 0.5.
    expect(rApo / rPeri).toBeCloseTo(3, 9);

    // Angular momentum is conserved, so v·r matches at both apsides.
    expect(length(apo.velocity) * rApo).toBeCloseTo(length(peri.velocity) * rPeri, 0);
    expect(length(peri.velocity)).toBeGreaterThan(length(apo.velocity));
  });

  it('applies inclination', () => {
    const sv = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 90, 90);
    // A 90° inclined orbit a quarter turn past the node is over the pole.
    expect(Math.abs(sv.position.z)).toBeCloseTo(AU, 0);
  });

  it('adds the parent state, so orbits follow a moving parent', () => {
    const parent = {
      position: { x: AU, y: 0, z: 0 },
      velocity: { x: 0, y: 30000, z: 0 },
    };
    const sv = circularOrbit(EARTH_MASS, parent, MOON_ORBIT, 0, 0, MOON_MASS);

    expect(sv.position.x).toBeCloseTo(AU + MOON_ORBIT, 0);
    // The Moon's own orbital speed rides on top of Earth's.
    expect(sv.velocity.y).toBeGreaterThan(30000);
    expect(sv.velocity.y - 30000).toBeGreaterThan(900); // ~1.02 km/s
  });
});

describe('kepler: circularVelocityAt', () => {
  it('gives circular speed perpendicular to the radial, prograde', () => {
    const position = { x: 0.3 * AU, y: -0.8 * AU, z: 0 };
    const v = circularVelocityAt(SUN_MASS, AT_ORIGIN, position);

    const r = length(position);
    expect(length(v)).toBeCloseTo(Math.sqrt((6.6743e-11 * SUN_MASS) / r), 6);
    // Perpendicular to the radial.
    expect(Math.abs(position.x * v.x + position.y * v.y + position.z * v.z)).toBeLessThan(
      1e-4 * r * length(v)
    );
    // Prograde: angular momentum r × v points along +z.
    expect(position.x * v.y - position.y * v.x).toBeGreaterThan(0);
  });

  it('matches circularOrbit at the equivalent phase', () => {
    for (const phase of [0, 45, 137, 260]) {
      const sv = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, phase, EARTH_MASS);
      const v = circularVelocityAt(SUN_MASS, AT_ORIGIN, sv.position, EARTH_MASS);

      expect(v.x).toBeCloseTo(sv.velocity.x, 3);
      expect(v.y).toBeCloseTo(sv.velocity.y, 3);
      expect(v.z).toBeCloseTo(sv.velocity.z, 3);
    }
  });

  it("rides on the parent's own velocity", () => {
    const parent = {
      position: { x: AU, y: 0, z: 0 },
      velocity: { x: 0, y: 29800, z: 0 },
    };
    const v = circularVelocityAt(EARTH_MASS, parent, { x: AU + MOON_ORBIT, y: 0, z: 0 }, MOON_MASS);

    // The Moon's ~1.02 km/s circular speed rides on top of Earth's 29.8.
    expect(v.y - 29800).toBeGreaterThan(900);
    expect(v.y - 29800).toBeLessThan(1100);
    expect(v.x).toBeCloseTo(0, 6);
  });

  it('stays perpendicular for a position with a z-offset from the parent', () => {
    const position = { x: 0.5 * AU, y: 0.5 * AU, z: 0.3 * AU };
    const v = circularVelocityAt(SUN_MASS, AT_ORIGIN, position);

    expect(Math.abs(position.x * v.x + position.y * v.y + position.z * v.z)).toBeLessThan(
      1e-4 * length(position) * length(v)
    );
    expect(length(v)).toBeCloseTo(Math.sqrt((6.6743e-11 * SUN_MASS) / length(position)), 6);
  });

  it('falls back to +x on the polar axis instead of NaN', () => {
    const v = circularVelocityAt(SUN_MASS, AT_ORIGIN, { x: 0, y: 0, z: AU });
    expect(Number.isFinite(v.x)).toBe(true);
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBe(0);
  });
});

describe('kepler: state vector → elements round-trip', () => {
  const cases: Array<[string, OrbitalElements]> = [
    ['inclined eccentric', { a: 2 * AU, e: 0.4, i: 20, lan: 55, argPeriapsis: 110, trueAnomaly: 200 }],
    ['near-polar', { a: 1.5 * AU, e: 0.2, i: 85, lan: 300, argPeriapsis: 15, trueAnomaly: 45 }],
    ['low eccentricity', { a: AU, e: 0.01, i: 5, lan: 120, argPeriapsis: 240, trueAnomaly: 330 }],
  ];

  for (const [name, elements] of cases) {
    it(`recovers ${name} elements`, () => {
      const sv = elementsToStateVector(SUN_MASS, AT_ORIGIN, elements);
      const back = stateVectorToElements(SUN_MASS, AT_ORIGIN, sv);

      expect(back.a / elements.a).toBeCloseTo(1, 9);
      expect(back.e).toBeCloseTo(elements.e, 9);
      expect(back.i).toBeCloseTo(elements.i, 8);
      expect(back.lan).toBeCloseTo(elements.lan, 8);
      expect(back.argPeriapsis).toBeCloseTo(elements.argPeriapsis, 7);
      expect(back.trueAnomaly).toBeCloseTo(elements.trueAnomaly, 7);
    });
  }

  it('reports a circular equatorial orbit as e ≈ 0 with the right radius', () => {
    const sv = circularOrbit(SUN_MASS, AT_ORIGIN, AU, 0, 0);
    const back = stateVectorToElements(SUN_MASS, AT_ORIGIN, sv);

    expect(back.e).toBeLessThan(1e-12);
    expect(back.a / AU).toBeCloseTo(1, 9);
    expect(back.i).toBeCloseTo(0, 9);
  });

  it('flags an unbound orbit with e ≥ 1 and non-positive a', () => {
    // Well above escape speed at 1 AU.
    const escape = Math.sqrt((2 * 6.6743e-11 * SUN_MASS) / AU);
    const sv = {
      position: { x: AU, y: 0, z: 0 },
      velocity: { x: 0, y: escape * 1.5, z: 0 },
    };
    const back = stateVectorToElements(SUN_MASS, AT_ORIGIN, sv);

    expect(back.e).toBeGreaterThan(1);
    expect(back.a).toBeLessThan(0);
  });
});

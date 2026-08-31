import { describe, expect, it } from 'vitest';
import {
  cameraAngles,
  distanceFromSi,
  distanceToSi,
  formatDegrees,
  formatPeriod,
  fromAu,
  fromDays,
  fromEarthMasses,
  fromKm,
  significant,
  toAu,
  toDays,
  toEarthMasses,
  toKm,
  validateBody,
  validateOrbit,
  TYPE_DEFAULTS,
  BODY_TYPES,
} from './units';
import { AU, DAY, EARTH_MASS, YEAR } from '../physics/constants';
import { vec3 } from '../physics/vec3';
import { testBody } from '../physics/testUtils';

describe('unit conversions', () => {
  it('round-trips through every pair', () => {
    // Relative, not absolute: toBeCloseTo's digit argument is meaningless
    // against values of order 1e25.
    const roundTrips = (si: number, out: number) => Math.abs(out - si) / si;
    expect(roundTrips(1.234e25, fromEarthMasses(toEarthMasses(1.234e25)))).toBeLessThan(1e-12);
    expect(roundTrips(6.371e6, fromKm(toKm(6.371e6)))).toBeLessThan(1e-12);
    expect(roundTrips(4.2e11, fromAu(toAu(4.2e11)))).toBeLessThan(1e-12);
    expect(roundTrips(98765, fromDays(toDays(98765)))).toBeLessThan(1e-12);
  });

  it('uses the documented reference values', () => {
    expect(toEarthMasses(EARTH_MASS)).toBeCloseTo(1, 12);
    expect(toAu(AU)).toBeCloseTo(1, 12);
    expect(toDays(DAY)).toBeCloseTo(1, 12);
    expect(toKm(1000)).toBeCloseTo(1, 12);
  });

  it('converts distances by the selected unit', () => {
    expect(distanceToSi(1, 'au')).toBeCloseTo(AU, 3);
    expect(distanceToSi(1, 'km')).toBeCloseTo(1000, 9);
    expect(distanceFromSi(AU, 'au')).toBeCloseTo(1, 9);
    expect(distanceFromSi(1000, 'km')).toBeCloseTo(1, 9);
  });
});

describe('significant', () => {
  it('strips the float noise that repeated conversion produces', () => {
    // The exact shape of the problem: km → m → km on a value that isn't
    // representable lands a few ulps off, and the input would show it.
    expect(significant(toKm(fromKm(1.1)))).toBe(1.1);
    expect(significant(0)).toBe(0);
  });

  it('is defined for non-finite input', () => {
    expect(significant(NaN)).toBe(0);
    expect(significant(Infinity)).toBe(0);
  });
});

describe('formatPeriod', () => {
  it('picks a readable unit', () => {
    expect(formatPeriod(3600)).toMatch(/hr$/);
    expect(formatPeriod(30 * DAY)).toMatch(/d$/);
    expect(formatPeriod(5 * YEAR)).toMatch(/yr$/);
  });

  it('reports nonsense as n/a rather than a number', () => {
    expect(formatPeriod(0)).toBe('n/a');
    expect(formatPeriod(NaN)).toBe('n/a');
    expect(formatPeriod(-1)).toBe('n/a');
  });
});

describe('cameraAngles', () => {
  it('measures azimuth from +x, turning toward +y', () => {
    expect(cameraAngles(1, 0, 0).azimuth).toBeCloseTo(0, 9);
    expect(cameraAngles(0, 1, 0).azimuth).toBeCloseTo(90, 9);
    expect(cameraAngles(-1, 0, 0).azimuth).toBeCloseTo(180, 9);
  });

  it('reports azimuth in [0, 360), not the signed range atan2 returns', () => {
    expect(cameraAngles(0, -1, 0).azimuth).toBeCloseTo(270, 9);
  });

  it('measures elevation above the x–y plane', () => {
    expect(cameraAngles(1, 0, 0).elevation).toBeCloseTo(0, 9);
    expect(cameraAngles(0, 0, 1).elevation).toBeCloseTo(90, 9);
    expect(cameraAngles(0, 0, -1).elevation).toBeCloseTo(-90, 9);
    expect(cameraAngles(1, 0, 1).elevation).toBeCloseTo(45, 9);
  });

  it('reports a stable azimuth at the poles instead of following float dust', () => {
    // Straight down +z: every bearing is equally true, and letting atan2 pick
    // one from ~1e-17 components would flicker as the camera drifts.
    expect(cameraAngles(0, 0, 260).azimuth).toBe(0);
    expect(cameraAngles(-1e-17, 1e-18, 260).azimuth).toBe(0);
    expect(cameraAngles(0, 0, 260).elevation).toBeCloseTo(90, 9);
  });

  it('survives a degenerate zero offset rather than returning NaN', () => {
    expect(cameraAngles(0, 0, 0)).toEqual({ azimuth: 0, elevation: 0 });
  });

  it('ignores non-finite input rather than propagating NaN', () => {
    expect(cameraAngles(NaN, 0, 1)).toEqual({ azimuth: 0, elevation: 0 });
  });

  it('is unaffected by distance — only direction', () => {
    const near = cameraAngles(3, 4, 5);
    const far = cameraAngles(300, 400, 500);
    expect(far.azimuth).toBeCloseTo(near.azimuth, 9);
    expect(far.elevation).toBeCloseTo(near.elevation, 9);
  });
});

describe('formatDegrees', () => {
  it('rounds to whole degrees', () => {
    expect(formatDegrees(89.6)).toBe('90°');
    expect(formatDegrees(0.4)).toBe('0°');
  });

  it('never shows a negative zero', () => {
    expect(formatDegrees(-0.4)).toBe('0°');
  });

  it('folds a rounded 360 back to 0, azimuth’s excluded upper bound', () => {
    expect(formatDegrees(359.7)).toBe('0°');
  });

  it('keeps a genuinely negative elevation', () => {
    expect(formatDegrees(-45)).toBe('-45°');
  });

  it('reports non-finite input rather than printing NaN', () => {
    expect(formatDegrees(NaN)).toBe('—');
  });
});

describe('validateBody', () => {
  it('accepts a well-formed body', () => {
    expect(validateBody(testBody({ mass: EARTH_MASS })).ok).toBe(true);
  });

  it('rejects non-positive mass and radius', () => {
    expect(validateBody(testBody({ mass: 0 })).errors.mass).toBeDefined();
    expect(validateBody(testBody({ mass: -1 })).errors.mass).toBeDefined();
    expect(validateBody(testBody({ mass: 1, radius: 0 })).errors.radius).toBeDefined();
  });

  it('rejects NaN anywhere it would reach the integrator', () => {
    expect(validateBody(testBody({ mass: NaN })).errors.mass).toBeDefined();
    expect(validateBody(testBody({ mass: 1, radius: NaN })).errors.radius).toBeDefined();
    expect(
      validateBody(testBody({ mass: 1, position: vec3(NaN, 0, 0) })).errors.position
    ).toBeDefined();
    expect(
      validateBody(testBody({ mass: 1, velocity: vec3(0, Infinity, 0) })).errors.velocity
    ).toBeDefined();
  });

  it('requires a non-empty name', () => {
    expect(validateBody(testBody({ mass: 1, name: '' })).errors.name).toBeDefined();
    expect(validateBody(testBody({ mass: 1, name: '   ' })).errors.name).toBeDefined();
  });

  it('allows zero and negative rotation periods', () => {
    // 0 means "don't spin"; negative means retrograde. Both are legal.
    expect(validateBody(testBody({ mass: 1, rotationPeriod: 0 })).ok).toBe(true);
    expect(validateBody(testBody({ mass: 1, rotationPeriod: -86400 })).ok).toBe(true);
  });

  it('requires ring radii to describe an actual annulus', () => {
    const rings = { color: '#fff', opacity: 0.5 };
    expect(
      validateBody(testBody({ mass: 1, rings: { ...rings, innerRadius: 2, outerRadius: 1 } }))
        .errors.rings
    ).toBeDefined();
    expect(
      validateBody(testBody({ mass: 1, rings: { ...rings, innerRadius: 1, outerRadius: 2 } })).ok
    ).toBe(true);
  });
});

describe('validateOrbit', () => {
  const valid = { parentId: 'p', distance: AU, eccentricity: 0, inclination: 0, phase: 0 };

  it('accepts a well-formed orbit', () => {
    expect(validateOrbit(valid).ok).toBe(true);
  });

  it('requires a parent', () => {
    expect(validateOrbit({ ...valid, parentId: null }).errors.parentId).toBeDefined();
  });

  it('rejects eccentricity at or past parabolic', () => {
    // e = 1 makes the semi-latus rectum zero and the state vector infinite.
    expect(validateOrbit({ ...valid, eccentricity: 1 }).errors.eccentricity).toBeDefined();
    expect(validateOrbit({ ...valid, eccentricity: 1.5 }).errors.eccentricity).toBeDefined();
    expect(validateOrbit({ ...valid, eccentricity: -0.1 }).errors.eccentricity).toBeDefined();
    expect(validateOrbit({ ...valid, eccentricity: 0.99 }).ok).toBe(true);
  });

  it('rejects a non-positive distance', () => {
    expect(validateOrbit({ ...valid, distance: 0 }).errors.distance).toBeDefined();
    expect(validateOrbit({ ...valid, distance: NaN }).errors.distance).toBeDefined();
  });
});

describe('type defaults', () => {
  it('gives every body type a usable, valid starting point', () => {
    for (const type of BODY_TYPES) {
      const d = TYPE_DEFAULTS[type];
      expect(d.mass).toBeGreaterThan(0);
      expect(d.radius).toBeGreaterThan(0);
      expect(d.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(validateBody(testBody({ ...d })).ok).toBe(true);
    }
  });
});

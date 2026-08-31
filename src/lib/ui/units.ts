// Display-unit conversions and body validation.
//
// The data model is SI throughout (kg, m, s, and degrees only where the model
// already says degrees); editor fields are entered in friendlier units and
// converted at the edge. Conversion lives here, alone, so there is exactly one
// place where a factor can be wrong.

import { AU, DAY, EARTH_MASS, EARTH_RADIUS, schwarzschildRadius, SUN_MASS } from '../physics/constants';
import type { Body, BodyType } from '../types';

// --- conversions ---------------------------------------------------------
// Each pair is (SI → display, display → SI). Trivial on purpose; the value is
// in having them named and tested rather than inlined.

export const toEarthMasses = (kg: number) => kg / EARTH_MASS;
export const fromEarthMasses = (m: number) => m * EARTH_MASS;

export const toEarthRadii = (m: number) => m / EARTH_RADIUS;
export const fromEarthRadii = (r: number) => r * EARTH_RADIUS;

export const toKm = (m: number) => m / 1e3;
export const fromKm = (km: number) => km * 1e3;

export const toAu = (m: number) => m / AU;
export const fromAu = (au: number) => au * AU;

export const toDays = (s: number) => s / DAY;
export const fromDays = (d: number) => d * DAY;

/** Distance units offered in the orbit placement form. */
export type DistanceUnit = 'au' | 'km';

export function distanceToSi(value: number, unit: DistanceUnit): number {
  return unit === 'au' ? fromAu(value) : fromKm(value);
}

export function distanceFromSi(meters: number, unit: DistanceUnit): number {
  return unit === 'au' ? toAu(meters) : toKm(meters);
}

// --- formatting ----------------------------------------------------------

/**
 * Round to `digits` significant figures for a number input. Inputs round-trip
 * through these conversions on every keystroke, so without a round the field
 * fills with float noise (1.0000000000000002) after two conversions.
 */
export function significant(value: number, digits = 6): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Number(value.toPrecision(digits));
}

/** Compact human-readable number for read-only readouts. */
export function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return value.toExponential(digits - 1);
  return Number(value.toPrecision(digits)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

/** Orbital period in whatever unit reads best — hours, days, or years. */
export function formatPeriod(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'n/a';
  const days = toDays(seconds);
  if (days < 1) return `${formatNumber(seconds / 3600, 3)} hr`;
  if (days < 720) return `${formatNumber(days, 4)} d`;
  return `${formatNumber(days / 365, 4)} yr`;
}

/**
 * Where the camera sits on the sphere around the view center, as angles.
 *
 * - `azimuth`: bearing in the x–y plane, degrees in [0, 360). 0° is +x, 90° +y,
 *   a right-handed turn about z — the direction the Z button advances.
 * - `elevation`: angle above that plane, degrees in [-90, 90]. +90° is straight
 *   down the +z pole.
 *
 * Angles rather than xyz because the axis buttons move the camera in exactly
 * these terms, so a squared-up view reads as clean multiples of 90°.
 */
export function cameraAngles(
  x: number,
  y: number,
  z: number
): { azimuth: number; elevation: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return { azimuth: 0, elevation: 0 };
  }
  const planeRadius = Math.hypot(x, y);
  // Down a pole every bearing is equally true, so report 0 rather than letting
  // float dust in x/y pick an arbitrary one that flickers.
  const azimuth = planeRadius < 1e-9 ? 0 : (Math.atan2(y, x) * 180) / Math.PI;
  const elevation = planeRadius < 1e-9 && z === 0 ? 0 : (Math.atan2(z, planeRadius) * 180) / Math.PI;
  return { azimuth: (azimuth + 360) % 360, elevation };
}

/**
 * One angle in whole degrees: a tenth churns under the smallest drag, and whole
 * degrees keep the row a fixed width. Folds a rounded 360° back to 0 so azimuth
 * never displays its own excluded upper bound.
 */
export function formatDegrees(degrees: number): string {
  if (!Number.isFinite(degrees)) return '—';
  const rounded = Math.round(degrees);
  return `${rounded === 360 ? 0 : rounded}°`;
}

// --- validation ----------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  /** field name → message; empty when ok */
  errors: Record<string, string>;
}

const FINITE = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate the fields a user can type. Guards the two ways bad input reaches
 * the physics: a non-positive mass or radius (division by zero in the force
 * loop, or a body that can never collide) and NaN, which propagates through the
 * integrator and silently kills the whole system's trajectory.
 */
export function validateBody(body: Partial<Body>): ValidationResult {
  const errors: Record<string, string> = {};

  if (!body.name || body.name.trim() === '') errors.name = 'Name is required';

  if (!FINITE(body.mass) || body.mass <= 0) errors.mass = 'Mass must be greater than zero';
  if (!FINITE(body.radius) || body.radius <= 0) errors.radius = 'Radius must be greater than zero';

  // A rotation period of 0 is meaningful ("don't spin"), and negative means
  // retrograde, so the only bad value here is a non-number.
  if (!FINITE(body.rotationPeriod)) errors.rotationPeriod = 'Rotation period must be a number';
  if (!FINITE(body.axialTilt)) errors.axialTilt = 'Axial tilt must be a number';

  for (const vec of ['position', 'velocity'] as const) {
    const v = body[vec];
    if (v && (!FINITE(v.x) || !FINITE(v.y) || !FINITE(v.z))) {
      errors[vec] = `${vec === 'position' ? 'Position' : 'Velocity'} must be finite numbers`;
    }
  }

  if (body.atmosphere && (!FINITE(body.atmosphere.density) || body.atmosphere.density < 0)) {
    errors.atmosphere = 'Atmosphere density must be zero or more';
  }

  if (body.rings) {
    const { innerRadius, outerRadius } = body.rings;
    if (!FINITE(innerRadius) || innerRadius <= 0) errors.rings = 'Ring inner radius must be > 0';
    else if (!FINITE(outerRadius) || outerRadius <= innerRadius) {
      errors.rings = 'Ring outer radius must exceed the inner radius';
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

export interface OrbitInput {
  parentId: string | null;
  /** semi-major axis, m */
  distance: number;
  eccentricity: number;
  /** degrees */
  inclination: number;
  /** true anomaly at creation, degrees */
  phase: number;
}

/** Orbit placement needs a parent and a physically meaningful ellipse. */
export function validateOrbit(orbit: OrbitInput): ValidationResult {
  const errors: Record<string, string> = {};

  if (!orbit.parentId) errors.parentId = 'Choose a body to orbit';
  if (!FINITE(orbit.distance) || orbit.distance <= 0) {
    errors.distance = 'Distance must be greater than zero';
  }
  // e = 1 is a parabola: a is undefined and the state vector blows up.
  if (!FINITE(orbit.eccentricity) || orbit.eccentricity < 0 || orbit.eccentricity >= 1) {
    errors.eccentricity = 'Eccentricity must be at least 0 and below 1';
  }
  if (!FINITE(orbit.inclination)) errors.inclination = 'Inclination must be a number';
  if (!FINITE(orbit.phase)) errors.phase = 'Phase must be a number';

  return { ok: Object.keys(errors).length === 0, errors };
}

// --- per-type defaults ---------------------------------------------------

export interface TypeDefaults {
  mass: number; // kg
  radius: number; // m
  rotationPeriod: number; // s
  axialTilt: number; // degrees
  color: string;
}

/**
 * Starting values per body type, modeled on a familiar member of each class, so
 * picking "gas" and hitting create gets a Jupiter rather than a form of zeros.
 */
export const TYPE_DEFAULTS: Record<BodyType, TypeDefaults> = {
  star: {
    mass: 1.98892e30,
    radius: 6.957e8,
    rotationPeriod: 25.4 * DAY,
    axialTilt: 7.25,
    color: '#ffd27f',
  },
  // A temperate ocean world. The color tints the sea, so it must read as water
  // before the texture loads.
  earthlike: {
    mass: EARTH_MASS,
    radius: EARTH_RADIUS,
    rotationPeriod: 86164,
    axialTilt: 23.44,
    color: '#2f6fc4',
  },
  // A dry, thin-atmosphere rock — Mars or Mercury. `earthlike` is the type for
  // a world with oceans and weather.
  rocky: {
    mass: 6.4171e23,
    radius: 3.3895e6,
    rotationPeriod: 88642.7,
    axialTilt: 25.19,
    color: '#b86a44',
  },
  gas: {
    mass: 1.8982e27,
    radius: 6.9911e7,
    rotationPeriod: 9.925 * 3600,
    axialTilt: 3.13,
    color: '#d8a878',
  },
  ice: {
    mass: 1.0243e26,
    radius: 2.4622e7,
    rotationPeriod: 16.11 * 3600,
    axialTilt: 28.32,
    color: '#7fc8e8',
  },
  dwarf: {
    mass: 1.303e22,
    radius: 1.1883e6,
    rotationPeriod: 6.387 * DAY,
    axialTilt: 122.53,
    color: '#c4a68a',
  },
  moon: {
    mass: 7.34767309e22,
    radius: 1.7374e6,
    rotationPeriod: 27.32 * DAY,
    axialTilt: 6.68,
    color: '#c8c6c0',
  },
  asteroid: {
    mass: 9.39e20,
    radius: 4.73e5,
    rotationPeriod: 9.07 * 3600,
    axialTilt: 4,
    color: '#9a8f82',
  },
  // Modeled on the ISS: tens of meters, hundreds of tonnes, one turn per ~90 min.
  satellite: {
    mass: 4.2e5,
    radius: 55,
    rotationPeriod: 5574,
    axialTilt: 0,
    color: '#c9ccd4',
  },
  // Sgr A*: only a supermassive hole works at this app's scales. A stellar-mass
  // one has a ~3 km horizon — below the force softening length and permanently
  // sub-pixel — while this one is ~12e9 m, bigger than the Sun. The radius is
  // the horizon; gravity derives r_s from the mass, so editing the mass keeps
  // the force law consistent even if the drawn radius lags.
  blackhole: {
    mass: 4.15e6 * SUN_MASS,
    radius: schwarzschildRadius(4.15e6 * SUN_MASS),
    rotationPeriod: 0,
    axialTilt: 0,
    color: '#b39aff',
  },
};

export const BODY_TYPES: BodyType[] = [
  'star',
  'earthlike',
  'rocky',
  'gas',
  'ice',
  'dwarf',
  'moon',
  'asteroid',
  'satellite',
  'blackhole',
];

/** Single-glyph icon per type for the body list. */
export const TYPE_ICONS: Record<BodyType, string> = {
  star: '★',
  earthlike: '◉',
  rocky: '●',
  gas: '◍',
  ice: '❄',
  dwarf: '◦',
  moon: '☾',
  asteroid: '⬩',
  satellite: '⚙',
  blackhole: '◎',
};

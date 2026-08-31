// Physical constants, SI units (meters, kilograms, seconds).

/** Gravitational constant, m³ kg⁻¹ s⁻² */
export const G = 6.6743e-11;

/** Speed of light, m s⁻¹ */
export const C = 2.99792458e8;

/**
 * Schwarzschild radius: r_s = 2Gm/c². Event-horizon radius, and the length
 * scale of every relativistic effect the sim approximates (see
 * `computeAccelerations`' pseudo-potential branch).
 */
export function schwarzschildRadius(mass: number): number {
  return (2 * G * mass) / (C * C);
}

/** Astronomical unit, m */
export const AU = 1.495978707e11;

/** Seconds in an hour */
export const HOUR = 3600;
/** Seconds in a mean solar day */
export const DAY = 86400;
/** Seconds in a Julian year (365.25 days) */
export const YEAR = 365.25 * DAY;

/** Masses, kg */
export const SUN_MASS = 1.98892e30;
export const EARTH_MASS = 5.97219e24;
export const MOON_MASS = 7.34767309e22;
export const JUPITER_MASS = 1.8982e27;

/** Mean/equatorial radii, m */
export const SUN_RADIUS = 6.957e8;
export const EARTH_RADIUS = 6.371e6;
export const MOON_RADIUS = 1.7374e6;
export const JUPITER_RADIUS = 6.9911e7;

/** Semi-major axes, m */
export const EARTH_ORBIT = AU;
export const MOON_ORBIT = 3.844e8;

/**
 * Force softening length, m. Keeps 1/r² finite when two bodies pass arbitrarily
 * close, so a near-miss can't produce Infinity/NaN. 1 km is negligible against
 * any planetary separation.
 */
export const SOFTENING = 1e3;

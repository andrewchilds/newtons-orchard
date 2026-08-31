// A procedurally generated planetary system: one star, a handful of planets,
// and about as many moons. The layout follows the broad strokes of real
// systems — planets spaced on a rough geometric ladder, rock inside the frost
// line and giants beyond it, moons only where a planet's Hill sphere has room
// for one.
//
// Deterministic per seed, like every other builder: the menu item rolls a new
// seed on each click, but a given seed always builds the same system, so tests
// can assert against the output.

import { AU, DAY, EARTH_MASS, G, HOUR, SUN_MASS, SUN_RADIUS } from '../physics/constants';
import { habitableZone, type HabitableZone } from '../physics/habitableZone';
import { elementsToStateVector, orbitalPeriod, type StateVector } from '../physics/kepler';
import { vec3 } from '../physics/vec3';
import type { Body } from '../types';
import { logRange, mulberry32, pick, range } from './prng';
import { balanceMomentum, lockedFacing } from './solarSystem';

export interface RandomSystem {
  name: string;
  bodies: Body[];
}

export const PLANET_COUNT_MIN = 4;
export const PLANET_COUNT_MAX = 8;

/**
 * Moon periods are clamped to what the app's *default* timing grids can carry,
 * so the generated system needs no timing of its own: at 10 days a moon orbit
 * is 1440 integration steps and 40 trail points — comfortably above the
 * spiral-and-polygon regime the satellite preset's tightened grids exist to
 * escape — and past ~50 days a moon reads as a planet rather than a companion.
 */
export const MOON_PERIOD_MIN = 10 * DAY;
export const MOON_PERIOD_MAX = 50 * DAY;

/** Prograde orbits beyond roughly half the Hill radius are unstable. */
const HILL_FRACTION = 0.35;

const NAME_START = ['Ael', 'Arc', 'Cal', 'Dra', 'Ery', 'Kel', 'Ler', 'Mir', 'Nym', 'Or', 'Pho', 'Sel', 'Tau', 'Teg', 'Ver', 'Zen'] as const;
const NAME_MID = ['du', 'li', 'me', 'no', 'pe', 'ra', 'ri', 'sa', 'the', 'va'] as const;
const NAME_END = ['a', 'ar', 'dia', 'eus', 'ion', 'ith', 'on', 'os', 'ris', 'una'] as const;

type PlanetKind = 'rocky' | 'earthlike' | 'gas' | 'ice';

const PLANET_COLORS: Record<PlanetKind, readonly string[]> = {
  rocky: ['#b08a68', '#9c8b7d', '#c1652e', '#8d7f6a', '#caa46a'],
  earthlike: ['#4a7edb', '#3f8f7a', '#5a8fd0', '#4f9e8f'],
  gas: ['#d8a878', '#e3d3a0', '#c9995f', '#d9b98a'],
  ice: ['#93d7e8', '#4166c4', '#7f9ff0', '#63c4c9'],
};

const MOON_COLORS = ['#c8c6c0', '#a8a49c', '#bdb4a5', '#9aa0a8', '#d3cec2'] as const;
const RING_COLORS = ['#d9c9a3', '#c9bfa8', '#b8b4c0'] as const;

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] as const;

function starName(rand: () => number): string {
  const mid = rand() < 0.55 ? pick(rand, NAME_MID) : '';
  return pick(rand, NAME_START) + mid + pick(rand, NAME_END);
}

/** Blackbody-ish tint by mass: K dwarfs orange through F stars near-white. */
function starColor(relMass: number): string {
  if (relMass < 0.7) return '#ffb36b';
  if (relMass < 0.95) return '#ffcf7f';
  if (relMass < 1.2) return '#ffe3b0';
  return '#fff3dd';
}

function radiusFromDensity(mass: number, density: number): number {
  return Math.cbrt((3 * mass) / (4 * Math.PI * density));
}

/** Kepler III inverted: the semi-major axis that gives `period` around `parentMass`. */
function semiMajorFromPeriod(parentMass: number, period: number): number {
  return Math.cbrt((G * parentMass * period * period) / (4 * Math.PI * Math.PI));
}

function planetType(rand: () => number, a: number, frostLine: number, hz: HabitableZone): PlanetKind {
  if (a >= frostLine) {
    // Gas giants crowd the region just past the frost line, where the feeding
    // zone was richest; further out ice giants take over.
    if (a < 3 * frostLine) return rand() < 0.7 ? 'gas' : 'ice';
    return rand() < 0.75 ? 'ice' : 'gas';
  }
  const habitable = a > hz.inner && a < hz.outer;
  return habitable && rand() < 0.65 ? 'earthlike' : 'rocky';
}

function planetBulk(rand: () => number, type: PlanetKind): { mass: number; density: number } {
  switch (type) {
    case 'earthlike':
      return { mass: logRange(rand, 0.5, 2) * EARTH_MASS, density: range(rand, 5000, 5600) };
    case 'rocky':
      return { mass: logRange(rand, 0.05, 2) * EARTH_MASS, density: range(rand, 3900, 5600) };
    case 'gas':
      return { mass: logRange(rand, 40, 500) * EARTH_MASS, density: range(rand, 700, 1350) };
    default: // ice
      return { mass: logRange(rand, 6, 25) * EARTH_MASS, density: range(rand, 1300, 1700) };
  }
}

function planetAtmosphere(rand: () => number, type: PlanetKind): Body['atmosphere'] {
  if (type === 'earthlike') {
    return { color: pick(rand, ['#7fb2ff', '#8fc4e8', '#9ec9ff']), density: range(rand, 0.15, 0.35) };
  }
  if (type === 'ice') {
    return { color: pick(rand, ['#b8ecf7', '#7f9ff0', '#9fd4e8']), density: range(rand, 0.3, 0.5) };
  }
  if (type === 'rocky') {
    const roll = rand();
    // A few Venuses: dense enough that the swirled cloud deck hides the ground.
    if (roll < 0.15) {
      return { color: pick(rand, ['#f0d9a8', '#e8cf9a', '#dfc9ae']), density: range(rand, 0.85, 1) };
    }
    if (roll < 0.4) {
      return { color: pick(rand, ['#e8c8a0', '#f0d9a8', '#d8b090']), density: range(rand, 0.05, 0.3) };
    }
  }
  // Gas giants get none — as with the solar preset, the visible disk already
  // *is* the cloud tops, and a rim glow reads as a force field.
  return undefined;
}

interface PlacedPlanet {
  body: Body;
  a: number;
  state: StateVector;
  moonAs: number[];
}

export function randomSystem(seed: number): RandomSystem {
  const rand = mulberry32(seed);
  const name = starName(rand);

  const starMass = logRange(rand, 0.55, 1.5) * SUN_MASS;
  const relMass = starMass / SUN_MASS;
  // Main-sequence scalings: R ∝ M^0.8, L ∝ M^3.5. Crude, but they put the
  // frost line and the habitable zone where a star of this mass has them.
  const starRadius = SUN_RADIUS * relMass ** 0.8;
  const sqrtLum = Math.sqrt(relMass ** 3.5);

  const starState: StateVector = { position: vec3(), velocity: vec3() };
  const bodies: Body[] = [
    {
      id: crypto.randomUUID(),
      name,
      color: starColor(relMass),
      type: 'star',
      mass: starMass,
      radius: starRadius,
      rotationPeriod: range(rand, 15, 35) * DAY,
      axialTilt: range(rand, 0, 10),
      position: starState.position,
      velocity: starState.velocity,
    },
  ];

  const frostLine = 2.7 * sqrtLum * AU;
  const hz = habitableZone(starMass);
  const planetCount = PLANET_COUNT_MIN + Math.floor(rand() * (PLANET_COUNT_MAX - PLANET_COUNT_MIN + 1));
  const planets: PlacedPlanet[] = [];

  // A geometric ladder with jittered rungs — the shape of every real system's
  // spacing — anchored where a star of this brightness would keep warm rock.
  let a = range(rand, 0.3, 0.5) * sqrtLum * AU;
  for (let n = 0; n < planetCount; n++) {
    const type = planetType(rand, a, frostLine, hz);
    const { mass, density } = planetBulk(rand, type);
    const radius = radiusFromDensity(mass, density);

    const state = elementsToStateVector(
      starMass,
      starState,
      {
        a,
        e: range(rand, 0, 0.08),
        i: range(rand, -3.5, 3.5),
        lan: range(rand, 0, 360),
        argPeriapsis: range(rand, 0, 360),
        trueAnomaly: range(rand, 0, 360),
      },
      mass
    );

    const giant = type === 'gas' || type === 'ice';
    const body: Body = {
      id: crypto.randomUUID(),
      // Exoplanet convention: designations start at "b", ordered outward.
      name: `${name} ${String.fromCharCode(98 + n)}`,
      color: pick(rand, PLANET_COLORS[type]),
      type,
      mass,
      radius,
      rotationPeriod: giant ? range(rand, 9, 18) * HOUR : logRange(rand, 10 * HOUR, 10 * DAY),
      // Mostly modest obliquities, with the occasional Uranus.
      axialTilt: rand() < 0.08 ? range(rand, 85, 180) : range(rand, 0, 35),
      position: state.position,
      velocity: state.velocity,
      atmosphere: planetAtmosphere(rand, type),
      rings:
        type === 'gas' && rand() < 0.45
          ? {
              innerRadius: range(rand, 1.2, 1.5) * radius,
              outerRadius: range(rand, 1.9, 2.6) * radius,
              color: pick(rand, RING_COLORS),
              opacity: range(rand, 0.35, 0.65),
            }
          : undefined,
    };

    bodies.push(body);
    planets.push({ body, a, state, moonAs: [] });
    a *= range(rand, 1.5, 2.0);
  }

  placeMoons(rand, bodies, planets, starMass, frostLine);

  balanceMomentum(bodies, 0);
  return { name: `${name} System`, bodies };
}

/**
 * As many moons as planets — but only where one fits, so a system of tiny or
 * tightly packed planets may come up short.
 */
function placeMoons(
  rand: () => number,
  bodies: Body[],
  planets: PlacedPlanet[],
  starMass: number,
  frostLine: number
): void {
  const target = planets.length;
  // Weight by ∛mass: giants collect most of the moons, as in the real solar
  // system, without starving the terrestrials entirely.
  const weights = planets.map((p) => Math.cbrt(p.body.mass));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  let placed = 0;
  for (let attempt = 0; attempt < target * 6 && placed < target; attempt++) {
    let r = rand() * totalWeight;
    let planet = planets[planets.length - 1];
    for (let i = 0; i < planets.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        planet = planets[i];
        break;
      }
    }

    const rHill = planet.a * Math.cbrt(planet.body.mass / (3 * starMass));
    const aMin = Math.max(
      4 * planet.body.radius,
      semiMajorFromPeriod(planet.body.mass, MOON_PERIOD_MIN)
    );
    const aMax = Math.min(
      HILL_FRACTION * rHill,
      semiMajorFromPeriod(planet.body.mass, MOON_PERIOD_MAX)
    );
    if (aMin >= aMax) continue;

    const aMoon = logRange(rand, aMin, aMax);
    // Sibling moons keep off each other's orbits.
    if (planet.moonAs.some((other) => aMoon / other < 1.4 && other / aMoon < 1.4)) continue;

    const terrestrial = planet.body.type === 'rocky' || planet.body.type === 'earthlike';
    // Real satellite systems top out near 2.5e-4 of the primary (Titan); our
    // own Moon's 1.2e-2 is the freak, so only terrestrials get to roll one.
    const ratio = logRange(rand, 3e-5, terrestrial ? 1.2e-2 : 3e-4);
    const mass = ratio * planet.body.mass;
    const density = planet.a < frostLine ? range(rand, 3000, 3500) : range(rand, 1300, 1900);

    const state = elementsToStateVector(
      planet.body.mass,
      planet.state,
      {
        a: aMoon,
        e: range(rand, 0, 0.05),
        i: range(rand, -8, 8),
        lan: range(rand, 0, 360),
        argPeriapsis: range(rand, 0, 360),
        trueAnomaly: range(rand, 0, 360),
      },
      mass
    );

    planet.moonAs.push(aMoon);
    bodies.push({
      id: crypto.randomUUID(),
      name: `${planet.body.name} ${ROMAN[planet.moonAs.length - 1]}`,
      color: pick(rand, MOON_COLORS),
      type: 'moon',
      mass,
      radius: radiusFromDensity(mass, density),
      // Tidally locked, like almost every real moon. The two-body period is
      // percent-level off the mean month the sim integrates under the star's
      // perturbation (see the solar preset's Moon), so the locked face drifts
      // slowly — fine for a generated system nobody is measuring.
      rotationPeriod: orbitalPeriod(aMoon, planet.body.mass, mass),
      rotationPhase: lockedFacing(state.position, planet.state.position),
      axialTilt: range(rand, 0, 8),
      position: state.position,
      velocity: state.velocity,
    });
    placed++;
  }
}

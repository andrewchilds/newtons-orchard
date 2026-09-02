// Extra presets beyond the real solar system. Each shows off something a
// single star with planets doesn't: a moon system visible on a day of sim
// time, a hierarchy whose "parent" is two stars, a real seven-planet exoplanet
// system, a chaotic configuration sensitive to the integrator, an unstable
// Lagrange triangle threaded by a plunging planet, a stellar flyby that undoes
// a planetary system on camera, and two systems colliding into a binary that
// deals new fates every periapsis.

import { AU, DAY, EARTH_MASS, EARTH_RADIUS, G, HOUR, SUN_MASS, SUN_RADIUS } from "../physics/constants";
import { elementsToStateVector, orbitalPeriod, type StateVector } from "../physics/kepler";
import { vec3 } from "../physics/vec3";
import type { Body } from "../types";
import { balanceMomentum, solarSystem } from "./solarSystem";
import { defaultSystem } from "./defaultSystem";
import { ARTEMIS_II_TIMING, artemisII } from "./artemisII";
import { asteroidBelt, cometSwarm, planetesimalDisk, satelliteSwarm, SATELLITE_TIMING } from "./swarms";
import { blackHole, BLACK_HOLE_TIMING } from "./blackHole";
import { needlesEye, NEEDLES_EYE_TIMING } from "./needlesEye";
import { slingshotTwins, SLINGSHOT_TIMING } from "./slingshotTwins";

export interface Preset {
	id: string;
	name: string;
	description: string;
	build: () => Body[];
	/**
	 * Timing-grid overrides for orbits short compared to the app's
	 * planetary-scale defaults. The three grids fail differently: coarse `dt`
	 * integrates the orbit wrongly, coarse `snapshotInterval` makes scrubbing
	 * land between keyframes, coarse `trailInterval` draws chords across the
	 * orbit. A preset needing one usually needs all three (see
	 * `SATELLITE_TIMING`). Cost is linear in 1/dt, hence per-preset.
	 */
	timing?: PresetTiming;
	/**
	 * Shown locked until this many missions are complete. Presentation only —
	 * nothing stops the preset being built by other means, so the capture script
	 * still shoots it and thumbnails stay reproducible. Locked presets sort last.
	 */
	unlockAfterMissions?: number;
	/**
	 * How `scripts/preset-screenshots.py` photographs this one. Thumbnails are
	 * generated, so the framing lives next to the system it frames.
	 */
	shot?: PresetShot;
	/**
	 * View state to open with, for a preset whose subject would otherwise be
	 * lost in the default wide framing. Applied on load by
	 * `loadSystemIntoUi`, not by `build` — presets can't import UI state.
	 */
	view?: PresetView;
}

export interface PresetView {
	/** Body to focus (select + follow) on load, by name. */
	focus?: string;
	/** Body to set the view center (reference frame) to, by name. */
	center?: string;
	/** Radius exaggeration to open at, ×1–×2000. */
	exaggeration?: number;
	/** Trails around each body's orbit parent (the app default) or the view center. */
	parentRelativeTrails?: boolean;
	/** Camera distance from the focused body, metres. */
	zoom?: number;
}

/**
 * `dt` and `snapshotInterval` belong to the sim, `trailInterval` to the scene,
 * but all three describe the timescale this system lives on, so they travel
 * together.
 */
export interface PresetTiming {
	/** physics timestep, seconds */
	dt?: number;
	/** sim-time spacing between scrub keyframes, seconds */
	snapshotInterval?: number;
	/** sim-time spacing between trail points, seconds */
	trailInterval?: number;
}

export interface PresetShot {
	/**
	 * Sim-days to run before the shot. A system at t = 0 is a static dot field —
	 * trails need history to read as orbits — so each preset runs far enough to
	 * draw a recognisable fraction of its dominant orbit.
	 */
	days: number;
	/** The default ×50 leaves planets sub-pixel from a system-wide view. */
	exaggeration?: number;
	/** Trail history in sim-days. Defaults to `days`, so the trail spans what was played. */
	trailDays?: number;
	/** Body to center on. Omitted = barycenter. */
	center?: string;
	/**
	 * Camera distance from the view center, metres. The ~1.8 AU default suits an
	 * inner system and is useless for a 30 AU one or a 40 000 km satellite shell.
	 */
	zoom?: number;
	/**
	 * Trails around each body's orbit parent (the app default) or against the
	 * view center. Off where the "parent" is a pair rather than a point: a
	 * circumbinary planet drawn relative to one star traces a scalloped rosette
	 * instead of its own near-circular orbit.
	 */
	parentRelativeTrails?: boolean;
	/**
	 * Follows the app default (on) when omitted. Set false where the warp
	 * obscures the orbit geometry the card is meant to show.
	 */
	lensing?: boolean;
	/**
	 * Frame the subject from its sunlit side.
	 *
	 * The standard framing places the camera opposite the subject's orbit
	 * parent, which for a planet is the anti-sunward side — a photographic
	 * surface map then renders as a near-black disc against the ambient 0.12.
	 * Set this on any card whose subject is a planet's surface.
	 */
	sunward?: boolean;
}

/**
 * Real Io circles Jupiter in 1.77 days. The 600 s dt resolves that (~250 steps
 * per orbit) but the display grids don't: the live trail grid is 6 sim-hours
 * (a heptagon per lap) and a post-seek rebuild comes from the 1-sim-day
 * snapshot grid — barely two samples per lap, which is what thumbnails and
 * backward scrubs draw. ×4 on every semi-major axis lifts periods ×8 (Io to
 * 14 days). Uniform scaling preserves the 1:2:4 Laplace ratios exactly; masses,
 * radii, eccentricities and inclinations are the real ones.
 */
const GALILEAN_ORBIT_SCALE = 4;

/**
 * Real values. `trueAnomaly` doubles as mean longitude (lan and argPeriapsis
 * are zero); the first three are phased to satisfy the Laplace relation
 * λ_Io − 3λ_Europa + 2λ_Ganymede = 180°: 0 − 180 + 360 = 180. Callisto is
 * outside the resonance and takes the remaining quadrant.
 */
const GALILEAN_MOONS = [
	{ name: "Io", color: "#d9b64f", mass: 8.9319e22, radius: 1.8216e6, a: 4.217e8, e: 0.0041, i: 0.05, trueAnomaly: 0 },
	{
		name: "Europa",
		color: "#d6c6b2",
		mass: 4.7998e22,
		radius: 1.5608e6,
		a: 6.709e8,
		e: 0.009,
		i: 0.47,
		trueAnomaly: 60
	},
	{
		name: "Ganymede",
		color: "#9a8a78",
		mass: 1.4819e23,
		radius: 2.6341e6,
		a: 1.0704e9,
		e: 0.0013,
		i: 0.2,
		trueAnomaly: 180
	},
	{
		name: "Callisto",
		color: "#6f665c",
		mass: 1.0759e23,
		radius: 2.4103e6,
		a: 1.8827e9,
		e: 0.0074,
		i: 0.28,
		trueAnomaly: 270
	}
] as const;

/**
 * Jupiter and the four Galilean moons, with the Sun for light and honesty —
 * Jupiter's orbit is only correct in its company. Sun and Jupiter are lifted
 * from `solarSystem()` so their elements can't drift apart; the moons are
 * placed relative to Jupiter with μ = G(M_J + m). All four are tidally locked,
 * so rotation period equals the scaled orbital period.
 */
export function galileanMoons(): Body[] {
	const keep = new Set(["Sun", "Jupiter"]);
	const bodies = solarSystem().filter((b) => keep.has(b.name));
	const jupiter = bodies.find((b) => b.name === "Jupiter")!;
	const jupiterState: StateVector = { position: jupiter.position, velocity: jupiter.velocity };

	for (const spec of GALILEAN_MOONS) {
		const a = spec.a * GALILEAN_ORBIT_SCALE;
		const state = elementsToStateVector(
			jupiter.mass,
			jupiterState,
			{ a, e: spec.e, i: spec.i, lan: 0, argPeriapsis: 0, trueAnomaly: spec.trueAnomaly },
			spec.mass
		);
		bodies.push({
			id: crypto.randomUUID(),
			name: spec.name,
			color: spec.color,
			type: "moon",
			mass: spec.mass,
			radius: spec.radius,
			rotationPeriod: orbitalPeriod(a, jupiter.mass, spec.mass),
			axialTilt: 0,
			position: state.position,
			velocity: state.velocity
		});
	}

	// The Sun still carries recoil for the dropped planets, so re-balance
	// against what's actually here.
	balanceMomentum(bodies, 0);
	return bodies;
}

/**
 * Two sun-like stars in a tight mutual orbit with one planet circling both.
 *
 * The stars are placed about their common barycenter directly rather than one
 * "orbiting" the other: at a near-1:1 mass ratio neither is the parent.
 *
 * A circumbinary planet must sit well outside the pair or the binary's changing
 * pull ejects it. The critical radius is ~2–4× the separation; this puts the
 * planet at 8×, comfortably stable over any timescale scrubbed through. Its
 * velocity is computed against the binary's *total* mass, since from there the
 * pair looks like one body.
 */
export function binaryStars(): Body[] {
	const massA = SUN_MASS;
	const massB = 0.85 * SUN_MASS;
	const separation = 0.4 * AU;
	const total = massA + massB;

	// Distances from the barycenter are inversely proportional to mass.
	const rA = separation * (massB / total);
	const rB = separation * (massA / total);

	// Circular mutual orbit: relative speed v = sqrt(G·M_total / separation),
	// split between the two in the same inverse-mass proportion.
	const vRel = Math.sqrt((G * total) / separation);
	const vA = vRel * (massB / total);
	const vB = vRel * (massA / total);

	const bodies: Body[] = [
		{
			id: crypto.randomUUID(),
			name: "Alpha",
			color: "#ffe9a8",
			type: "star",
			mass: massA,
			radius: SUN_RADIUS,
			rotationPeriod: 25 * DAY,
			axialTilt: 5,
			position: vec3(rA, 0, 0),
			velocity: vec3(0, vA, 0)
		},
		{
			id: crypto.randomUUID(),
			name: "Beta",
			color: "#ff9f6b",
			type: "star",
			mass: massB,
			radius: 0.86 * SUN_RADIUS,
			rotationPeriod: 31 * DAY,
			axialTilt: 12,
			position: vec3(-rB, 0, 0),
			velocity: vec3(0, -vB, 0)
		}
	];

	// The planet orbits the pair's barycenter (the origin, by construction), so
	// it's placed against a stationary point mass of the combined stellar mass.
	const center: StateVector = { position: vec3(), velocity: vec3() };
	const planet = elementsToStateVector(
		total,
		center,
		{
			a: 8 * separation,
			e: 0.02,
			i: 1.5,
			lan: 0,
			argPeriapsis: 0,
			trueAnomaly: 0
		},
		EARTH_MASS
	);

	bodies.push({
		id: crypto.randomUUID(),
		name: "Tatooine",
		color: "#c88a5a",
		type: "rocky",
		mass: 1.4 * EARTH_MASS,
		radius: 1.12 * EARTH_RADIUS,
		rotationPeriod: 31 * HOUR,
		axialTilt: 18,
		position: planet.position,
		velocity: planet.velocity,
		atmosphere: { color: "#ffc98a", density: 0.3 }
	});

	balanceMomentum(bodies, 0);
	return bodies;
}

/**
 * Three equal masses on the Chenciner–Montgomery figure-eight orbit, chasing
 * each other around one closed curve.
 *
 * The initial conditions are the standard ones in units where G = m = 1, exact
 * enough that the orbit closes. Scaling to SI is the fiddly part: with lengths
 * scaled by L and masses by M, time scales as T = sqrt(L³ / (G·M)) and
 * velocities by L/T. A wrong exponent there doesn't look broken — it flies
 * apart after a few crossings — so the relation is written out below.
 *
 * The choreography is only marginally stable and drifts away eventually. That's
 * a property of the orbit, not a bug in the integrator.
 */
export function figureEight(): Body[] {
	const L = AU; // length unit
	const M = SUN_MASS; // mass unit
	const T = Math.sqrt((L * L * L) / (G * M)); // implied time unit
	const V = L / T; // implied velocity unit

	// Dimensionless figure-eight solution. Bodies 1 and 2 are mirror images;
	// body 3 sits at the origin moving to cancel their momentum exactly.
	const x = 0.97000436;
	const y = 0.24308753;
	const vx = 0.466203685;
	const vy = 0.43236573;

	const colors = ["#7fb2ff", "#ff9f9f", "#a8e6a0"];
	const positions = [vec3(x * L, -y * L, 0), vec3(-x * L, y * L, 0), vec3(0, 0, 0)];
	const velocities = [vec3(vx * V, vy * V, 0), vec3(vx * V, vy * V, 0), vec3(-2 * vx * V, -2 * vy * V, 0)];

	return positions.map((position, i) => ({
		id: crypto.randomUUID(),
		name: `Star ${String.fromCharCode(65 + i)}`,
		color: colors[i],
		type: "star" as const,
		mass: M,
		radius: SUN_RADIUS,
		rotationPeriod: 25 * DAY,
		axialTilt: 0,
		position,
		velocity: velocities[i]
	}));
}

/** TRAPPIST-1's stellar mass — an M8 dwarf, barely a star at all. */
const TRAPPIST_MASS = 0.0898 * SUN_MASS;

/**
 * Same reason as `GALILEAN_ORBIT_SCALE`: real planet b orbits in 1.51 days,
 * under both display grids' resolution. ×4 lifts the periods ×8 (b to 12 days,
 * h to 150) and preserves every period ratio, including the near-resonant chain
 * the system is famous for. Even at ×4 the system stays inside Mercury's orbit.
 */
const TRAPPIST_ORBIT_SCALE = 4;

/**
 * Real values (Agol et al. 2021): semi-major axis in AU, mass in Earth masses,
 * radius in Earth radii. Real eccentricities are all below 0.01 and mutual
 * inclinations are fractions of a degree, so circular coplanar is honest here.
 * Phases are spread by the golden angle so no two start aligned.
 *
 * The cold outer three are `dwarf`, not `ice`, deliberately: `ice` bodies grow
 * comet tails near a star (`CometTail` in `bodyEffects.ts`), and at a tenth of
 * an AU every planet here is deep inside the activity radius.
 */
const TRAPPIST_PLANETS = [
	{ name: "TRAPPIST-1 b", color: "#c98a5f", type: "rocky" as const, a: 0.01154, mass: 1.374, radius: 1.116 },
	{ name: "TRAPPIST-1 c", color: "#bd7a52", type: "rocky" as const, a: 0.0158, mass: 1.308, radius: 1.097 },
	{ name: "TRAPPIST-1 d", color: "#d0a06b", type: "rocky" as const, a: 0.02227, mass: 0.388, radius: 0.788 },
	{
		name: "TRAPPIST-1 e",
		color: "#5b8bd0",
		type: "earthlike" as const,
		a: 0.02925,
		mass: 0.692,
		radius: 0.92,
		atmosphere: { color: "#7fb2ff", density: 0.25 }
	},
	{ name: "TRAPPIST-1 f", color: "#9fc3d3", type: "dwarf" as const, a: 0.03849, mass: 1.039, radius: 1.045 },
	{ name: "TRAPPIST-1 g", color: "#b7d2de", type: "dwarf" as const, a: 0.04683, mass: 1.321, radius: 1.129 },
	{ name: "TRAPPIST-1 h", color: "#d3dee3", type: "dwarf" as const, a: 0.06189, mass: 0.326, radius: 0.755 }
] as const;

/**
 * Seven Earth-sized planets around a red dwarf a tenth the Sun's size. Every
 * planet is tidally locked (as the real ones are believed to be), so rotation
 * periods equal the scaled orbital periods. The star's radius is barely bigger
 * than Jupiter's, exercising the small end of the stellar exaggeration curve.
 */
export function trappist1(): Body[] {
	const starState: StateVector = { position: vec3(), velocity: vec3() };
	const bodies: Body[] = [
		{
			id: crypto.randomUUID(),
			name: "TRAPPIST-1",
			color: "#ff6f52",
			type: "star",
			mass: TRAPPIST_MASS,
			radius: 0.1192 * SUN_RADIUS,
			rotationPeriod: 3.3 * DAY,
			axialTilt: 0,
			position: starState.position,
			velocity: starState.velocity
		}
	];

	TRAPPIST_PLANETS.forEach((spec, n) => {
		const a = spec.a * AU * TRAPPIST_ORBIT_SCALE;
		const mass = spec.mass * EARTH_MASS;
		const state = elementsToStateVector(
			TRAPPIST_MASS,
			starState,
			{ a, e: 0, i: 0, lan: 0, argPeriapsis: 0, trueAnomaly: (n * 137.5) % 360 },
			mass
		);
		bodies.push({
			id: crypto.randomUUID(),
			name: spec.name,
			color: spec.color,
			type: spec.type,
			mass,
			radius: spec.radius * EARTH_RADIUS,
			rotationPeriod: orbitalPeriod(a, TRAPPIST_MASS, mass),
			axialTilt: 0,
			position: state.position,
			velocity: state.velocity,
			atmosphere: "atmosphere" in spec ? { ...spec.atmosphere } : undefined
		});
	});

	balanceMomentum(bodies, 0);
	return bodies;
}

/** Inside-out. Phases are fixed so the encounter plays out identically on every load. */
const ROGUE_PLANETS = [
	{
		name: "Ember",
		type: "rocky" as const,
		color: "#b0623f",
		mass: 0.6 * EARTH_MASS,
		radius: 0.85 * EARTH_RADIUS,
		rotationPeriod: 40 * HOUR,
		axialTilt: 12,
		a: 0.45,
		e: 0.02,
		i: 1.2,
		trueAnomaly: 40
	},
	{
		name: "Eden",
		type: "earthlike" as const,
		color: "#4a7edb",
		mass: 1.0 * EARTH_MASS,
		radius: EARTH_RADIUS,
		rotationPeriod: 22 * HOUR,
		axialTilt: 24,
		a: 0.85,
		e: 0.01,
		i: 0.4,
		trueAnomaly: 160,
		atmosphere: { color: "#7fb2ff", density: 0.25 }
	},
	{
		name: "Rust",
		type: "rocky" as const,
		color: "#a34f2a",
		mass: 0.35 * EARTH_MASS,
		radius: 0.72 * EARTH_RADIUS,
		rotationPeriod: 30 * HOUR,
		axialTilt: 18,
		a: 1.4,
		e: 0.04,
		i: 2.1,
		trueAnomaly: 280
	},
	{
		name: "Goliath",
		type: "gas" as const,
		color: "#d8a878",
		mass: 190 * EARTH_MASS,
		radius: 10.8 * EARTH_RADIUS,
		rotationPeriod: 11 * HOUR,
		axialTilt: 5,
		a: 2.4,
		e: 0.03,
		i: 1.0,
		trueAnomaly: 20,
		atmosphere: { color: "#f0d0a0", density: 0.4 }
	},
	{
		name: "Frost",
		type: "ice" as const,
		color: "#93d7e8",
		mass: 15 * EARTH_MASS,
		radius: 3.9 * EARTH_RADIUS,
		rotationPeriod: 15 * HOUR,
		axialTilt: 30,
		a: 3.8,
		e: 0.02,
		i: 1.6,
		trueAnomaly: 210,
		atmosphere: { color: "#b8ecf7", density: 0.4 }
	}
] as const;

/**
 * A sun-like star with five quiet planets, and a 0.8-solar-mass rogue star
 * falling through the system on a hyperbolic pass that leaves with a souvenir.
 *
 * Nemesis starts 21.8 AU out moving straight in at 20 km/s, over the 12.1 km/s
 * escape speed there, so the relative orbit is genuinely hyperbolic
 * (h = 6.9 AU · 20 km/s ⇒ e ≈ 1.71, r_p = h²/μ(1+e) ≈ 4.4 AU).
 *
 * Measured in the real `Simulation` at the production 600 s dt: perihelion is
 * 4.44 AU at day 1719 (year 4.7), and the two outer planets leave by opposite
 * mechanisms. Goliath is *captured* — Nemesis passes 0.19 AU from it and
 * carries it off as a moon, semi-major axis holding at ~2.1 AU out to year 300.
 * Frost is *ejected*, unbound from both stars by year 4 and outrunning even
 * Nemesis (425 AU vs 271 AU at year 80). Nothing merges. Ember, Eden and Rust
 * are spectators, still at 0.5, 0.9 and 1.6 AU at year 80.
 *
 * `balanceMomentum` would cancel net momentum by changing one body's velocity,
 * redesigning the encounter. `removeBarycentricDrift` shifts the frame instead,
 * preserving every relative velocity.
 */
export function rogueStarFlyby(): Body[] {
	const hearthState: StateVector = { position: vec3(), velocity: vec3() };
	const bodies: Body[] = [
		{
			id: crypto.randomUUID(),
			name: "Hearth",
			color: "#ffdb8f",
			type: "star",
			mass: SUN_MASS,
			radius: SUN_RADIUS,
			rotationPeriod: 24 * DAY,
			axialTilt: 4,
			position: hearthState.position,
			velocity: hearthState.velocity
		}
	];

	for (const spec of ROGUE_PLANETS) {
		const state = elementsToStateVector(
			SUN_MASS,
			hearthState,
			{ a: spec.a * AU, e: spec.e, i: spec.i, lan: 0, argPeriapsis: 0, trueAnomaly: spec.trueAnomaly },
			spec.mass
		);
		bodies.push({
			id: crypto.randomUUID(),
			name: spec.name,
			color: spec.color,
			type: spec.type,
			mass: spec.mass,
			radius: spec.radius,
			rotationPeriod: spec.rotationPeriod,
			axialTilt: spec.axialTilt,
			position: state.position,
			velocity: state.velocity,
			atmosphere: "atmosphere" in spec ? { ...spec.atmosphere } : undefined
		});
	}

	bodies.push({
		id: crypto.randomUUID(),
		name: "Nemesis",
		color: "#ff8a5c",
		type: "star",
		mass: 0.8 * SUN_MASS,
		radius: 6.97033e8,
		rotationPeriod: 30 * DAY,
		axialTilt: 15,
		position: vec3(3.09574e12, 1.03696e12, 0),
		velocity: vec3(-2e4, 0, 0)
	});

	removeBarycentricDrift(bodies);
	return bodies;
}

/**
 * Four planets apiece plus moons, cool tones around Castor, warm around Pollux.
 * Moons are circular and coplanar; their semi-major axes keep every period
 * above ~25 days (the display-grid floor the Galilean preset established) while
 * staying well inside the planet's Hill sphere.
 */
const COLLIDING_SYSTEMS = [
	{
		star: {
			name: "Castor",
			color: "#fff1b8",
			mass: SUN_MASS,
			radius: SUN_RADIUS,
			rotationPeriod: 26 * DAY,
			axialTilt: 3
		},
		planets: [
			{
				name: "Iris",
				type: "rocky" as const,
				color: "#8f9fd0",
				mass: 0.8 * EARTH_MASS,
				radius: 0.93 * EARTH_RADIUS,
				rotationPeriod: 27 * HOUR,
				axialTilt: 8,
				a: 0.5,
				e: 0.02,
				i: 0.8,
				trueAnomaly: 30
			},
			{
				name: "Pearl",
				type: "earthlike" as const,
				color: "#5f9edb",
				mass: 1.1 * EARTH_MASS,
				radius: 1.03 * EARTH_RADIUS,
				rotationPeriod: 25 * HOUR,
				axialTilt: 21,
				a: 0.95,
				e: 0.01,
				i: 0.3,
				trueAnomaly: 200,
				atmosphere: { color: "#7fb2ff", density: 0.25 },
				moons: [
					{
						name: "Opal",
						color: "#cfd6de",
						mass: 0.012 * EARTH_MASS,
						radius: 0.27 * EARTH_RADIUS,
						a: 4e8,
						trueAnomaly: 70
					}
				]
			},
			{
				name: "Atlas",
				type: "gas" as const,
				color: "#9bb8c9",
				mass: 120 * EARTH_MASS,
				radius: 9 * EARTH_RADIUS,
				rotationPeriod: 12 * HOUR,
				axialTilt: 10,
				a: 1.9,
				e: 0.03,
				i: 1.4,
				trueAnomaly: 300,
				atmosphere: { color: "#c4dcec", density: 0.4 },
				moons: [{ name: "Willow", color: "#b9c7ba", mass: 5e22, radius: 1.6e6, a: 3e9, trueAnomaly: 200 }]
			},
			{
				name: "Slate",
				type: "rocky" as const,
				color: "#7d8794",
				mass: 0.3 * EARTH_MASS,
				radius: 0.7 * EARTH_RADIUS,
				rotationPeriod: 41 * HOUR,
				axialTilt: 14,
				a: 2.4,
				e: 0.04,
				i: 2.3,
				trueAnomaly: 140
			}
		]
	},
	{
		star: {
			name: "Pollux",
			color: "#ffc98a",
			mass: 0.9 * SUN_MASS,
			radius: 0.93 * SUN_RADIUS,
			rotationPeriod: 29 * DAY,
			axialTilt: 9
		},
		planets: [
			{
				name: "Cinder",
				type: "rocky" as const,
				color: "#c26a3c",
				mass: 0.5 * EARTH_MASS,
				radius: 0.8 * EARTH_RADIUS,
				rotationPeriod: 35 * HOUR,
				axialTilt: 5,
				a: 0.45,
				e: 0.03,
				i: 1.1,
				trueAnomaly: 120
			},
			{
				name: "Saffron",
				type: "earthlike" as const,
				color: "#d8a04e",
				mass: 0.9 * EARTH_MASS,
				radius: 0.97 * EARTH_RADIUS,
				rotationPeriod: 30 * HOUR,
				axialTilt: 16,
				a: 0.85,
				e: 0.02,
				i: 0.6,
				trueAnomaly: 260,
				atmosphere: { color: "#f2c98a", density: 0.3 },
				moons: [
					{
						name: "Clove",
						color: "#b08a68",
						mass: 0.008 * EARTH_MASS,
						radius: 0.21 * EARTH_RADIUS,
						a: 3.5e8,
						trueAnomaly: 300
					}
				]
			},
			// `gas`, not `ice`, though it's a Neptune analog: `ice` bodies stream a
			// comet tail within 4 AU (`COMET_ACTIVITY_RADIUS`) and Juniper is at 1.7.
			{
				name: "Juniper",
				type: "gas" as const,
				color: "#a8dcd4",
				mass: 14 * EARTH_MASS,
				radius: 3.8 * EARTH_RADIUS,
				rotationPeriod: 16 * HOUR,
				axialTilt: 27,
				a: 1.7,
				e: 0.02,
				i: 1.9,
				trueAnomaly: 80,
				atmosphere: { color: "#c9efe9", density: 0.4 },
				moons: [{ name: "Bramble", color: "#9fb08d", mass: 1e22, radius: 1.2e6, a: 1e9, trueAnomaly: 150 }]
			},
			{
				name: "Sorrel",
				type: "dwarf" as const,
				color: "#c9a689",
				mass: 0.15 * EARTH_MASS,
				radius: 0.55 * EARTH_RADIUS,
				rotationPeriod: 50 * HOUR,
				axialTilt: 20,
				a: 2.2,
				e: 0.05,
				i: 1.5,
				trueAnomaly: 340
			}
		]
	}
] as const;

/**
 * Two whole planetary systems on a collision course. The stars swing through
 * each other's families of planets a year in, miss by a third of an AU, and
 * come out gravitationally locked: an eccentric ~14.5-year binary whose every
 * later periapsis reshuffles the survivors again.
 *
 * Geometry: the pair starts 6.2 AU apart closing at 17 km/s — about three
 * quarters of mutual escape speed, so the relative orbit is *bound* from the
 * start — with a 2 AU perpendicular offset setting the two-body periapsis at
 * ~0.36 AU, 40× the sum of the stellar radii. Separation and offset are split
 * in inverse mass proportion so the barycenter sits at the origin and stays.
 *
 * Measured in the real `Simulation` at the production 600 s dt: first periapsis
 * is day 425 at 0.36 AU, carrying Pollux through Castor's inner system and
 * swallowing Iris on the way (day 407). The stars settle into a ≈ 7.4 AU,
 * e ≈ 0.95 binary holding those elements through at least year 60, returning to
 * periapsis every ~14.5 years and dealing new fates each time: by year 30
 * Pollux has stolen Atlas and Castor has eaten Sorrel; by year 60 Atlas is back
 * with Castor, Willow has been stripped from it into a planet of its own, and
 * Pearl has been thrown clear entirely, keeping its moon Opal all the way out.
 *
 * As in `rogueStarFlyby`, `balanceMomentum` would redesign the encounter;
 * `removeBarycentricDrift` shifts the frame and preserves relative velocities.
 */
export function collidingSystems(): Body[] {
	const [specA, specB] = COLLIDING_SYSTEMS;
	const totalMass = specA.star.mass + specB.star.mass;
	const separation = 6.2 * AU;
	const approachSpeed = 1.7e4;
	const offset = 3.0e11;

	const bodies: Body[] = [];
	const starStates: StateVector[] = [
		{
			position: vec3((-separation * specB.star.mass) / totalMass, (-offset * specB.star.mass) / totalMass, 0),
			velocity: vec3((approachSpeed * specB.star.mass) / totalMass, 0, 0)
		},
		{
			position: vec3((separation * specA.star.mass) / totalMass, (offset * specA.star.mass) / totalMass, 0),
			velocity: vec3((-approachSpeed * specA.star.mass) / totalMass, 0, 0)
		}
	];

	COLLIDING_SYSTEMS.forEach((system, s) => {
		const starState = starStates[s];
		bodies.push({
			id: crypto.randomUUID(),
			...system.star,
			type: "star",
			position: starState.position,
			velocity: starState.velocity
		});
		for (const spec of system.planets) {
			const state = elementsToStateVector(
				system.star.mass,
				starState,
				{ a: spec.a * AU, e: spec.e, i: spec.i, lan: 0, argPeriapsis: 0, trueAnomaly: spec.trueAnomaly },
				spec.mass
			);
			bodies.push({
				id: crypto.randomUUID(),
				name: spec.name,
				color: spec.color,
				type: spec.type,
				mass: spec.mass,
				radius: spec.radius,
				rotationPeriod: spec.rotationPeriod,
				axialTilt: spec.axialTilt,
				position: state.position,
				velocity: state.velocity,
				atmosphere: "atmosphere" in spec ? { ...spec.atmosphere } : undefined
			});
			if (!("moons" in spec)) continue;
			for (const moon of spec.moons) {
				const moonState = elementsToStateVector(
					spec.mass,
					state,
					{ a: moon.a, e: 0, i: 0, lan: 0, argPeriapsis: 0, trueAnomaly: moon.trueAnomaly },
					moon.mass
				);
				bodies.push({
					id: crypto.randomUUID(),
					name: moon.name,
					color: moon.color,
					type: "moon",
					mass: moon.mass,
					radius: moon.radius,
					// Tidally locked, like every moon the app's other presets ship.
					rotationPeriod: orbitalPeriod(moon.a, spec.mass, moon.mass),
					axialTilt: 0,
					position: moonState.position,
					velocity: moonState.velocity
				});
			}
		}
	});

	removeBarycentricDrift(bodies);
	return bodies;
}

/**
 * Subtract the mass-weighted mean velocity from every body. Unlike
 * `balanceMomentum` this changes no relative velocity, which matters when the
 * system's whole design *is* a relative velocity — see `rogueStarFlyby`.
 */
function removeBarycentricDrift(bodies: Body[]): void {
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
	const vx = px / mass;
	const vy = py / mass;
	const vz = pz / mass;
	for (const b of bodies) {
		b.velocity = vec3(b.velocity.x - vx, b.velocity.y - vy, b.velocity.z - vz);
	}
}

/** Every preset the System menu offers, in menu order. */
export const PRESETS: Preset[] = [
	{
		id: "default",
		name: "Star & Planet",
		description: "A bare star with one Earth-like planet.",
		build: defaultSystem,
		shot: { days: 200, exaggeration: 600, zoom: 4.2e11 }
	},
	{
		id: "solar-system",
		name: "Solar System",
		description: "The Sun, eight planets, the Moon and five dwarf planets.",
		build: solarSystem,
		// Thirty years — one Saturn period. Less leaves the outer orbits as
		// unclosed arcs hanging off one side, lopsided at any camera placement.
		//
		// Framed on the planets, which deliberately crops the outer dwarfs: Eris
		// runs to 97 AU, and a zoom that closed its orbit would collapse all eight
		// planets into a single dot at the center. Pluto and the Kuiper trio are
		// for flying out to in the app, not for the card.
		shot: { days: 30 * 365, exaggeration: 1200, zoom: 2.9e12 }
	},
	{
		id: "galilean-moons",
		name: "Galilean Moons",
		description: "Jupiter's four great moons, phased in the 1:2:4 Laplace resonance.",
		build: galileanMoons,
		// Open following Jupiter — the default barycentric framing opens at the
		// Sun, with the whole Jovian system a dot. True scale, because at the
		// default ×20 Jupiter's drawn disc (~1.4e9 m) reaches most of the way to
		// Io's scaled orbit. The zoom holds Callisto's orbit in frame, same as
		// the card; a bare focus would frame Jupiter at 14 radii, a close-up
		// with every moon orbit outside it.
		view: { focus: "Jupiter", exaggeration: 1, zoom: 1.7e10 },
		// Callisto's scaled period is 134 days; less leaves the outer orbit an open
		// arc. Trails go against the view center, not the orbit parent: Jupiter's
		// parent-relative trail is its heliocentric arc, a stray line slashing
		// across the frame at this zoom.
		shot: { days: 135, exaggeration: 12, center: "Jupiter", zoom: 1.7e10, parentRelativeTrails: false }
	},
	{
		id: "artemis-ii",
		name: "Artemis II",
		description: "Orion's 2026 crewed lunar flyby.",
		build: artemisII,
		// All three grids live with the trajectory they were tuned against — the
		// preset's own `dt` is what resolves its 200 km perigee (see the module
		// comment on `artemisII`).
		timing: ARTEMIS_II_TIMING,
		// Open following the spacecraft, at true scale: at the default ×20 the
		// drawn Moon is ~3.4e7 m across — four times the 8.2e6 m flyby distance —
		// so Orion would spend pericynthion inside the Moon's own disc. The Earth
		// frame is the one where the free return draws a single continuous curve
		// (see the module comment on `artemisII`), with trails against that
		// center. The zoom holds the whole trajectory in frame — it reaches
		// ~4.1e8 m from Earth, the same span the card's shot frames.
		view: { focus: "Orion", center: "Earth", exaggeration: 1, parentRelativeTrails: false, zoom: 1.5e9 },
		// Eight days is the story minus its last hours: TLI, flyby, and the fall
		// home. Entry is day 8.02, and the merge takes Orion's trail with it, so
		// the shot stops just short. Framed on the lunar orbit rather than the
		// ecliptic — the trajectory fits in 450 000 km.
		shot: { days: 8, exaggeration: 6, center: "Earth", zoom: 1.5e9 }
	},
	{
		id: "slingshot-twins",
		name: "The Slingshot Twins",
		description: "Twin probes meet Jupiter days apart — one is flung past Saturn and out of the solar system, one falls back toward the Sun.",
		build: slingshotTwins,
		// Display grids tightened for the flybys the preset exists for; dt stays at
		// the default the encounters were measured against. See SLINGSHOT_TIMING.
		timing: SLINGSHOT_TIMING,
		// Open wide enough that Jupiter — the destination — is in frame from the
		// start; the default ~1.8 AU framing shows two dots leaving and nothing to
		// leave toward.
		view: { zoom: 2.3e12 },
		// Day 2400 is the full story: fork at Jupiter (day ~560), Daedalus past
		// its day-1184 Saturn crossing and off the frame edge (an escape outrunning
		// any fixed zoom is the point, so the frame holds Saturn's orbit and lets
		// him leave it), Icarus past its day-1955 perihelion with the sun-dive
		// hairpin drawn. Barycentric trails: during the flybys a probe's orbit
		// parent flips to Jupiter and back, which would chop the trail at its most
		// important turn.
		shot: { days: 2400, exaggeration: 1200, zoom: 2.8e12, parentRelativeTrails: false }
	},
	{
		id: "binary-stars",
		name: "Binary Stars",
		description: "Two stars orbiting each other, with a circumbinary planet.",
		build: binaryStars,
		// The planet's period is ~3.6 yr at 3.2 AU; one circuit also winds the
		// 0.4 AU pair many times, which is the shot.
		shot: { days: 3 * 365, exaggeration: 700, zoom: 1.35e12, parentRelativeTrails: false }
	},
	{
		id: "trappist-1",
		name: "TRAPPIST-1",
		description: "Seven Earth-sized planets packed around a cool red dwarf.",
		build: trappist1,
		// Planet h's scaled period is 150 days; a few days over closes its orbit.
		shot: { days: 155, exaggeration: 100, zoom: 8.5e10 }
	},
	{
		id: "figure-eight",
		name: "Figure Eight",
		description: "Three equal stars chasing each other around one closed curve.",
		build: figureEight,
		// The choreography's period is ~1 yr here; a bit over one lap draws the
		// whole eight without smearing it.
		shot: { days: 420, exaggeration: 300, zoom: 4.5e11 }
	},
	{
		id: "needles-eye",
		name: "The Needle's Eye",
		description: "Three suns on one orbit, and a planet threading the eye of their triangle.",
		build: needlesEye,
		// The towed planets orbit in ~6.3 days — see NEEDLES_EYE_TIMING.
		timing: NEEDLES_EYE_TIMING,
		// One ~122 d lap of the triangle. Barycentric trails: all three stars share
		// one circle, and Needle's vertical line has no orbit parent at all.
		shot: { days: 130, exaggeration: 300, zoom: 2.4e11, parentRelativeTrails: false }
	},
	{
		id: "rogue-star",
		name: "Rogue Star",
		description: "A passing star disrupts a solar system.",
		build: rogueStarFlyby,
		// Perihelion is year 4.7; day 2600 is far enough past that Goliath visibly
		// travels with Nemesis and Frost heads off alone, while the inner three
		// still draw closed orbits. Trails go against the home star so those inner
		// orbits read as circles rather than arcs of the departure.
		shot: { days: 2600, exaggeration: 800, center: "Hearth", zoom: 3e12, parentRelativeTrails: false }
	},
	{
		id: "colliding-systems",
		name: "Colliding Systems",
		description: "Two planetary systems crash through each other.",
		build: collidingSystems,
		// First periapsis is day 425; day 500 shows the approach, the whip through,
		// and the first fates dealt (Iris eaten by Pollux at day 407). Trails go
		// against the barycenter: two converging tracks with planet corkscrews
		// around them is the shot, and parent-relative trails would erase the
		// approach entirely.
		shot: { days: 500, exaggeration: 500, zoom: 1.2e12, parentRelativeTrails: false }
	},
	{
		id: "asteroid-belt",
		name: "Asteroid Belt",
		description: "Mars, Jupiter and ~80 asteroids — a body-count stress test.",
		build: asteroidBelt,
		shot: { days: 5 * 365, exaggeration: 1500, zoom: 1.5e12 }
	},
	{
		id: "comet-swarm",
		name: "Comet Swarm",
		description: "Dozens of comets diving past the Sun on eccentric orbits.",
		build: cometSwarm,
		shot: { days: 8 * 365, exaggeration: 1500, zoom: 1.2e12 }
	},
	{
		id: "planetesimal-disk",
		name: "Planetesimal Disk",
		description: "A forming system: ~90 planetesimals that scatter and merge.",
		build: planetesimalDisk,
		shot: { days: 3 * 365, exaggeration: 1500, zoom: 4.5e11 }
	},
	{
		id: "satellite-swarm",
		name: "Satellite Swarm",
		description:
			"Earth wrapped in 41 real spacecraft — the ISS, Hubble, all four nav constellations, a Molniya, TESS and the geostationary belt.",
		build: satelliteSwarm,
		// Real LEO/MEO/GEO altitudes: every grid has to be finer. See
		// `SATELLITE_TIMING`.
		timing: SATELLITE_TIMING,
		// TESS's apogee reaches ~3.8e8 m, but the structure worth photographing —
		// LEO, the nav shells, the GEO belt — is inside ~5e7 m, so the shot frames
		// that. Half a day is ~8 LEO revolutions and half a GEO circuit.
		//
		// Exaggeration stays modest despite the satellites being metres across: it
		// scales *drawn radius*, so past ~×1000 a 50 m spacecraft becomes 50 km
		// wide, the LEO ones exceed their own 400 km orbits, and the camera ends up
		// inside the meshes. The trails carry this shot.
		//
		// Trail length is cut to a few hours: at the full half-day the LEO shell
		// overdraws into a solid white ball that hides Earth entirely.
		shot: { days: 0.5, trailDays: 0.12, exaggeration: 60, center: "Earth", zoom: 8e7 }
	},
	// Last deliberately: the achievement unlock, which the picker sorts to the end.
	{
		id: "black-hole",
		name: "Black Hole",
		description: "Stars in relativistic orbits around a supermassive black hole.",
		build: blackHole,
		// Orbits of hours around a horizon ~17 Sun radii wide: every grid has to be
		// far finer than the planetary defaults. See `BLACK_HOLE_TIMING`.
		timing: BLACK_HOLE_TIMING,
		unlockAfterMissions: 3,
		// Two days is ~8 laps of S2's rosette and one circuit of the outer
		// reference ring, so precession and the quiet circle both read. S-Doomed is
		// long gone — the plunge is for live viewing.
		shot: { days: 2, exaggeration: 40, zoom: 2e12 }
	}
];

export function presetById(id: string): Preset | undefined {
	return PRESETS.find((p) => p.id === id);
}

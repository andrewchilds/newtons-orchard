// Lagrange's equilateral-triangle solution, fully loaded: three equal suns
// share one circular orbit, each towing a planet, while a lone planet —
// Needle — oscillates through the triangle's empty center on the z-axis.
// Promoted from the user-systems gallery.
//
// The configuration is famously unstable. Lagrange's triangle is only linearly
// stable when one mass carries ~96% of the system (m₁ > ~25·(m₂+m₃) — the
// Sun–Jupiter–Trojan regime); three *equal* suns sit as far onto the wrong
// side of that inequality as possible, so the balance is exact at t = 0 and
// doomed thereafter. Watching how many laps it survives is the preset.

import { DAY, EARTH_MASS, EARTH_RADIUS, G, SUN_MASS, SUN_RADIUS } from "../physics/constants";
import { vec3 } from "../physics/vec3";
import type { Body } from "../types";

/** Radius of the circle the three star–planet pair barycenters ride. */
const TRIANGLE_RADIUS = 6e10;

/** Each planet's orbit about its own sun. */
const PLANET_ORBIT = 1e10;

/** Needle's release height on the z-axis — also its oscillation amplitude. */
const NEEDLE_DROP = 6e10;

/**
 * The planets orbit their suns in ~6.3 days, far under the planetary-scale
 * defaults: the 6 h trail grid draws ~25-gons, and a post-seek rebuild from
 * the 1-day snapshot grid would leave ~6 points per lap. 2 h grids give ~75.
 */
export const NEEDLES_EYE_TIMING = {
	dt: 300,
	snapshotInterval: 7200,
	trailInterval: 7200
};

// The Fates: each sun spins its thread-planet, and Atropos — the one who cuts
// the thread — gets the shears. Exact unit vectors rather than cos/sin of
// 90°/210°/330°, so the symmetry the system lives on is bit-exact: the three
// tangents cancel to float rounding (no momentum balancing needed) and the
// xy pulls on Needle cancel the same way.
const PAIRS = [
	{
		star: { name: "Clotho", color: "#ffd27a" },
		planet: { name: "Spindle", color: "#d9a05a", type: "rocky" as const },
		out: { x: 0, y: 1 }
	},
	{
		star: { name: "Lachesis", color: "#a8c8ff" },
		planet: { name: "Loom", color: "#7ec8d9", type: "earthlike" as const },
		out: { x: -Math.sqrt(3) / 2, y: -0.5 }
	},
	{
		star: { name: "Atropos", color: "#ff8f66" },
		planet: { name: "Shears", color: "#c46a4a", type: "dwarf" as const },
		out: { x: Math.sqrt(3) / 2, y: -0.5 }
	}
] as const;

export function needlesEye(): Body[] {
	const pairMass = SUN_MASS + EARTH_MASS;

	// Each pair acts as a point mass at its barycenter. For three equal masses
	// M on a circle of radius R, the net pull on each — two neighbours at
	// √3·R, resolved along the radius — is G·M²/(√3·R²), so the circular rate
	// satisfies ω²R = G·M/(√3·R²).
	const vTriangle = Math.sqrt((G * pairMass) / (Math.sqrt(3) * TRIANGLE_RADIUS));
	const vPlanet = Math.sqrt((G * pairMass) / PLANET_ORBIT);

	const bodies: Body[] = [];
	for (const { star, planet, out } of PAIRS) {
		// Counter-clockwise tangent; the planet sits radially outward, so its
		// whole relative velocity is tangential too.
		const tx = -out.y;
		const ty = out.x;
		// Star and planet split position and velocity about the pair barycenter
		// in inverse mass proportion, so the pair's momentum is exactly
		// pairMass·vTriangle along the tangent — and the three tangents cancel.
		const starRadius = TRIANGLE_RADIUS - (PLANET_ORBIT * EARTH_MASS) / pairMass;
		const starSpeed = vTriangle - (vPlanet * EARTH_MASS) / pairMass;
		bodies.push(
			{
				id: crypto.randomUUID(),
				name: star.name,
				color: star.color,
				type: "star",
				mass: SUN_MASS,
				radius: SUN_RADIUS,
				rotationPeriod: 25 * DAY,
				axialTilt: 0,
				position: vec3(out.x * starRadius, out.y * starRadius, 0),
				velocity: vec3(tx * starSpeed, ty * starSpeed, 0)
			},
			{
				id: crypto.randomUUID(),
				name: planet.name,
				color: planet.color,
				type: planet.type,
				mass: EARTH_MASS,
				radius: EARTH_RADIUS,
				rotationPeriod: DAY,
				axialTilt: 0,
				position: vec3(out.x * (starRadius + PLANET_ORBIT), out.y * (starRadius + PLANET_ORBIT), 0),
				velocity: vec3(tx * (starSpeed + vPlanet), ty * (starSpeed + vPlanet), 0)
			}
		);
	}

	// Released at rest: the suns' xy pulls cancel by symmetry, so Needle falls
	// straight down the axis, threads the center, and climbs back out —
	// a plumb-line orbit through the eye, twice through center per ~80 days.
	bodies.push({
		id: crypto.randomUUID(),
		name: "Needle",
		color: "#e8f4ff",
		type: "earthlike",
		mass: EARTH_MASS,
		radius: EARTH_RADIUS,
		rotationPeriod: DAY,
		axialTilt: 0,
		position: vec3(0, 0, NEEDLE_DROP),
		velocity: vec3()
	});

	return bodies;
}

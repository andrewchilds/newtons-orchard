// Artemis II: Orion's crewed lunar flyby of April 2026, as a free return.
//
// Sun, Earth and Moon come straight out of `solarSystem()` so their masses,
// radii and elements can't drift from the real ones; everything mission-specific
// is in the probe's four numbers below.
//
// Scope: the flown mission was a *hybrid* free return — a day in a high-Earth
// checkout ellipse, then a TLI burn onto the trajectory proper. This sim has
// no notion of a burn, so the probe starts on its final coasting trajectory at
// t = 0 and never thrusts: the clock runs from TLI cutoff, through the flyby,
// to entry. The Earth-orbit checkout phase isn't here.
//
// Re-entry is modelled as the trajectory reaching Earth's collision radius —
// there is no atmosphere, so the merge that absorbs the probe at day ~8 stands
// in for the entry and splashdown. That demands a return perigee *below* the
// surface (a real skip entry at 122 km altitude would just swing back out),
// which the encounter itself supplies: the flyby both turns the probe around
// and lowers its perigee into the ground. No engine arranges any of it.
//
// Resolving a 200 km perigee is what the preset's own `dt` is for: the probe
// does ~10.9 km/s there, so at the app-default 600 s one step carries 6,300 km
// through the sharpest part of the turn — Verlet leaks energy and the probe
// leaves on a hyperbola. At 60 s (the satellite swarm's grid, which already
// resolves LEO at these speeds) the turn gets ~650 km steps and holds.
//
// The numbers came from sweeping perigee × apogee × lunar phase through the
// real `Simulation` at this preset's dt, keeping what matched the flown
// pericynthion and came home to entry.

import { DAY, EARTH_MASS, EARTH_RADIUS, MOON_ORBIT } from "../physics/constants";
import { elementsToStateVector, type StateVector } from "../physics/kepler";
import type { Body } from "../types";
import { balanceMomentum, lockedFacing, solarSystem } from "./solarSystem";

/**
 * The timing grids this trajectory is tuned and verified against. `dt` must
 * resolve the 200 km perigee (see the module comment); the display grids are
 * drawing resolution for a 10-day mission — at the default 6-hour trail
 * interval the hook around the Moon's far side draws as a chord, and a trail
 * rebuilt after any seek is only as fine as the snapshot grid, so the two move
 * together.
 */
export const ARTEMIS_II_TIMING = {
	dt: 60,
	snapshotInterval: 30 * 60,
	trailInterval: 30 * 60
};

/**
 * Perigee of Orion's post-TLI ellipse — 200 km up, carried through from the
 * checkout ellipse's flown 192 km perigee. Where the probe starts.
 */
const PROBE_PERIGEE = EARTH_RADIUS + 2.0e5;

/**
 * Apogee, as a multiple of the Moon's semi-major axis. Slightly beyond the Moon
 * so the probe is still climbing on arrival and crosses with speed to spare —
 * a flyby rather than a slow wallow through the L1 region. Among the factors
 * that match the flown pericynthion, this one lands the entry closest to the
 * flown timeline.
 */
const PROBE_APOGEE = 1.14 * MOON_ORBIT;

/**
 * Where the Moon starts, in degrees of true anomaly — the number pericynthion
 * altitude is most sensitive to. The probe takes ~3.9 days to climb to lunar
 * distance and the Moon covers ~50° in that time, so it's placed *short* of the
 * crossing point and arrives as the probe does. One degree moves the flyby
 * altitude by hundreds of km; 15° off and the probe flies past nothing.
 */
const MOON_PHASE = 126.102;

/** The probe shares the Moon's orbital plane, so the encounter is coplanar. */
const PROBE_INCLINATION = 5.145;

/**
 * Sun, Earth, Moon and Orion on the Artemis II free return.
 *
 * Measured against the real `Simulation` at `ARTEMIS_II_TIMING`, with the
 * flown figures alongside:
 *
 *   * pericynthion **6,511 km above the lunar surface** at **t ≈ 3.90 days**.
 *     Artemis II flew 6,513 km, so the sim is 0.03% out — the one number this
 *     preset is tuned to hit.
 *   * **entry at t ≈ 8.02 days**: the flyby turns the probe home with a perigee
 *     below the surface, and the merge with Earth is the splashdown. The real
 *     mission ran 9 d 1.5 h launch to splashdown with roughly a day of that in
 *     Earth orbit before TLI, so its TLI-relative timeline — flyby near day 4,
 *     entry near day 8 — is what this clock should match, and does.
 *   * never strays past **413,800 km** from Earth; Artemis II's record was
 *     406,771 km, 1.7% under that.
 *
 * Not modelled: the checkout orbit before TLI, the burns, and the atmosphere —
 * see the module comment.
 *
 * Best watched in the Earth reference frame, where outbound leg, hook around
 * the Moon's far side and return draw one continuous curve. The Sun is included
 * because the Moon's orbit is only correct in its company, but the action is
 * all within ~450,000 km of Earth, so the default framing is far too wide.
 */
export function artemisII(): Body[] {
	const keep = new Set(["Sun", "Earth", "Moon"]);
	const bodies = solarSystem().filter((b) => keep.has(b.name));

	const earth = bodies.find((b) => b.name === "Earth")!;
	const moon = bodies.find((b) => b.name === "Moon")!;
	const earthState: StateVector = { position: earth.position, velocity: earth.velocity };

	// Re-place the Moon at the phase the encounter needs. a, e, i and the node
	// stay as `solarSystem()` built them: the real Moon at a different point on
	// the same real orbit.
	const moonState = elementsToStateVector(
		EARTH_MASS,
		earthState,
		{
			a: MOON_ORBIT,
			e: 0.0549,
			i: 5.145,
			lan: 0,
			argPeriapsis: 0,
			trueAnomaly: MOON_PHASE
		},
		moon.mass
	);
	moon.position = moonState.position;
	moon.velocity = moonState.velocity;
	// The Moon moved along its orbit, so re-aim its tidally locked near side —
	// and re-pace it: the mean month the sim integrates depends on the Moon's
	// t = 0 phase against the Sun (see the roster Moon's comment), and at
	// MOON_PHASE it measures 27.7835 d against the roster's 27.0738 d. Keeping
	// the roster period here drifts the locked face by tens of degrees a year.
	moon.rotationPhase = lockedFacing(moonState.position, earthState.position);
	moon.rotationPeriod = 2400492;

	// The probe starts at perigee heading outbound, line of apsides along +x. The
	// Moon's phase is measured against that same reference, so the two are aimed
	// at each other by construction.
	const a = (PROBE_PERIGEE + PROBE_APOGEE) / 2;
	const e = (PROBE_APOGEE - PROBE_PERIGEE) / (PROBE_APOGEE + PROBE_PERIGEE);

	const probeState = elementsToStateVector(
		EARTH_MASS,
		earthState,
		{
			a,
			e,
			i: PROBE_INCLINATION,
			lan: 0,
			argPeriapsis: 0,
			trueAnomaly: 0
		},
		// A test particle: at 2.6e4 kg Orion is 1e-20 of Earth, so its mass in μ
		// would change the orbit by nothing.
		0
	);

	bodies.push({
		id: crypto.randomUUID(),
		name: "Orion",
		color: "#f2f4f8",
		type: "satellite",
		// Orion crew module + European Service Module at TLI, ~26.5 t.
		mass: 2.65e4,
		radius: 2.6, // 5.02 m service-module diameter
		// Passive thermal control: the "barbecue roll", ~one turn per 90 minutes.
		rotationPeriod: 90 * 60,
		axialTilt: 0,
		position: probeState.position,
		velocity: probeState.velocity
	});

	// The Sun still carries recoil for the dropped planets, so re-balance against
	// what's actually here.
	balanceMomentum(bodies, 0);
	return bodies;
}

/**
 * The measured trajectory, so the test asserts against the same numbers the doc
 * comment quotes. Times are seconds, distances metres.
 */
export const ARTEMIS_II_PROFILE = {
	flybyTime: 3.9 * DAY,
	/** From the Moon's center — the altitude figure plus the lunar radius. */
	flybyDistance: 8.249e6,
	/** When the merge with Earth — the sim's re-entry — fires. */
	entryTime: 8.018 * DAY
} as const;

/**
 * Pericynthion altitude Artemis II actually flew, m (6,513 km on 6 April 2026).
 * Kept separate from the measured figures above so the test asserts the sim
 * lands on the *mission*, not just on its own last run.
 */
export const ARTEMIS_II_FLOWN_ALTITUDE = 6.513e6;

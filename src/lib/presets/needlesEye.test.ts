import { describe, expect, it } from 'vitest';
import { needlesEye, NEEDLES_EYE_TIMING } from './needlesEye';
import { DAY } from '../physics/constants';
import { Simulation } from '../sim/simulation';

describe('needles eye', () => {
	const bodies = needlesEye();
	const stars = bodies.filter((b) => b.type === 'star');
	const needle = bodies.find((b) => b.name === 'Needle')!;

	it('is three equal suns, three towed planets and Needle, momentum-balanced by symmetry', () => {
		expect(stars).toHaveLength(3);
		expect(bodies).toHaveLength(7);
		expect(stars[0].mass).toBe(stars[1].mass);
		expect(stars[1].mass).toBe(stars[2].mass);

		// The construction claims the three tangents cancel exactly rather than
		// leaning on balanceMomentum — so hold it to float rounding, not the
		// looser bound a balanced-after-the-fact system gets.
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
		expect(Math.hypot(px, py, pz) / mass).toBeLessThan(1e-9);
	});

	it('starts the suns equidistant on one circle, an equilateral triangle apart', () => {
		const radii = stars.map((s) => Math.hypot(s.position.x, s.position.y, s.position.z));
		for (const r of radii) expect(r / radii[0]).toBeCloseTo(1, 12);
		const sep = (a: number, b: number) =>
			Math.hypot(
				stars[a].position.x - stars[b].position.x,
				stars[a].position.y - stars[b].position.y,
				stars[a].position.z - stars[b].position.z
			);
		expect(sep(0, 1) / sep(1, 2)).toBeCloseTo(1, 12);
		expect(sep(1, 2) / sep(2, 0)).toBeCloseTo(1, 12);
		expect(sep(0, 1) / radii[0]).toBeCloseTo(Math.sqrt(3), 9);
	});

	// The card's 130-day shot depends on the triangle still being a triangle —
	// the configuration is unstable, but its collapse must come well after the
	// spans anyone scrubs through, or the preset is just a scramble.
	it('holds the triangle through twice the card\'s 130-day shot', () => {
		const sim = new Simulation(bodies, NEEDLES_EYE_TIMING);
		sim.advanceTo(260 * DAY, Infinity);
		for (const s of stars) {
			const p = sim.positionOf(s.id)!;
			expect(Math.hypot(p.x, p.y, p.z) / 6e10, s.name).toBeCloseTo(1, 2);
		}
		expect(sim.merges).toHaveLength(0);
	});

	// The blurb's whole claim: Needle threads the exact center twice every
	// ~80 days on a plumb-line orbit. Measured at the preset's own dt: center
	// passes near days 21, 61, 101 and 141 (period ~80.4 d), with the xy drift
	// off the axis under a metre against a 6e10 m amplitude.
	it('plunges through the center twice per ~80 days without leaving the axis', () => {
		const sim = new Simulation(bodies, NEEDLES_EYE_TIMING);
		let prevZ = needle.position.z;
		let maxXY = 0;
		const crossings: number[] = [];
		for (let day = 1; day <= 161; day++) {
			sim.advanceTo(day * DAY, Infinity);
			const p = sim.positionOf(needle.id)!;
			if (Math.sign(p.z) !== Math.sign(prevZ)) crossings.push(day);
			prevZ = p.z;
			maxXY = Math.max(maxXY, Math.hypot(p.x, p.y));
		}
		expect(crossings).toHaveLength(4);
		[21, 61, 101, 141].forEach((expected, i) => {
			expect(Math.abs(crossings[i] - expected)).toBeLessThanOrEqual(2);
		});
		expect(maxXY).toBeLessThan(1);

		// Back near the release height after two full periods: an oscillation,
		// not a decaying capture by one of the suns.
		expect(Math.abs(prevZ) / 6e10).toBeGreaterThan(0.95);
	});
});

import { describe, expect, it } from 'vitest';
import { stateFromBodies, step } from '../physics/integrator';
import { parseSystemFile } from '../storage/persistence';
import raw from '../../../public/gallery/seed-still-point.json?raw';

// The seed-still-point gallery entry's whole point is that the planet at the
// barycenter of an exactly mirror-symmetric binary never moves — not
// approximately, but bit-for-bit, because IEEE arithmetic on mirrored inputs
// yields mirrored outputs and the pulls cancel exactly. That only holds while
// the checked-in JSON keeps the stars' masses equal and their positions and
// velocities exact negations; a well-meaning retouch of any digit breaks the
// cancellation and the planet drifts. This pins the claim in the real
// integrator at the file's own dt.

describe('seed-still-point gallery entry', () => {
	it('holds the planet bit-exact at rest through a year of integration', () => {
		const file = parseSystemFile(raw);
		const state = stateFromBodies(file.bodies);
		const dt = file.settings.dt;
		const steps = Math.round((365 * 86400) / dt); // ~5.6 orbits of the pair
		for (let s = 0; s < steps; s++) step(state, dt);

		// planet is index 2
		expect(state.pos[6]).toBe(0);
		expect(state.pos[7]).toBe(0);
		expect(state.pos[8]).toBe(0);
		expect(state.vel[6]).toBe(0);
		expect(state.vel[7]).toBe(0);
		expect(state.vel[8]).toBe(0);

		// The stars stay exact mirror images, and on their launch radius — the
		// blurb calls the orbit a circle, so hold it to one within ~0.03%.
		expect(state.pos[0]).toBe(-state.pos[3]);
		expect(state.pos[1]).toBe(-state.pos[4]);
		// z stays exactly zero for both — but as +0, which Object.is says isn't
		// the negation of +0, so the mirror-image form of this assertion fails.
		expect(Math.abs(state.pos[2])).toBe(0);
		expect(Math.abs(state.pos[5])).toBe(0);
		const r = Math.hypot(state.pos[0], state.pos[1], state.pos[2]);
		expect(r).toBeCloseTo(3e10, -7);
	});
});

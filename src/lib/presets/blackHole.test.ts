// The black hole preset's claims, measured in the real Simulation at the
// preset's own timing — the same way the rogue-star preset documents its
// encounter. These tests are what pin the tuned numbers in `COMPANIONS`:
// if a speed factor drifts, the failure names which promise broke.

import { describe, expect, it } from 'vitest';
import { Simulation } from '../sim/simulation';
import { stateFromBodies } from '../physics/integrator';
import { DAY, G, SOFTENING, schwarzschildRadius, SUN_MASS } from '../physics/constants';
import { blackHole, BLACK_HOLE_MASS, BLACK_HOLE_RS, BLACK_HOLE_TIMING } from './blackHole';
import type { Body } from '../types';

const findBody = (bodies: readonly Body[], name: string): Body => {
  const body = bodies.find((b) => b.name === name);
  if (!body) throw new Error(`missing body: ${name}`);
  return body;
};

/** Distance and bearing of body `id` from the hole at the sim's current time. */
function polarAround(sim: Simulation, holeId: string, id: string) {
  const hole = sim.positionOf(holeId);
  const body = sim.positionOf(id);
  if (!hole || !body) return null;
  const dx = body.x - hole.x;
  const dy = body.y - hole.y;
  return { r: Math.hypot(dx, dy, body.z - hole.z), theta: Math.atan2(dy, dx) };
}

describe('blackHole preset', () => {
  it('builds a horizon-sized hole and orbits inside the snapshot grid', () => {
    const bodies = blackHole();
    const hole = findBody(bodies, 'Sgr A*');

    expect(hole.type).toBe('blackhole');
    expect(hole.radius).toBeCloseTo(schwarzschildRadius(hole.mass), 6);
    // Everything must be resolved by the preset dt: the fastest star moves
    // well under a tenth of its orbital radius per step.
    for (const b of bodies) {
      if (b === hole) continue;
      const r = Math.hypot(b.position.x, b.position.y, b.position.z);
      const v = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z);
      expect((v * BLACK_HOLE_TIMING.dt) / r).toBeLessThan(0.1);
    }
  });

  it('gives S2 a precessing rosette, not a closed ellipse', () => {
    const bodies = blackHole();
    const holeId = findBody(bodies, 'Sgr A*').id;
    const s2 = findBody(bodies, 'S2').id;
    const sim = new Simulation(bodies, BLACK_HOLE_TIMING);

    // Walk step by step recording periapsis passages (local minima of r).
    const samples: { r: number; theta: number }[] = [];
    const periapses: { r: number; theta: number }[] = [];
    const dt = BLACK_HOLE_TIMING.dt;
    // ~3 orbital periods of ~6 h each.
    const steps = Math.ceil((0.8 * DAY) / dt);
    for (let k = 0; k < steps; k++) {
      sim.advanceTo((k + 1) * dt, Infinity);
      const p = polarAround(sim, holeId, s2);
      expect(p).not.toBeNull();
      samples.push(p!);
      const m = samples.length - 2;
      if (m >= 1 && samples[m].r < samples[m - 1].r && samples[m].r <= samples[m + 1].r) {
        periapses.push(samples[m]);
      }
    }

    expect(periapses.length).toBeGreaterThanOrEqual(2);
    for (const p of periapses) {
      // Bound, relativistic but outside the horizon.
      expect(p.r).toBeGreaterThan(2 * BLACK_HOLE_RS);
      expect(p.r).toBeLessThan(15 * BLACK_HOLE_RS);
    }
    // Periapsis bearing advances prograde by tens of degrees per orbit —
    // that's the rosette. A Newtonian ellipse would repeat within ~a degree.
    const advance =
      ((periapses[1].theta - periapses[0].theta) * 180) / Math.PI;
    const normalized = ((advance % 360) + 360) % 360;
    expect(normalized).toBeGreaterThan(15);
    expect(normalized).toBeLessThan(180);
  });

  it('feeds S-Doomed to the hole, growing the horizon', () => {
    const bodies = blackHole();
    const hole = findBody(bodies, 'Sgr A*');
    const sim = new Simulation(bodies, BLACK_HOLE_TIMING);

    sim.advanceTo(1 * DAY, Infinity);

    const merge = sim.merges.find((m) => m.absorbedName === 'S-Doomed');
    expect(merge).toBeDefined();
    expect(merge!.survivorName).toBe('Sgr A*');

    const holeIndex = sim.aliveIds.indexOf(hole.id);
    expect(holeIndex).toBeGreaterThanOrEqual(0);
    const grownMass = BLACK_HOLE_MASS + 8 * SUN_MASS;
    expect(sim.state.mass[holeIndex]).toBeCloseTo(grownMass, 3);
    // The horizon (and the collision radius, which is the same array) grew
    // linearly with the mass — not by summed volumes.
    expect(sim.state.rs[holeIndex]).toBeCloseTo(schwarzschildRadius(grownMass), 6);
    expect(sim.state.radius[holeIndex]).toBe(sim.state.rs[holeIndex]);
  });

  it('keeps S-Swift and S-Ring on stable near-circular orbits', () => {
    const bodies = blackHole();
    const holeId = findBody(bodies, 'Sgr A*').id;
    const sim = new Simulation(bodies, BLACK_HOLE_TIMING);

    const initial = {
      swift: polarAround(sim, holeId, findBody(bodies, 'S-Swift').id)!.r,
      ring: polarAround(sim, holeId, findBody(bodies, 'S-Ring').id)!.r,
    };

    sim.advanceTo(4 * DAY, Infinity);

    const swift = polarAround(sim, holeId, findBody(bodies, 'S-Swift').id);
    const ring = polarAround(sim, holeId, findBody(bodies, 'S-Ring').id);
    expect(swift).not.toBeNull();
    expect(ring).not.toBeNull();
    // Circular under the PW force: the radius holds to a few percent across
    // dozens of laps (S-Swift alone does ~48 of them in these four days).
    expect(swift!.r).toBeGreaterThan(0.9 * initial.swift);
    expect(swift!.r).toBeLessThan(1.1 * initial.swift);
    expect(ring!.r).toBeGreaterThan(0.95 * initial.ring);
    expect(ring!.r).toBeLessThan(1.05 * initial.ring);
  });

  it('replays bit-for-bit across a seek, merge included', () => {
    const sim = new Simulation(blackHole(), BLACK_HOLE_TIMING);

    sim.advanceTo(1.5 * DAY, Infinity);
    const pos = sim.state.pos.slice();
    const rs = sim.state.rs.slice();
    const mergeCount = sim.merges.length;

    sim.seek(0, Infinity);
    sim.seek(1.5 * DAY, Infinity);

    expect(sim.state.pos).toEqual(pos);
    expect(sim.state.rs).toEqual(rs);
    expect(sim.merges.length).toBe(mergeCount);
  });
});

describe('Paczyński–Wiita force', () => {
  it('pulls with G·m/(d − r_s)² on pairs involving a black hole', () => {
    const hole: Body = {
      id: 'hole',
      name: 'hole',
      color: '#000',
      type: 'blackhole',
      mass: BLACK_HOLE_MASS,
      radius: BLACK_HOLE_RS,
      rotationPeriod: 0,
      axialTilt: 0,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    };
    const d = 10 * BLACK_HOLE_RS;
    const star: Body = {
      ...hole,
      id: 'star',
      name: 'star',
      type: 'star',
      mass: SUN_MASS,
      radius: 7e8,
      position: { x: d, y: 0, z: 0 },
    };

    const state = stateFromBodies([hole, star]);
    // The star's pull toward the hole. The softened d and the clamp are both
    // negligible at 10 r_s, so this matches the closed form to float noise.
    const expected = (G * BLACK_HOLE_MASS) / (d - BLACK_HOLE_RS) ** 2;
    expect(-state.acc[3]).toBeCloseTo(expected, 6);
    expect((-state.acc[3] - expected) / expected).toBeLessThan(1e-6);
    // Momentum conservation: equal and opposite forces.
    expect(state.mass[0] * state.acc[0]).toBeCloseTo(-state.mass[1] * state.acc[3], 6);
  });

  it('stays finite inside the horizon', () => {
    const bodies = blackHole();
    const hole = findBody(bodies, 'Sgr A*');
    const probe: Body = {
      ...findBody(bodies, 'S2'),
      // Inside r_s: the shifted denominator would be negative without the
      // clamp. The force must stay finite (a merge is already queued by then).
      position: { x: 0.5 * BLACK_HOLE_RS, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    };
    const state = stateFromBodies([hole, probe]);
    expect(Number.isFinite(state.acc[3])).toBe(true);
    // Clamped to the softening floor: enormous but bounded.
    const bound = (G * hole.mass) / SOFTENING ** 2;
    expect(Math.abs(state.acc[3])).toBeLessThanOrEqual(bound);
  });

  it('leaves ordinary pairs exactly Newtonian', () => {
    const bodies = blackHole().filter((b) => b.type !== 'blackhole');
    const state = stateFromBodies(bodies);
    // No black hole in the state → every rs is 0 → the classic softened form.
    const [a, b] = bodies;
    const dx = b.position.x - a.position.x;
    const dy = b.position.y - a.position.y;
    const distSq = dx * dx + dy * dy + SOFTENING * SOFTENING;
    const f = (G * b.mass) / distSq / Math.sqrt(distSq);
    const expectedAx = dx * f;
    // Other stars also pull on `a`; subtract just the pair term is overkill —
    // instead check the two-body case in isolation.
    const pair = stateFromBodies([a, b]);
    expect(pair.acc[0]).toBeCloseTo(expectedAx, 10);
  });
});

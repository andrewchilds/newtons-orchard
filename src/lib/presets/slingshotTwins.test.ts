import { describe, expect, it } from 'vitest';
import { AU, DAY, G, SUN_MASS } from '../physics/constants';
import { stateFromBodies, step } from '../physics/integrator';
import { Simulation } from '../sim/simulation';
import { SLINGSHOT_TIMING, slingshotTwins } from './slingshotTwins';
import type { Body } from '../types';

// The preset's whole design is a measured set of encounter outcomes (see the
// module doc): Icarus passes ahead of Jupiter and is braked into a sun-diving
// orbit; Daedalus passes behind, crosses Saturn's bow and is ejected. All of
// it lives on a knife's edge — fractions of a degree of launch phase swap the
// fates or lose the Saturn pass — so this pins the story at the preset's own
// dt rather than trusting the numbers in the source to keep meaning what they
// meant.

const MU_SUN = G * SUN_MASS;

function specificEnergy(state: ReturnType<typeof stateFromBodies>, i: number, sunIdx: number): number {
  const i3 = i * 3;
  const s3 = sunIdx * 3;
  const r = Math.hypot(
    state.pos[i3] - state.pos[s3],
    state.pos[i3 + 1] - state.pos[s3 + 1],
    state.pos[i3 + 2] - state.pos[s3 + 2]
  );
  const v = Math.hypot(
    state.vel[i3] - state.vel[s3],
    state.vel[i3 + 1] - state.vel[s3 + 1],
    state.vel[i3 + 2] - state.vel[s3 + 2]
  );
  return (v * v) / 2 - MU_SUN / r;
}

function netMomentumSpeed(bodies: Body[]): number {
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
  return Math.hypot(px, py, pz) / mass;
}

describe('slingshot twins', () => {
  const bodies = slingshotTwins();

  it('is the eight planets plus two probes, momentum balanced', () => {
    expect(bodies.map((b) => b.name).sort()).toEqual(
      [
        'Sun',
        'Mercury',
        'Venus',
        'Earth',
        'Mars',
        'Jupiter',
        'Saturn',
        'Uranus',
        'Neptune',
        'Icarus',
        'Daedalus',
      ].sort()
    );
    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-3);
  });

  it('builds the twins identical and on one shared orbit', () => {
    const icarus = bodies.find((b) => b.name === 'Icarus')!;
    const daedalus = bodies.find((b) => b.name === 'Daedalus')!;
    expect(icarus.mass).toBe(daedalus.mass);
    expect(icarus.radius).toBe(daedalus.radius);
    expect(icarus.type).toBe('satellite');
    expect(daedalus.type).toBe('satellite');

    // Same orbit = same specific energy and same angular momentum vector,
    // which also pins the (tilted) plane they share.
    const sun = bodies[0];
    const orbit = (p: Body) => {
      const rx = p.position.x - sun.position.x;
      const ry = p.position.y - sun.position.y;
      const rz = p.position.z - sun.position.z;
      const vx = p.velocity.x - sun.velocity.x;
      const vy = p.velocity.y - sun.velocity.y;
      const vz = p.velocity.z - sun.velocity.z;
      const r = Math.hypot(rx, ry, rz);
      const v = Math.hypot(vx, vy, vz);
      const h = [ry * vz - rz * vy, rz * vx - rx * vz, rx * vy - ry * vx];
      return { energy: (v * v) / 2 - MU_SUN / r, h };
    };
    // Not exact: `balanceMomentum` nudges the Sun ~1 m/s after the probes are
    // placed against it, which shifts each probe's Sun-relative state by a
    // direction-dependent hair.
    const a = orbit(icarus);
    const b = orbit(daedalus);
    expect(a.energy / b.energy).toBeCloseTo(1, 3);
    const dot =
      (a.h[0] * b.h[0] + a.h[1] * b.h[1] + a.h[2] * b.h[2]) /
      (Math.hypot(...a.h) * Math.hypot(...b.h));
    expect(dot).toBeGreaterThan(1 - 1e-6);
  });

  // One integration serves every scenario assertion below: both flyby
  // geometries, both fates, and both second encounters.
  const state = stateFromBodies(bodies);
  const sunIdx = 0;
  const jupiterIdx = bodies.findIndex((b) => b.name === 'Jupiter');
  const saturnIdx = bodies.findIndex((b) => b.name === 'Saturn');
  const icarusIdx = bodies.findIndex((b) => b.name === 'Icarus');
  const daedalusIdx = bodies.findIndex((b) => b.name === 'Daedalus');

  const dt = SLINGSHOT_TIMING.dt;
  const days = 2920;
  const track = {
    icarus: { minJup: Infinity, jupDay: 0, ahead: 0, minSun: Infinity, sunDay: 0 },
    daedalus: { minJup: Infinity, jupDay: 0, ahead: 0, minSat: Infinity, satDay: 0 },
  };
  let energyIcarus900 = NaN;
  let energyDaedalus900 = NaN;

  const closest = (state2: ReturnType<typeof stateFromBodies>, a: number, b: number) => {
    const a3 = a * 3;
    const b3 = b * 3;
    return Math.hypot(
      state2.pos[a3] - state2.pos[b3],
      state2.pos[a3 + 1] - state2.pos[b3 + 1],
      state2.pos[a3 + 2] - state2.pos[b3 + 2]
    );
  };

  for (let s = 0; s < Math.round((days * DAY) / dt); s++) {
    step(state, dt);
    const day = (s * dt) / DAY;

    for (const [key, idx] of [
      ['icarus', icarusIdx],
      ['daedalus', daedalusIdx],
    ] as const) {
      const t = track[key];
      const dJup = closest(state, idx, jupiterIdx);
      if (dJup < t.minJup) {
        t.minJup = dJup;
        t.jupDay = day;
        const i3 = idx * 3;
        const j3 = jupiterIdx * 3;
        const jv = Math.hypot(state.vel[j3], state.vel[j3 + 1], state.vel[j3 + 2]);
        t.ahead =
          ((state.pos[i3] - state.pos[j3]) * state.vel[j3] +
            (state.pos[i3 + 1] - state.pos[j3 + 1]) * state.vel[j3 + 1] +
            (state.pos[i3 + 2] - state.pos[j3 + 2]) * state.vel[j3 + 2]) /
          jv;
      }
    }

    // Second encounters only mean anything after the Jupiter fork.
    if (day > 700) {
      const dSat = closest(state, daedalusIdx, saturnIdx);
      if (dSat < track.daedalus.minSat) {
        track.daedalus.minSat = dSat;
        track.daedalus.satDay = day;
      }
      const dSun = closest(state, icarusIdx, sunIdx);
      if (dSun < track.icarus.minSun) {
        track.icarus.minSun = dSun;
        track.icarus.sunDay = day;
      }
    }

    if (day <= 900) {
      energyIcarus900 = specificEnergy(state, icarusIdx, sunIdx);
      energyDaedalus900 = specificEnergy(state, daedalusIdx, sunIdx);
    }
  }

  it('flies Icarus ahead of Jupiter and Daedalus behind, days apart', () => {
    expect(track.icarus.jupDay).toBeGreaterThan(550);
    expect(track.icarus.jupDay).toBeLessThan(568);
    expect(track.daedalus.jupDay).toBeGreaterThan(track.icarus.jupDay + 1);
    expect(track.daedalus.jupDay).toBeLessThan(570);
    // Opposite sides of the planet, along its direction of motion — the whole
    // mechanism of the preset.
    expect(track.icarus.ahead).toBeGreaterThan(0);
    expect(track.daedalus.ahead).toBeLessThan(0);
  });

  it('keeps both flybys inside the resolvable corridor', () => {
    // Under ~1e9 m the 600 s steps stop resolving the turn (and Jupiter's
    // surface is at 7.1e7); over ~3e9 the assist goes soft and neither fate
    // happens. The corridor is the design.
    for (const t of Object.values(track)) {
      expect(t.minJup).toBeGreaterThan(1e9);
      expect(t.minJup).toBeLessThan(3e9);
    }
  });

  it('brakes Icarus into a sun-diving orbit', () => {
    expect(energyIcarus900).toBeLessThan(0);
    // Perihelion 0.102 AU on day ~1955 — a third of Mercury's perihelion, and
    // 22 solar radii clear of the Sun itself.
    expect(track.icarus.minSun).toBeGreaterThan(0.07 * AU);
    expect(track.icarus.minSun).toBeLessThan(0.14 * AU);
    expect(track.icarus.sunDay).toBeGreaterThan(1850);
    expect(track.icarus.sunDay).toBeLessThan(2060);
  });

  it('slings Daedalus across Saturn’s bow and out of the solar system', () => {
    expect(energyDaedalus900).toBeGreaterThan(0);
    // The Saturn pass: 3.2e9 m, 54 Saturn radii — closer in planet radii than
    // the Jupiter flyby that aimed it, but far enough to only nudge the exit.
    expect(track.daedalus.minSat).toBeGreaterThan(1.5e9);
    expect(track.daedalus.minSat).toBeLessThan(8e9);
    expect(track.daedalus.satDay).toBeGreaterThan(1150);
    expect(track.daedalus.satDay).toBeLessThan(1220);

    const i3 = daedalusIdx * 3;
    const s3 = sunIdx * 3;
    const r = Math.hypot(
      state.pos[i3] - state.pos[s3],
      state.pos[i3 + 1] - state.pos[s3 + 1],
      state.pos[i3 + 2] - state.pos[s3 + 2]
    );
    const v = Math.hypot(
      state.vel[i3] - state.vel[s3],
      state.vel[i3 + 1] - state.vel[s3 + 1],
      state.vel[i3 + 2] - state.vel[s3 + 2]
    );
    // Measured: ~21 AU at year 8, still 25% over the local escape speed. Not
    // "a big orbit" — gone.
    expect(r).toBeGreaterThan(19 * AU);
    expect(v).toBeGreaterThan(1.15 * Math.sqrt((2 * MU_SUN) / r));
  });

  it('merges nothing through all three flybys in the real Simulation', () => {
    const roster = slingshotTwins();
    const sim = new Simulation(roster, SLINGSHOT_TIMING);
    sim.advanceTo(1250 * DAY, Infinity);
    expect(sim.merges).toHaveLength(0);
    for (const name of ['Icarus', 'Daedalus']) {
      const probe = roster.find((b) => b.name === name)!;
      expect(sim.positionOf(probe.id), name).not.toBeNull();
    }
  });
});

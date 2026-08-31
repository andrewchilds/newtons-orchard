import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  binaryStars,
  collidingSystems,
  figureEight,
  galileanMoons,
  presetById,
  rogueStarFlyby,
  trappist1,
} from './examples';
import { AU, DAY, YEAR } from '../physics/constants';
import { orbitalPeriod } from '../physics/kepler';
import { MAX_EXAGGERATION, MIN_EXAGGERATION } from '../state/ui.svelte';
import { Simulation } from '../sim/simulation';
import { totalEnergy, totalMomentum } from '../physics/diagnostics';
import type { Body } from '../types';

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

describe('preset registry', () => {
  it('every preset builds a non-empty, valid roster', () => {
    for (const preset of PRESETS) {
      const bodies = preset.build();
      expect(bodies.length).toBeGreaterThan(0);
      for (const b of bodies) {
        expect(b.mass).toBeGreaterThan(0);
        expect(b.radius).toBeGreaterThan(0);
        expect(Number.isFinite(b.position.x + b.position.y + b.position.z)).toBe(true);
        expect(Number.isFinite(b.velocity.x + b.velocity.y + b.velocity.z)).toBe(true);
      }
      expect(new Set(bodies.map((b) => b.id)).size).toBe(bodies.length);
    }
  });

  it('has unique preset ids and finds them by id', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(presetById('solar-system')?.name).toBe('Solar System');
    expect(presetById('nope')).toBeUndefined();
  });

  it('builds a fresh roster each call, so loading twice cannot share ids', () => {
    const a = PRESETS[1].build();
    const b = PRESETS[1].build();
    expect(a[0].id).not.toBe(b[0].id);
  });

  // The thumbnails in the "Load a system" dialog are generated from these by
  // `npm run preset-screenshots`. A bad shot config doesn't fail loudly there —
  // it produces an empty or misframed image that has to be spotted by eye — so
  // the parts that can be checked mechanically are checked here.
  describe('screenshot configs', () => {
    it('gives every preset a shot config, so no card falls back to a placeholder', () => {
      for (const preset of PRESETS) {
        expect(preset.shot, `${preset.id} has no shot config`).toBeDefined();
      }
    });

    it('runs each shot forward a positive, finite span with a sane camera', () => {
      for (const preset of PRESETS) {
        const shot = preset.shot!;
        expect(shot.days, preset.id).toBeGreaterThan(0);
        expect(Number.isFinite(shot.days), preset.id).toBe(true);
        if (shot.exaggeration !== undefined) {
          expect(shot.exaggeration, preset.id).toBeGreaterThanOrEqual(MIN_EXAGGERATION);
          expect(shot.exaggeration, preset.id).toBeLessThanOrEqual(MAX_EXAGGERATION);
        }
        if (shot.trailDays !== undefined) expect(shot.trailDays, preset.id).toBeGreaterThan(0);
        if (shot.zoom !== undefined) expect(shot.zoom, preset.id).toBeGreaterThan(0);
      }
    });

    // The one config error that produces a *blank* thumbnail rather than a
    // badly framed one: `center` is matched against body names at capture time,
    // so renaming a body in a preset silently breaks its shot.
    it('centers only on bodies its preset actually builds', () => {
      for (const preset of PRESETS) {
        const center = preset.shot?.center;
        if (center === undefined) continue;
        const names = preset.build().map((b) => b.name);
        expect(names, `${preset.id} centers on missing body "${center}"`).toContain(center);
      }
    });

    // Like `shot.center`, `view.focus` and `view.center` are matched against
    // body names at load time, so renaming a body would silently open the
    // preset unfocused or on the barycenter.
    it('opens focused and centered only on bodies its preset actually builds', () => {
      for (const preset of PRESETS) {
        const view = preset.view;
        if (view === undefined) continue;
        const names = preset.build().map((b) => b.name);
        if (view.focus !== undefined) {
          expect(names, `${preset.id} focuses missing body "${view.focus}"`).toContain(view.focus);
        }
        if (view.center !== undefined) {
          expect(names, `${preset.id} centers on missing body "${view.center}"`).toContain(
            view.center
          );
        }
        if (view.exaggeration !== undefined) {
          expect(view.exaggeration, preset.id).toBeGreaterThanOrEqual(MIN_EXAGGERATION);
          expect(view.exaggeration, preset.id).toBeLessThanOrEqual(MAX_EXAGGERATION);
        }
        if (view.zoom !== undefined) expect(view.zoom, preset.id).toBeGreaterThan(0);
      }
    });

    // Trails are drawn from the history that was integrated; a window longer
    // than the run just pads it with nothing, and one much shorter throws away
    // the orbit the run was long enough to draw.
    it('never asks for more trail history than the shot integrates', () => {
      for (const preset of PRESETS) {
        const shot = preset.shot!;
        if (shot.trailDays === undefined) continue;
        expect(shot.trailDays, preset.id).toBeLessThanOrEqual(shot.days);
      }
    });
  });
});

describe('galilean moons', () => {
  const bodies = galileanMoons();
  const jupiter = bodies.find((b) => b.name === 'Jupiter')!;
  const moons = bodies.filter((b) => b.type === 'moon');

  it('keeps Sun and Jupiter and adds the four moons', () => {
    expect(bodies.map((b) => b.name).sort()).toEqual(
      ['Callisto', 'Europa', 'Ganymede', 'Io', 'Jupiter', 'Sun'].sort()
    );
  });

  // Cutting planets out of a balanced system leaves the Sun holding a recoil
  // for bodies that are no longer there.
  it('re-balances momentum after dropping the other planets', () => {
    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-3);
  });

  // The uniform orbit scaling must preserve the resonance the preset is named
  // for: consecutive period ratios of ~2 (Io:Europa:Ganymede = 1:2:4).
  it('preserves the Laplace period ratios through the orbit scaling', () => {
    const period = (name: string) => {
      const moon = moons.find((m) => m.name === name)!;
      const r = Math.hypot(
        moon.position.x - jupiter.position.x,
        moon.position.y - jupiter.position.y,
        moon.position.z - jupiter.position.z
      );
      // e ≤ 0.009 for all of them, so current distance ≈ a to well under the
      // 2% the ratio check allows.
      return orbitalPeriod(r, jupiter.mass, moon.mass);
    };
    expect(period('Europa') / period('Io')).toBeCloseTo(2.0, 1);
    expect(period('Ganymede') / period('Europa')).toBeCloseTo(2.0, 1);
  });

  it('keeps every moon on its orbit for 100 days', () => {
    const sim = new Simulation(bodies);
    const start = new Map(
      moons.map((m) => [
        m.id,
        Math.hypot(
          m.position.x - jupiter.position.x,
          m.position.y - jupiter.position.y,
          m.position.z - jupiter.position.z
        ),
      ])
    );

    sim.advanceTo(100 * DAY, Infinity);

    const jPos = sim.positionOf(jupiter.id)!;
    for (const m of moons) {
      const pos = sim.positionOf(m.id);
      expect(pos, m.name).not.toBeNull();
      const r = Math.hypot(pos!.x - jPos.x, pos!.y - jPos.y, pos!.z - jPos.z);
      // Near-circular orbits: still at the same distance, not spiralling.
      expect(r / start.get(m.id)!, m.name).toBeGreaterThan(0.9);
      expect(r / start.get(m.id)!, m.name).toBeLessThan(1.1);
    }
    expect(sim.merges).toHaveLength(0);
  });
});

describe('trappist-1', () => {
  const bodies = trappist1();
  const star = bodies[0];
  const planets = bodies.slice(1);

  it('is one small star and seven planets', () => {
    expect(star.type).toBe('star');
    expect(planets).toHaveLength(7);
    for (const p of planets) expect(p.type).not.toBe('star');
    // An M8 dwarf: an order of magnitude lighter than the Sun, but still the
    // overwhelming mass of its system.
    expect(star.mass / planets.reduce((s, p) => s + p.mass, 0)).toBeGreaterThan(1e3);
  });

  it('has zero net momentum', () => {
    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-3);
  });

  it('orders the planets b through h outward', () => {
    const distances = planets.map((p) =>
      Math.hypot(p.position.x - star.position.x, p.position.y - star.position.y, p.position.z - star.position.z)
    );
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThan(distances[i - 1]);
    }
  });

  it('keeps all seven on circular orbits for 60 days', () => {
    const sim = new Simulation(bodies);
    const start = planets.map((p) =>
      Math.hypot(p.position.x - star.position.x, p.position.y - star.position.y, p.position.z - star.position.z)
    );

    sim.advanceTo(60 * DAY, Infinity);

    const sPos = sim.positionOf(star.id)!;
    planets.forEach((p, i) => {
      const pos = sim.positionOf(p.id);
      expect(pos, p.name).not.toBeNull();
      const r = Math.hypot(pos!.x - sPos.x, pos!.y - sPos.y, pos!.z - sPos.z);
      expect(r / start[i], p.name).toBeGreaterThan(0.95);
      expect(r / start[i], p.name).toBeLessThan(1.05);
    });
    expect(sim.merges).toHaveLength(0);
  });
});

describe('rogue star flyby', () => {
  const bodies = rogueStarFlyby();
  const hearth = bodies.find((b) => b.name === 'Hearth')!;
  const nemesis = bodies.find((b) => b.name === 'Nemesis')!;

  it('is two stars and five planets with zero net momentum', () => {
    expect(bodies.filter((b) => b.type === 'star')).toHaveLength(2);
    expect(bodies.filter((b) => b.type !== 'star')).toHaveLength(5);
    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-3);
  });

  it('sends the intruder in unbound', () => {
    const G = 6.6743e-11;
    const mu = G * (hearth.mass + nemesis.mass);
    const rx = nemesis.position.x - hearth.position.x;
    const ry = nemesis.position.y - hearth.position.y;
    const rz = nemesis.position.z - hearth.position.z;
    const vx = nemesis.velocity.x - hearth.velocity.x;
    const vy = nemesis.velocity.y - hearth.velocity.y;
    const vz = nemesis.velocity.z - hearth.velocity.z;
    const r = Math.hypot(rx, ry, rz);
    const energy = (vx * vx + vy * vy + vz * vz) / 2 - mu / r;
    expect(energy).toBeGreaterThan(0);
    expect(r / AU).toBeCloseTo(21.8, 1);

    // Hyperbolic, with a perihelion out among the giants rather than inside
    // the inner planets — the encounter is a grazing pass, not a plunge.
    const h = Math.hypot(ry * vz - rz * vy, rz * vx - rx * vz, rx * vy - ry * vx);
    const e = Math.sqrt(1 + (2 * energy * h * h) / (mu * mu));
    expect(e).toBeGreaterThan(1);
    expect(((h * h) / mu / (1 + e) / AU)).toBeCloseTo(4.4, 1);
  });

  // The encounter the preset's doc comment describes, asserted at the same
  // production dt: perihelion 4.44 AU at year 4.7, after which Goliath leaves
  // as Nemesis's moon and Frost leaves bound to nothing at all.
  it('captures Goliath onto Nemesis and ejects Frost outright', () => {
    const G = 6.6743e-11;
    const sim = new Simulation(bodies);
    const byName = (name: string) => bodies.find((b) => b.name === name)!.id;
    const massOf = (name: string) => bodies.find((b) => b.name === name)!.mass;
    const distFrom = (a: string, b: string) => {
      const p = sim.positionOf(a)!;
      const q = sim.positionOf(b)!;
      return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    };
    // Two-body energy and semi-major axis of `name` relative to `primary`,
    // read out of the live physics state.
    const relTo = (name: string, primary: string) => {
      const s = sim.cloneState();
      const i = sim.aliveIds.indexOf(byName(name)) * 3;
      const j = sim.aliveIds.indexOf(byName(primary)) * 3;
      const r = Math.hypot(s.pos[i] - s.pos[j], s.pos[i + 1] - s.pos[j + 1], s.pos[i + 2] - s.pos[j + 2]);
      const vSq =
        (s.vel[i] - s.vel[j]) ** 2 + (s.vel[i + 1] - s.vel[j + 1]) ** 2 + (s.vel[i + 2] - s.vel[j + 2]) ** 2;
      const mu = G * massOf(primary);
      const energy = vSq / 2 - mu / r;
      return { energy, a: energy < 0 ? -mu / (2 * energy) : Infinity };
    };

    sim.advanceTo(80 * YEAR, Infinity);

    // Goliath is Nemesis's moon now, on a real orbit a couple of AU across,
    // and both are hundreds of AU from where they started.
    const goliath = relTo('Goliath', 'Nemesis');
    expect(goliath.energy).toBeLessThan(0);
    expect(goliath.a / AU).toBeCloseTo(2.1, 0);
    expect(distFrom(byName('Goliath'), hearth.id) / AU).toBeGreaterThan(200);

    // Frost is bound to neither star and is outrunning Nemesis.
    expect(relTo('Frost', 'Hearth').energy).toBeGreaterThan(0);
    expect(relTo('Frost', 'Nemesis').energy).toBeGreaterThan(0);
    expect(distFrom(byName('Frost'), hearth.id)).toBeGreaterThan(distFrom(nemesis.id, hearth.id));

    // The inner three never left home.
    expect(distFrom(byName('Ember'), hearth.id) / AU).toBeCloseTo(0.45, 0);
    expect(distFrom(byName('Eden'), hearth.id) / AU).toBeCloseTo(0.85, 0);
    expect(distFrom(byName('Rust'), hearth.id) / AU).toBeCloseTo(1.5, 0);
    for (const name of ['Ember', 'Eden', 'Rust']) {
      expect(relTo(name, 'Hearth').energy, name).toBeLessThan(0);
    }

    // Goliath's 0.19 AU pass is the closest approach anywhere in the system.
    expect(sim.merges).toHaveLength(0);

    // The capture is durable, not a momentary reading near the encounter: the
    // orbit is still the same size 70 years later.
    sim.advanceTo(150 * YEAR, Infinity);
    const late = relTo('Goliath', 'Nemesis');
    expect(late.energy).toBeLessThan(0);
    expect(late.a / AU).toBeCloseTo(2.1, 0);
  });
});

describe('colliding systems', () => {
  const bodies = collidingSystems();
  const castor = bodies.find((b) => b.name === 'Castor')!;
  const pollux = bodies.find((b) => b.name === 'Pollux')!;

  it('is two stars, eight planets and four moons with zero net momentum', () => {
    expect(bodies.filter((b) => b.type === 'star')).toHaveLength(2);
    expect(bodies.filter((b) => b.type === 'moon')).toHaveLength(4);
    expect(bodies.filter((b) => b.type !== 'star' && b.type !== 'moon')).toHaveLength(8);
    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-3);
  });

  it('starts the stars on a closing course that is bound from the outset', () => {
    const G = 6.6743e-11;
    const rx = pollux.position.x - castor.position.x;
    const ry = pollux.position.y - castor.position.y;
    const rz = pollux.position.z - castor.position.z;
    const vx = pollux.velocity.x - castor.velocity.x;
    const vy = pollux.velocity.y - castor.velocity.y;
    const vz = pollux.velocity.z - castor.velocity.z;
    const r = Math.hypot(rx, ry, rz);
    // Approaching, at roughly the designed 17 km/s...
    const radialSpeed = (rx * vx + ry * vy + rz * vz) / r;
    expect(radialSpeed).toBeLessThan(-1.5e4);
    // ...but below escape speed: the capture is guaranteed by the initial
    // conditions, not won in the scramble.
    const mu = G * (castor.mass + pollux.mass);
    expect((vx * vx + vy * vy + vz * vz) / 2 - mu / r).toBeLessThan(0);
  });

  // The encounter the preset's doc comment describes, asserted at the same
  // production dt: a 0.36 AU miss at day 425, one planet eaten on the way
  // through, and a durable eccentric binary afterward.
  it('grazes at day 425 and locks the stars into a ~14.5-year binary', () => {
    const G = 6.6743e-11;
    const sim = new Simulation(bodies);

    // Daily sampling over the approach and pass: closest approach lands near
    // day 425 at ~0.36 AU — a near miss, never a stellar contact.
    let minSep = Infinity;
    let minSepDay = 0;
    for (let day = 1; day <= 2 * 365; day++) {
      sim.advanceTo(day * DAY, Infinity);
      const p = sim.positionOf(castor.id)!;
      const q = sim.positionOf(pollux.id)!;
      const sep = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      if (sep < minSep) {
        minSep = sep;
        minSepDay = day;
      }
    }
    expect(minSepDay).toBeGreaterThan(400);
    expect(minSepDay).toBeLessThan(450);
    expect(minSep / AU).toBeCloseTo(0.36, 1);

    // Pollux ploughs through Castor's inner system on that pass and swallows
    // Iris; the stars themselves never merge.
    sim.advanceTo(10 * YEAR, Infinity);
    expect(sim.merges).toHaveLength(1);
    expect(sim.merges[0].survivorName).toBe('Pollux');
    expect(sim.merges[0].absorbedName).toBe('Iris');
    expect(sim.merges[0].t / DAY).toBeCloseTo(407.4, 0);

    // The stars leave the encounter as a bound pair on a stable eccentric
    // orbit — the elements here still hold at year 60.
    const state = sim.cloneState();
    const i = sim.aliveIds.indexOf(castor.id);
    const j = sim.aliveIds.indexOf(pollux.id);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThanOrEqual(0);
    const r = Math.hypot(
      state.pos[i * 3] - state.pos[j * 3],
      state.pos[i * 3 + 1] - state.pos[j * 3 + 1],
      state.pos[i * 3 + 2] - state.pos[j * 3 + 2]
    );
    const vSq =
      (state.vel[i * 3] - state.vel[j * 3]) ** 2 +
      (state.vel[i * 3 + 1] - state.vel[j * 3 + 1]) ** 2 +
      (state.vel[i * 3 + 2] - state.vel[j * 3 + 2]) ** 2;
    const mu = G * (state.mass[i] + state.mass[j]);
    const energy = vSq / 2 - mu / r;
    expect(energy).toBeLessThan(0);
    const a = -mu / (2 * energy);
    expect(a / AU).toBeCloseTo(7.4, 0);
    const period = 2 * Math.PI * Math.sqrt(a ** 3 / mu);
    expect(period / YEAR).toBeCloseTo(14.5, 0);

    // Pearl is on its way out of the system entirely — and its moon Opal is
    // still riding along.
    const pearl = bodies.find((b) => b.name === 'Pearl')!;
    const opal = bodies.find((b) => b.name === 'Opal')!;
    const pi = sim.aliveIds.indexOf(pearl.id);
    const oi = sim.aliveIds.indexOf(opal.id);
    expect(pi).toBeGreaterThanOrEqual(0);
    expect(oi).toBeGreaterThanOrEqual(0);
    const mr = Math.hypot(
      state.pos[oi * 3] - state.pos[pi * 3],
      state.pos[oi * 3 + 1] - state.pos[pi * 3 + 1],
      state.pos[oi * 3 + 2] - state.pos[pi * 3 + 2]
    );
    const mvSq =
      (state.vel[oi * 3] - state.vel[pi * 3]) ** 2 +
      (state.vel[oi * 3 + 1] - state.vel[pi * 3 + 1]) ** 2 +
      (state.vel[oi * 3 + 2] - state.vel[pi * 3 + 2]) ** 2;
    expect(mvSq / 2 - (G * pearl.mass) / mr).toBeLessThan(0);
  });
});

describe('binary stars', () => {
  const bodies = binaryStars();

  it('has two stars and a planet', () => {
    expect(bodies.filter((b) => b.type === 'star')).toHaveLength(2);
    expect(bodies.filter((b) => b.type !== 'star')).toHaveLength(1);
  });

  it('has zero net momentum', () => {
    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-3);
  });

  it('places the planet well outside the binary, where it can be stable', () => {
    const [a, b, planet] = bodies;
    const separation = Math.hypot(
      a.position.x - b.position.x,
      a.position.y - b.position.y,
      a.position.z - b.position.z
    );
    const planetRadius = Math.hypot(planet.position.x, planet.position.y, planet.position.z);
    // Critical radius for a circumbinary orbit is ~2–4× the separation.
    expect(planetRadius / separation).toBeGreaterThan(4);
  });

  it('keeps the planet bound for a decade of sim time', () => {
    const sim = new Simulation(bodies);
    const planetId = bodies[2].id;

    sim.advanceTo(10 * YEAR, Infinity);

    const pos = sim.positionOf(planetId);
    expect(pos).not.toBeNull();
    const r = Math.hypot(pos!.x, pos!.y, pos!.z);
    // Still in the same neighbourhood — not flung out, not swallowed.
    expect(r / AU).toBeGreaterThan(1);
    expect(r / AU).toBeLessThan(10);
    expect(sim.merges).toHaveLength(0);
  });
});

describe('figure eight', () => {
  const bodies = figureEight();

  it('is three equal masses with zero net momentum', () => {
    expect(bodies).toHaveLength(3);
    expect(bodies[0].mass).toBe(bodies[1].mass);
    expect(bodies[1].mass).toBe(bodies[2].mass);
    expect(netMomentumSpeed(bodies)).toBeLessThan(1e-9);
  });

  it('starts with the third body at the origin, mirroring the other two', () => {
    expect(bodies[2].position).toEqual({ x: 0, y: 0, z: 0 });
    expect(bodies[0].position.x).toBeCloseTo(-bodies[1].position.x, 6);
    expect(bodies[0].position.y).toBeCloseTo(-bodies[1].position.y, 6);
  });

  // The choreography is a closed orbit: after one period every body is back
  // where it started. The dimensionless period is 6.3259, scaled by the same
  // T = sqrt(L³/GM) the velocities were scaled by — which makes this a check on
  // that scaling as much as on the initial conditions.
  it('returns all three bodies to their starting positions after one period', () => {
    const sim = new Simulation(bodies, { dt: 600 });
    const G = 6.6743e-11;
    const T = Math.sqrt((AU * AU * AU) / (G * bodies[0].mass));
    const period = 6.32591398 * T;

    sim.advanceTo(period, Infinity);

    for (const b of bodies) {
      const now = sim.positionOf(b.id);
      expect(now).not.toBeNull();
      const drift = Math.hypot(now!.x - b.position.x, now!.y - b.position.y, now!.z - b.position.z);
      expect(drift / AU).toBeLessThan(0.05);
    }
  });

  it('conserves energy over a period, as a symplectic integrator should', () => {
    const sim = new Simulation(bodies, { dt: 600 });
    const before = totalEnergy(sim.state);
    sim.advanceTo(200 * DAY, Infinity);
    const after = totalEnergy(sim.state);
    expect(Math.abs((after - before) / before)).toBeLessThan(1e-6);
  });

  it('holds its barycenter still', () => {
    const sim = new Simulation(bodies, { dt: 600 });
    sim.advanceTo(200 * DAY, Infinity);

    // Momentum in kg·m/s across three solar masses is a huge number even when
    // nothing is moving, so the meaningful quantity is the barycenter's *drift
    // speed* — p/M. Verlet conserves it to float rounding (~1e-10 m/s here).
    const p = totalMomentum(sim.state);
    const totalMass = bodies.reduce((sum, b) => sum + b.mass, 0);
    expect(Math.hypot(p.x, p.y, p.z) / totalMass).toBeLessThan(1e-6);
  });
});

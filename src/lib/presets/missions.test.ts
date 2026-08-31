import { describe, expect, it } from 'vitest';
import { MISSIONS, choiceLetter, missionById, type Mission } from './missions';
import { presetById } from './examples';
import { solarSystem } from './solarSystem';
import { Simulation } from '../sim/simulation';
import { circularVelocityAt, stateVectorToElements } from '../physics/kepler';
import { AU, DAY, G, schwarzschildRadius } from '../physics/constants';
import { loadSystem, rosterAtCurrentTime } from '../state/system.svelte';
import { sim } from '../state/simInstance';
import { seekTo } from '../state/time.svelte';
import { applySetup } from '../ui/capture';
import type { Body } from '../types';

/**
 * Reproduce what the capture hook does to shoot a mission card: load the built
 * system, pre-roll it, then make the mission's edit on the live result.
 *
 * The ordering is the whole point of these tests, so this mirrors `settleShot`
 * rather than calling the setup on a bare roster — a setup that read the t = 0
 * roster instead of live state would look fine in isolation and be wrong here.
 *
 * Returns the roster as it stands at the shutter, positions and velocities
 * rebased to the shot's own time (`rosterAtCurrentTime`, the same snapshot the
 * app's edit path takes).
 */
function shootMission(mission: Mission, { skipSetup = false } = {}): Body[] {
  loadSystem(mission.build(), mission.name, mission.timing ?? {});
  seekTo(sim, mission.shot.days * DAY);
  if (!skipSetup && mission.setup) applySetup(`mission ${mission.id}`, mission.setup);
  return rosterAtCurrentTime();
}

/** Velocities alone, keyed by name — the signature a mass or type edit leaves untouched. */
function velocityKey(bodies: Body[]): string {
  return JSON.stringify(
    bodies
      .map((b) => [b.name, b.velocity.x, b.velocity.y, b.velocity.z])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  );
}

describe('mission registry', () => {
  it('every mission builds a non-empty, valid roster', () => {
    for (const mission of MISSIONS) {
      const bodies = mission.build();
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

  it('has unique mission ids and finds them by id', () => {
    expect(new Set(MISSIONS.map((m) => m.id)).size).toBe(MISSIONS.length);
    expect(missionById('half-a-sun')?.name).toBe('Half a Sun');
    expect(missionById('nope')).toBeUndefined();
  });

  it('poses every mission as a question', () => {
    for (const mission of MISSIONS) {
      expect(mission.question.trim().endsWith('?'), `${mission.id} question doesn't ask`).toBe(true);
    }
  });

  // The checklist's current-step pointer parks on the first step without a
  // check (a watch-finale — nothing completes it), so a checked step after one
  // would never become current and its highlight would never show.
  it('walks every mission through steps, watch-finales last', () => {
    for (const mission of MISSIONS) {
      expect(mission.steps.length, `${mission.id} has no steps`).toBeGreaterThan(1);
      for (const step of mission.steps) {
        expect(step.text.trim().length, `${mission.id} has an empty step`).toBeGreaterThan(0);
      }
      const firstCheckless = mission.steps.findIndex((s) => s.check === undefined);
      if (firstCheckless >= 0) {
        for (const later of mission.steps.slice(firstCheckless)) {
          expect(later.check, `${mission.id}: a checked step follows a watch-finale`).toBeUndefined();
        }
      }
    }
  });

  // Checks and targets resolve bodies by name against the live roster, so a
  // typo'd name would just leave a step forever un-ticked (or a highlight that
  // never fires) with nothing else failing. `added` and the created-body
  // targets are the exception: those bodies don't exist at build time.
  it('step checks and targets name bodies the mission builds', () => {
    for (const mission of MISSIONS) {
      const names = new Set(mission.build().map((b) => b.name));
      for (const step of mission.steps) {
        for (const ref of [step.check, step.target]) {
          if (ref === undefined || !('body' in ref)) continue;
          expect(names.has(ref.body), `${mission.id}: "${ref.body}" isn't in the roster`).toBe(true);
        }
        if (step.check?.kind === 'near') {
          expect(names.has(step.check.other), `${mission.id}: "${step.check.other}" isn't in the roster`).toBe(true);
        }
      }
    }
  });

  it('gives every mission distinct prediction choices', () => {
    for (const mission of MISSIONS) {
      expect(mission.choices.length, `${mission.id} needs enough choices to choose between`).toBeGreaterThanOrEqual(2);
      expect(new Set(mission.choices).size).toBe(mission.choices.length);
    }
  });

  // Choices are named by letter wherever they surface, and the debrief refers
  // back to one ("It was C") long after the list has closed. That only works if
  // the letters are the plain A, B, C the picker showed, so pin the mapping and
  // keep every mission inside the run of letters a reader will follow.
  it('labels prediction choices A, B, C by position', () => {
    expect([0, 1, 2].map(choiceLetter)).toEqual(['A', 'B', 'C']);
    for (const mission of MISSIONS) {
      expect(mission.choices.length, `${mission.id} has more choices than letters read well`).toBeLessThanOrEqual(6);
    }
  });

  it('gives every mission a card color and a portrait shot', () => {
    for (const mission of MISSIONS) {
      expect(mission.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(mission.shot.days).toBeGreaterThan(0);
      if (mission.shot.center !== undefined) {
        // Resolved against the *post-setup* roster, which is what the capture
        // hook centers against: Lights Out deletes the body its shot would
        // otherwise have named, and Two-Year Planet centers one its setup adds.
        const names = new Set(shootMission(mission).map((b) => b.name));
        expect(names.has(mission.shot.center), `${mission.id} centers a missing body`).toBe(true);
      }
    }
  });

  // The cards exist to pose what the mission asks, and three of them were
  // shooting the same untouched Earth because nothing applied the edit. A setup
  // that leaves the system as `build()` gave it is that bug returning, so
  // require every mission to actually change something.
  it('applies a real edit before photographing each card', () => {
    for (const mission of MISSIONS) {
      expect(mission.setup, `${mission.id} would photograph the unedited system`).toBeDefined();

      const key = (bodies: Body[]) =>
        JSON.stringify(
          bodies
            .map((b) => [b.name, b.type, b.mass, b.radius])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        );
      // Both sides pre-rolled the same span, so the only difference between them
      // is the edit — otherwise every mission would "pass" on orbital motion
      // alone. Velocity is deliberately out of the key for that reason; the
      // velocity-only missions are pinned separately below.
      const edited = shootMission(mission);
      const untouched = shootMission(mission, { skipSetup: true });
      const changed =
        key(edited) !== key(untouched) ||
        edited.length !== untouched.length ||
        velocityKey(edited) !== velocityKey(untouched);
      expect(changed, `${mission.id}'s setup changes nothing`).toBe(true);
    }
  });

  // Every setup must go through `state/system.svelte.ts` rather than mutating
  // the roster it was built from — that's the app-wide invariant, and it's what
  // makes the edit land at the *current* time instead of teleporting bodies
  // back to t = 0. A setup that reached into module-level spec data would also
  // leak into every later build, including the app's own missions.
  it('leaves the next build unedited', () => {
    // Ids are fresh UUIDs per build, so compare everything except them.
    const shape = (bodies: Body[]) => JSON.stringify(bodies.map(({ id: _id, ...rest }) => rest));

    for (const mission of MISSIONS) {
      const baseline = shape(mission.build());
      shootMission(mission);
      expect(shape(mission.build()), `${mission.id}'s setup leaked`).toBe(baseline);
    }
  });

  // The pre-roll exists to lay down trails, and the edit is made *after* it, so
  // each setup has to read live state rather than the t = 0 roster. Stopping
  // Earth by scaling its stale velocity would leave it moving; reversing it
  // would send it off in a direction it hadn't been travelling for months.
  //
  // Both of these missions scale the live velocity by a constant, so the check
  // is the same either way: the result must be that constant times the velocity
  // the body actually had when the shutter fired.
  it('edits the live state the pre-roll left, not the roster it was built from', () => {
    for (const [id, factor] of [
      ['full-stop', 0],
      ['wrong-way-earth', -1],
    ] as const) {
      const mission = missionById(id)!;
      const before = shootMission(mission, { skipSetup: true });
      const after = shootMission(mission);

      const velocityOf = (bodies: Body[]) => bodies.find((b) => b.name === 'Earth')!.velocity;
      const was = velocityOf(before);
      const now = velocityOf(after);

      // The pre-roll must actually have moved Earth off its t = 0 velocity, or
      // this proves nothing about which one the setup read.
      const initial = mission.build().find((b) => b.name === 'Earth')!.velocity;
      expect(Math.hypot(was.x - initial.x, was.y - initial.y, was.z - initial.z)).toBeGreaterThan(
        1e3
      );

      for (const axis of ['x', 'y', 'z'] as const) {
        expect(now[axis], `${id} scaled a stale ${axis} velocity`).toBeCloseTo(was[axis] * factor, 3);
      }
    }
  });

  // The debrief states the outcome rather than grading an answer, so what has
  // to hold is that every mission names which of its own choices the sim
  // actually does, and explains it.
  it('states an outcome for every mission, indexed into its own choices', () => {
    for (const mission of MISSIONS) {
      const { choice, summary, why } = mission.outcome;
      expect(choice, `${mission.id} outcome index out of range`).toBeGreaterThanOrEqual(0);
      expect(choice).toBeLessThan(mission.choices.length);
      expect(summary.length, `${mission.id} states no outcome`).toBeGreaterThan(0);
      expect(why.length, `${mission.id} explains no outcome`).toBeGreaterThan(0);
    }
  });

  // Nothing is scored, so the copy must not read as grading. A summary that
  // says "correct" is the failure mode this is guarding against — it would put
  // the graded framing back one string at a time.
  it('never grades: no right/wrong language in the outcome copy', () => {
    const graded = /\b(correct|incorrect|wrong answer|well done|right answer)\b/i;
    for (const mission of MISSIONS) {
      const { summary, why, measured } = mission.outcome;
      for (const text of [summary, why, measured ?? '']) {
        expect(graded.test(text), `${mission.id} grades in its outcome copy: "${text}"`).toBe(false);
      }
    }
  });

  // The two missions whose outcome is a measured number state it in prose now
  // rather than checking an entry, so the number in the copy is what these pin
  // against the physics. The value is parsed out of `measured` deliberately:
  // that string is what the student reads, so it's the thing that must be
  // right.
  it('states the measured numbers the physics gives', () => {
    const measuredValue = (id: string) => {
      const outcome = missionById(id)!.outcome;
      expect(outcome.measured, `${id} should state a measured value`).toBeDefined();
      const parsed = Number(outcome.measured!.match(/[\d.]+/)?.[0]);
      expect(Number.isFinite(parsed), `${id} measured value isn't a number`).toBe(true);
      return parsed;
    };

    // Full Stop: a dead-stopped Earth falls for half the period of a
    // degenerate orbit with a = ½ AU — 365.25 · 0.5^1.5 / 2 ≈ 64.6 days, so
    // "about 65 days" is right to within rounding.
    expect(Math.abs((365.25 * 0.5 ** 1.5) / 2 - measuredValue('full-stop'))).toBeLessThanOrEqual(2);

    // Two-Year Planet: Kepler's third law puts a 2-year orbit at 2^(2/3) AU.
    expect(Math.abs(2 ** (2 / 3) - measuredValue('two-year-planet'))).toBeLessThanOrEqual(0.05);

    // Both also have to pick the choice their number actually falls in — the
    // prose and the highlighted choice must agree.
    expect(missionById('full-stop')!.outcome.choice, 'about two months').toBe(1);
    expect(missionById('two-year-planet')!.outcome.choice, 'about 1.6 AU').toBe(1);
  });

  it('prompts every prediction in terms of what to watch', () => {
    for (const mission of MISSIONS) {
      expect(
        mission.predictPrompt.trim().endsWith('?'),
        `${mission.id} prediction prompt doesn't ask`
      ).toBe(true);
    }
  });

  // The picker renders a heading whenever the category changes between
  // consecutive missions, so a category split across two runs of the array
  // would render twice. Contiguity in MISSIONS is the contract.
  it('keeps each category contiguous, so the picker headings are unique', () => {
    const seen = new Set<string>();
    let current = '';
    for (const mission of MISSIONS) {
      expect(mission.category.length, `${mission.id} has no category`).toBeGreaterThan(0);
      if (mission.category === current) continue;
      expect(seen.has(mission.category), `"${mission.category}" appears in two runs`).toBe(false);
      seen.add(mission.category);
      current = mission.category;
    }
  });

  // Follow-ups are optional — some missions' answers close the question
  // (Dark Sun's is "nothing changes") — and the debrief renders the section
  // only when there are any. Present ones must not be blank, though.
  it('closes every mission with notes: reading, and no blank follow-ups', () => {
    for (const mission of MISSIONS) {
      const { links, followUps } = mission.notes;
      expect(links.length, `${mission.id} offers nothing to read`).toBeGreaterThan(0);
      for (const followUp of followUps) {
        expect(followUp.length, `${mission.id} has a blank follow-up`).toBeGreaterThan(0);
      }
      for (const link of links) {
        expect(link.label.length, `${mission.id} has an unlabelled link`).toBeGreaterThan(0);
        expect(link.url, `${mission.id} link should be https`).toMatch(/^https:\/\//);
      }
    }
  });

  it('builds a fresh roster each call, so loading twice cannot share ids', () => {
    const a = MISSIONS[0].build();
    const b = MISSIONS[0].build();
    expect(a[0].id).not.toBe(b[0].id);
  });

  // Wrong Way Earth asks two things at once, and the stated outcome is
  // "Earth keeps the same orbit backwards, and the Moon is left behind".
  //
  // Gravity is a function of position, so negating Earth's velocity leaves its
  // ellipse identical and only reverses the direction of travel. The flip is
  // applied to Earth alone, though, so the Moon keeps its original heading and
  // the two part at ~60 km/s — far too fast for Earth to hold. It doesn't
  // crash and it isn't flung out of the system; it just ends up on its own
  // orbit round the Sun. If any of that moves, the mission's copy must move
  // with it.
  it('wrong way earth: same ellipse reversed, and the Moon is left behind', () => {
    expect(missionById('wrong-way-earth')!.outcome.choice).toBe(0);

    const bodies = solarSystem();
    const earth = bodies.find((b) => b.name === 'Earth')!;

    earth.velocity = { x: -earth.velocity.x, y: -earth.velocity.y, z: -earth.velocity.z };

    const sim = new Simulation(bodies);
    const index = (name: string) => sim.aliveIds.indexOf(bodies.find((b) => b.name === name)!.id);
    const at = (arr: Float64Array, k: number) => ({
      x: arr[k * 3],
      y: arr[k * 3 + 1],
      z: arr[k * 3 + 2],
    });
    const heliocentric = (name: string) => {
      const i = index(name);
      const s = index('Sun');
      const { pos, vel, mass } = sim.state;
      const el = stateVectorToElements(
        mass[s],
        { position: at(pos, s), velocity: at(vel, s) },
        { position: at(pos, i), velocity: at(vel, i) },
        mass[i]
      );
      return { a: el.a / AU, e: el.e };
    };
    // Sign of the z-component of r × v about the Sun: which way round it goes.
    const senseOfEarth = () => {
      const i = index('Earth');
      const s = index('Sun');
      const { pos, vel } = sim.state;
      const p = at(pos, i);
      const c = at(pos, s);
      const v = at(vel, i);
      return Math.sign((p.x - c.x) * v.y - (p.y - c.y) * v.x);
    };

    const separation = () => {
      const { pos } = sim.state;
      const e = at(pos, index('Earth'));
      const m = at(pos, index('Moon'));
      return Math.hypot(e.x - m.x, e.y - m.y, e.z - m.z);
    };
    /** The real Earth–Moon distance, as the yardstick for "left behind". */
    const EARTH_MOON = 384_400e3;

    const before = heliocentric('Earth');
    const sense = senseOfEarth();

    expect(separation() / EARTH_MOON, 'should start at the real lunar distance').toBeLessThan(1.5);

    // The parting is immediate and obvious — a student playing a few days sees
    // it, which is what the task asks them to do.
    sim.advanceTo(DAY, 1e9);
    expect(separation() / EARTH_MOON, 'the Moon should be well clear after a day').toBeGreaterThan(5);

    sim.advanceTo(30 * DAY, 1e9);
    expect(separation() / EARTH_MOON, 'and far gone after a month').toBeGreaterThan(100);

    sim.advanceTo(10 * 365.25 * DAY, 1e9);

    // Nothing hits anything — in particular the Moon doesn't fall into Earth.
    expect(sim.merges).toHaveLength(0);
    expect(index('Moon'), 'the Moon should survive the reversal').toBeGreaterThanOrEqual(0);

    // Earth's ellipse is untouched after ten years of going the other way.
    const after = heliocentric('Earth');
    expect(Math.abs(after.a - before.a) / before.a, 'semi-major axis moved').toBeLessThan(0.01);
    expect(Math.abs(after.e - before.e), 'eccentricity moved').toBeLessThan(0.01);
    expect(senseOfEarth(), 'Earth should still be going the reversed way').toBe(sense);

    // …and it is genuinely the other way round: the untouched solar system
    // runs with the opposite sense.
    const forwardBodies = solarSystem();
    const forward = new Simulation(forwardBodies);
    const forwardSense = (() => {
      const find = (name: string) =>
        forward.aliveIds.indexOf(forwardBodies.find((b) => b.name === name)!.id);
      const { pos, vel } = forward.state;
      const p = at(pos, find('Earth'));
      const c = at(pos, find('Sun'));
      const v = at(vel, find('Earth'));
      return Math.sign((p.x - c.x) * v.y - (p.y - c.y) * v.x);
    })();
    expect(sense, 'the reversed Earth must run against the untouched one').toBe(-forwardSense);

    // The Moon ends up on its own orbit around the Sun, near Earth's own —
    // neither following Earth round nor falling in with it, which are the two
    // rejected choices.
    const moonOrbit = heliocentric('Moon');
    expect(moonOrbit.a, 'the Moon should be on a bound solar orbit').toBeGreaterThan(0.9);
    expect(moonOrbit.a).toBeLessThan(1.3);
    expect(moonOrbit.e, 'the Moon should not be flung onto a wild orbit').toBeLessThan(0.2);
    // Not recaptured. Distance alone is the wrong measure here: both are on
    // similar solar orbits, so the gap breathes over the years (it happens to
    // be ~46 Earth–Moon distances at the 10-year mark, having been ~800 at 90
    // days). What settles it is that the Moon is no longer *bound* to Earth —
    // its speed relative to Earth exceeds Earth's escape velocity at that
    // separation, by three orders of magnitude.
    const relativeSpeed = (() => {
      const { vel } = sim.state;
      const e = at(vel, index('Earth'));
      const m = at(vel, index('Moon'));
      return Math.hypot(e.x - m.x, e.y - m.y, e.z - m.z);
    })();
    const earthMass = sim.state.mass[index('Earth')];
    const escapeSpeed = Math.sqrt((2 * G * earthMass) / separation());
    expect(relativeSpeed, 'the Moon must not be bound to Earth any more').toBeGreaterThan(
      escapeSpeed
    );
  });

  // Hot Jupiter's stated outcome is "almost nothing you can see": performed
  // as the task says — drag drops Jupiter on a circular orbit halfway between
  // the Sun and Mercury (the previewDrop contract) — five years leave every
  // inner orbit essentially unchanged. If this fails, the sim outcome has
  // moved and the mission's copy must move with it.
  it('hot jupiter: the inner system rides out five years essentially unchanged', () => {
    expect(missionById('hot-jupiter')!.outcome.choice).toBe(0);

    const bodies = solarSystem();
    const sun = bodies.find((b) => b.name === 'Sun')!;
    const jupiter = bodies.find((b) => b.name === 'Jupiter')!;
    const mercury = bodies.find((b) => b.name === 'Mercury')!;

    jupiter.position = {
      x: (sun.position.x + mercury.position.x) / 2,
      y: (sun.position.y + mercury.position.y) / 2,
      z: (sun.position.z + mercury.position.z) / 2,
    };
    jupiter.velocity = circularVelocityAt(
      sun.mass,
      { position: sun.position, velocity: sun.velocity },
      jupiter.position,
      jupiter.mass
    );

    const sim = new Simulation(bodies);

    const elements = (name: string) => {
      const id = bodies.find((b) => b.name === name)!.id;
      const i = sim.aliveIds.indexOf(id);
      const s = sim.aliveIds.indexOf(sun.id);
      const { pos, vel, mass } = sim.state;
      const at = (arr: Float64Array, k: number) => ({
        x: arr[k * 3],
        y: arr[k * 3 + 1],
        z: arr[k * 3 + 2],
      });
      const el = stateVectorToElements(
        mass[s],
        { position: at(pos, s), velocity: at(vel, s) },
        { position: at(pos, i), velocity: at(vel, i) },
        mass[i]
      );
      return { a: el.a / AU, e: el.e };
    };

    const names = ['Mercury', 'Venus', 'Earth', 'Mars'];
    const before = new Map(names.map((n) => [n, elements(n)]));

    sim.advanceTo(5 * 365.25 * DAY, 1e9);

    expect(sim.merges).toHaveLength(0);
    for (const name of names) {
      const b = before.get(name)!;
      const a = elements(name);
      expect(Math.abs(a.a - b.a) / b.a, `${name} semi-major axis moved`).toBeLessThan(0.02);
      expect(Math.abs(a.e - b.e), `${name} eccentricity moved`).toBeLessThan(0.05);
    }
  });

  // Dark Sun's stated outcome is "nothing changes", and turning the Sun into
  // a black hole is not quite the no-op a radius edit would be: the blackhole
  // type swaps every pair involving the Sun onto the Paczyński–Wiita force,
  // G·m/(d − r_s)². With r_s ≈ 2.95 km against Mercury's d ≈ 5.8e10 m the
  // correction is ~1e-7 of the force, so the honest claim is "identical to the
  // eye", which this pins from both sides: the relativistic path really is
  // engaged (so the mission isn't secretly a no-op), yet a year of it moves no
  // planet by more than a thousandth of an AU off the Newtonian system.
  it('dark sun: a same-mass black hole leaves every orbit visually unchanged', () => {
    expect(missionById('dark-sun')!.outcome.choice).toBe(1);

    const collapsedBodies = solarSystem();
    const sun = collapsedBodies.find((b) => b.name === 'Sun')!;
    // Same edit the task asks for: Type → blackhole, Radius → 3 km.
    sun.type = 'blackhole';
    sun.radius = 3e3;

    const collapsed = new Simulation(collapsedBodies);
    const reference = new Simulation(solarSystem());

    const sunIndex = collapsed.aliveIds.indexOf(sun.id);
    expect(collapsed.state.rs[sunIndex], 'the Sun should have a horizon').toBeCloseTo(
      schwarzschildRadius(sun.mass)
    );

    collapsed.advanceTo(365.25 * DAY, 1e9);
    reference.advanceTo(365.25 * DAY, 1e9);

    expect(collapsed.merges).toHaveLength(0);
    expect(collapsed.state.pos.length).toBe(reference.state.pos.length);
    let maxDiff = 0;
    for (let i = 0; i < collapsed.state.pos.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(collapsed.state.pos[i] - reference.state.pos[i]));
    }
    expect(maxDiff, 'the force law should genuinely have changed').toBeGreaterThan(0);
    expect(maxDiff / AU, 'but not visibly').toBeLessThan(1e-3);
  });

  // The mission teaches the body type the unlock gates, so it must open in the
  // same moment: its threshold is read off the black-hole preset — the one
  // place the number is written — and this pins that they can't drift apart.
  it('dark sun unlocks exactly when black holes do', () => {
    const darkSun = missionById('dark-sun')!;
    expect(darkSun.unlockAfterMissions).toBeGreaterThan(0);
    expect(darkSun.unlockAfterMissions).toBe(presetById('black-hole')?.unlockAfterMissions);
  });

  // Heavy Earth's stated outcome is a composite, like Wrong Way Earth's:
  // "same orbit, same year — but the Moon comes crashing down". At 300× Earth
  // the Moon's speed is ~17× short of the new circular speed, so it falls and
  // merges within hours (measured: t ≈ 7.2 h) — well inside the single day
  // the task says to play. Earth's heliocentric ellipse, meanwhile, doesn't
  // care about Earth's own mass: a and e move by ~1e-5 over five years. The
  // neighbours do feel a Jupiter-mass Earth — Venus's eccentricity drifts by
  // ~0.01 in five years — but nothing visible at trail scale, hence the same
  // tolerances the hot-jupiter test uses. If any of that moves, the mission's
  // copy must move with it.
  it('heavy earth: the same year, and the Moon comes down within a day', () => {
    expect(missionById('heavy-earth')!.outcome.choice).toBe(1);

    const bodies = solarSystem();
    const earth = bodies.find((b) => b.name === 'Earth')!;
    earth.mass *= 300;

    const sim = new Simulation(bodies);
    const index = (name: string) => sim.aliveIds.indexOf(bodies.find((b) => b.name === name)!.id);
    const at = (arr: Float64Array, k: number) => ({
      x: arr[k * 3],
      y: arr[k * 3 + 1],
      z: arr[k * 3 + 2],
    });
    const heliocentric = (name: string) => {
      const i = index(name);
      const s = index('Sun');
      const { pos, vel, mass } = sim.state;
      const el = stateVectorToElements(
        mass[s],
        { position: at(pos, s), velocity: at(vel, s) },
        { position: at(pos, i), velocity: at(vel, i) },
        mass[i]
      );
      return { a: el.a / AU, e: el.e };
    };

    const names = ['Mercury', 'Venus', 'Earth', 'Mars'];
    const before = new Map(names.map((n) => [n, heliocentric(n)]));

    sim.advanceTo(DAY, 1e9);
    expect(sim.merges, 'the Moon should have come down already').toHaveLength(1);
    expect(sim.merges[0].survivorName).toBe('Earth');
    expect(sim.merges[0].absorbedName).toBe('Moon');

    sim.advanceTo(5 * 365.25 * DAY, 1e9);
    expect(sim.merges, 'nothing else should hit anything').toHaveLength(1);
    for (const name of names) {
      const b = before.get(name)!;
      const a = heliocentric(name);
      expect(Math.abs(a.a - b.a) / b.a, `${name} semi-major axis moved`).toBeLessThan(0.02);
      expect(Math.abs(a.e - b.e), `${name} eccentricity moved`).toBeLessThan(0.05);
    }
    // Earth itself, though, must not have budged: its own mass isn't in its
    // orbit's equation.
    const earthBefore = before.get('Earth')!;
    const earthAfter = heliocentric('Earth');
    expect(Math.abs(earthAfter.a - earthBefore.a) / earthBefore.a).toBeLessThan(1e-3);
    expect(Math.abs(earthAfter.e - earthBefore.e)).toBeLessThan(1e-3);
  });

  // Guards the stated outcome for "Butterfly Stars": a 5% nudge holds the
  // figure-eight for about a dozen loops and then ends in a collision, not an
  // ejection and not an immediate crash. Both halves matter — the mission's
  // three choices are "holds together", "crashes right away" and "crashes after
  // 13 years", so a merge that arrived in year 2 would make the stated answer
  // just as wrong as no merge at all. If this test fails, `outcome` is stale.
  it('a 5% nudge holds the figure-eight for years, then ends in a collision', () => {
    const mission = missionById('butterfly-stars')!;
    expect(mission.outcome.choice).toBe(2);

    const perturbed = mission.build();
    // Same edit the task asks for: Star A, Velocity Y, *1.05.
    expect(perturbed[0].name).toBe('Star A');
    perturbed[0].velocity.y *= 1.05;

    const sim = new Simulation(perturbed);
    const ids = sim.aliveIds.slice();
    const maxSeparation = () => {
      let max = 0;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = sim.positionOf(ids[i])!;
          const b = sim.positionOf(ids[j])!;
          max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }
      }
      return max;
    };

    // Step in 5-day increments and record when the first merge lands. The
    // choreography's period is ~1 year, so the "holds together at first" half of
    // the answer is: no merge inside the first five loops.
    let mergeDay: number | null = null;
    let peakBeforeMerge = 0;
    for (let day = 5; day <= 60 * 365; day += 5) {
      sim.advanceTo(day * DAY, 1e9);
      if (sim.merges.length > 0) {
        mergeDay = day;
        break;
      }
      peakBeforeMerge = Math.max(peakBeforeMerge, maxSeparation());
    }

    expect(mergeDay, 'the 5% nudge must end in a collision').not.toBeNull();
    // Measured: day 4485, year 12.3. Bounds are loose enough to absorb
    // integrator changes but tight enough that a crash in year 2 (choice 1,
    // "right away") or no crash at all (choice 0) fails.
    expect(mergeDay! / 365).toBeGreaterThan(5);
    expect(mergeDay! / 365).toBeLessThan(25);
    // Two stars fall together; the third isn't flung out on the way.
    expect(sim.merges).toHaveLength(1);
    expect(sim.aliveIds).toHaveLength(2);
    // Until then the eight keeps roughly the ~2 AU span it starts with.
    expect(peakBeforeMerge / AU).toBeLessThan(3);
  });
});

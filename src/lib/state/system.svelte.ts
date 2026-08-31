// Reactive body roster + metadata, and the single mutation path for it.
//
// The roster carries appearance and identity — name, color, type, spin, tilt —
// plus each body's state when it was created or last edited. Live positions
// come from the sim, never from here.
//
// Every mutating edit goes through `commit`, and nothing else in the app may
// mutate `sim` or `bodies` directly.

import type { Body, BodyType, SystemFile } from '../types';
import { vec3, type Vec3 } from '../physics/vec3';
import {
  circularVelocityAt,
  elementsToStateVector,
  orbitalPeriod,
  type StateVector,
} from '../physics/kepler';
import { dominantAttractorAtPoint } from '../physics/orbitInfo';
import { presetById } from '../presets/examples';
import { galleryEntryById } from '../presets/gallery';
import { missionById } from '../presets/missions';
import { parseSystemFile, toSystemFile, type AutosaveSource } from '../storage/persistence';
import { history } from './history.svelte';
import { mission, noteKeys } from './mission.svelte';
import { restored, shareError, sharedSystem, sim } from './simInstance';
import { toast } from './toasts.svelte';
import type { MergeEvent, SimulationOptions } from '../sim/simulation';
import { time } from './time.svelte';
import { ui, BARYCENTER } from './ui.svelte';
import { TYPE_DEFAULTS, type OrbitInput } from '../ui/units';

class SystemState {
  /** name of the loaded system; the initial value names the cold-boot roster
   * built in `simInstance.ts` — keep the two in sync */
  name = $state('Solar System');
  /** definitions/metadata, not per-frame physics state */
  bodies = $state<Body[]>([]);
  /**
   * Bumped by `loadSystem` alone. The scene watches it to drop merge bursts and
   * accretion flares, which belong to the timeline that recorded them.
   * `seekGeneration` can't carry this — it also bumps on edits and scrubs,
   * where replaying the effects is the point.
   */
  loadGeneration = $state(0);

  /**
   * The system as it was loaded, kept so "Revert system" can put it back. Null
   * until something is loaded — the boot roster is not a load, except a share
   * link's, which is an explicit "open this system" and arms revert like an
   * import (see the boot block at the bottom).
   */
  loaded = $state<LoadedSystem | null>(null);

  byId(id: string | null): Body | undefined {
    if (id === null) return undefined;
    return this.bodies.find((b) => b.id === id);
  }
}

/** A pristine copy of a loaded system, plus what re-arms with it. */
interface LoadedSystem {
  name: string;
  bodies: Body[];
  timing: SimulationOptions;
  /** Mission the load was part of, so a revert restarts it rather than dropping it. */
  mission: { id: string; prediction: number } | null;
  /**
   * Registry provenance, persisted with the autosave so revert survives a
   * reload (see `AutosaveSource`). Null for imports and save slots — their
   * revert lasts the session only. Mission provenance rides on `mission`.
   */
  source: LoadSource | null;
}

/** The in-session subset of `AutosaveSource` a load call site can claim. */
export type LoadSource = { kind: 'preset' | 'gallery'; id: string };

export const system = new SystemState();

/**
 * Whether a merge reads as a spacecraft coming down rather than worlds
 * colliding. Physically it's the same absorption either way — this decides the
 * *telling*: the toast gets arrival wording (re-entry or impact) and the scene
 * skips the merge burst, which at planetary scale reads as the planet
 * exploding. Shared here so the two presentations can't drift apart. Two craft
 * colliding stay a merge, and the roster keeps merged-away bodies' metadata,
 * so the lookup still resolves when a seek replays the event.
 */
export function isSatelliteLanding(event: MergeEvent): boolean {
  return (
    system.byId(event.absorbedId)?.type === 'satellite' &&
    system.byId(event.survivorId)?.type !== 'satellite'
  );
}

/**
 * Push `bodies` into the sim, invalidate the future, and re-mirror.
 *
 * `applyBodyEdits` keeps live position/velocity for bodies already in flight
 * and takes the roster's own state for ones it hasn't seen — that's what makes
 * "edit a planet's mass at year 3" leave it where it is while changing
 * everything after. It also drops snapshots past the current time.
 */
function commit(bodies: Body[], stateAuthoritative?: ReadonlySet<string>): void {
  sim.applyBodyEdits(bodies, stateAuthoritative);

  // Trails and other history-derived visuals must be rebuilt: the roster behind
  // them changed, and a body may have appeared or vanished.
  time.seekGeneration += 1;
  time.computedUntil = sim.computedUntil;
  if (time.simTime > sim.computedUntil) time.simTime = sim.time;

  mirror();
}

/** The sim is the source of truth. */
function mirror(): void {
  system.bodies = sim.bodies.map(cloneBody);
}

function cloneBody(b: Body): Body {
  return {
    ...b,
    position: { ...b.position },
    velocity: { ...b.velocity },
    atmosphere: b.atmosphere ? { ...b.atmosphere } : undefined,
    rings: b.rings ? { ...b.rings } : undefined,
  };
}

/**
 * Snapshot the *current* state of every body into a roster.
 *
 * Edits apply at the current sim time, so the roster handed to the sim must
 * describe now — otherwise editing a planet's color at year 3 would teleport
 * every body back to its t = 0 position.
 *
 * Bodies dead at the current time (merged away or deleted) are excluded: the
 * sim retains their metadata itself, and `restoreRoster` marks every entry
 * state-authoritative, so a ghost riding along in a recorded roster would be
 * resurrected by the undo of an unrelated later edit. A body that is merely
 * not born yet (added further along the timeline) stays in — an edit made
 * before its creation deliberately pulls it in at the current time.
 */
function rosterAtCurrentTime(): Body[] {
  return sim.bodies.flatMap((b) => {
    const live = liveStateOf(b.id);
    if (live) return [{ ...cloneBody(b), position: live.position, velocity: live.velocity }];
    if (deadNow(b.id)) return [];
    return [cloneBody(b)];
  });
}

/** Dead at the current time: absorbed by a merge or removed by a deletion. */
function deadNow(id: string): boolean {
  if (sim.deletedAt(id) !== null) return true;
  return sim.merges.some((e) => e.absorbedId === id && e.t <= sim.time);
}

function liveStateOf(id: string): StateVector | null {
  const i = sim.aliveIds.indexOf(id);
  if (i < 0) return null;
  const i3 = i * 3;
  const { pos, vel } = sim.state;
  return {
    position: vec3(pos[i3], pos[i3 + 1], pos[i3 + 2]),
    velocity: vec3(vel[i3], vel[i3 + 1], vel[i3 + 2]),
  };
}

export { liveStateOf, rosterAtCurrentTime };

/**
 * The current system as a written file, for every path that persists one:
 * autosave, save slots, export. Filters out `sim.staleBodyIds` — bodies a merge
 * had absorbed or a deletion had removed before the last edit rebased the
 * roster. A file carrying a stale entry resurrects the dead body on its next
 * load, at whatever old position its entry holds — for a crash victim, usually
 * straight back onto its collision course.
 */
export function currentSystemFile(): SystemFile {
  return toSystemFile(
    system.name,
    system.bodies.filter((b) => !sim.staleBodyIds.has(b.id)),
    sim.timing
  );
}

/**
 * Sim time a saved or shared copy of the current system will start at, seconds.
 * Nonzero after a mid-timeline edit: the roster was rebased onto that instant,
 * so writing it out flattens the history before it — a fact worth a warning
 * wherever a save is offered. Reads the reactive roster (which every commit
 * replaces) so `$derived` callers recompute per edit despite the sim itself
 * being non-reactive.
 */
export function savedTimelineStart(): number {
  void system.bodies;
  return sim.lastEditTime;
}

// --- mutations -----------------------------------------------------------

export function addBody(body: Body): void {
  const roster = rosterAtCurrentTime();
  history.record(roster);
  commit([...roster, cloneBody(body)]);
}

/**
 * Apply a partial edit to one body. Fields absent from `changes` are left
 * alone; `atmosphere`/`rings` set to undefined remove those features.
 *
 * A position/velocity edit flags that body alone as state-authoritative —
 * otherwise the anti-teleport rule in `applyBodyEdits` keeps its live state and
 * drops exactly the fields being edited.
 *
 * `coalesceAs` labels a continuous gesture (a drag) so its per-frame commits
 * collapse into one undo entry.
 */
export function updateBody(
  id: string,
  changes: Partial<Body>,
  coalesceAs: string | null = null
): void {
  const roster = rosterAtCurrentTime();
  const index = roster.findIndex((b) => b.id === id);
  if (index < 0) return;

  history.record(roster, coalesceAs);
  // The mission checklist can't read "the Mass box was edited" off the roster —
  // every commit rebases every body's state — so the mutation path names what
  // changed. No-op outside a mission.
  for (const field of ['mass', 'radius', 'type', 'velocity', 'position'] as const) {
    if (changes[field] !== undefined) mission.note(noteKeys.edited(roster[index].name, field));
  }
  roster[index] = { ...roster[index], ...changes, id };
  const editsState = changes.position !== undefined || changes.velocity !== undefined;
  commit(roster, editsState ? new Set([id]) : undefined);
}

/**
 * Delete a body at the current time. Mid-run this is a timeline event, not an
 * erasure: the body keeps existing before this instant, so rewinding shows it
 * again, and the sim keeps its metadata for that rendering. Deleting at t = 0
 * removes it from the system outright.
 */
export function deleteBody(id: string): void {
  const roster = rosterAtCurrentTime();
  // Already dead here (merged or deleted): nothing to remove, and committing
  // anyway would push a do-nothing undo entry.
  if (!roster.some((b) => b.id === id)) return;
  history.record(roster);
  commit(roster.filter((b) => b.id !== id));
}

/**
 * Restore a roster from the undo/redo stack.
 *
 * Every body is flagged state-authoritative — the point is to put them back
 * where they were, and otherwise an undo of a drag would restore metadata alone
 * and change nothing visible. Bodies present but not currently alive re-enter
 * with their recorded state, which is how undoing a delete brings one back.
 */
function restoreRoster(roster: Body[]): void {
  ui.selectedBodyId = roster.some((b) => b.id === ui.selectedBodyId) ? ui.selectedBodyId : null;
  if (ui.focusedBodyId !== null && !roster.some((b) => b.id === ui.focusedBodyId)) ui.clearFocus();
  if (ui.referenceBodyId !== null && !roster.some((b) => b.id === ui.referenceBodyId)) {
    ui.referenceFrame = BARYCENTER;
  }
  commit(roster, new Set(roster.map((b) => b.id)));
}

export function undo(): void {
  const previous = history.takeUndo(rosterAtCurrentTime());
  if (previous !== null) restoreRoster(previous);
}

export function redo(): void {
  const next = history.takeRedo(rosterAtCurrentTime());
  if (next !== null) restoreRoster(next);
}

/**
 * Replace the whole system and restart at t = 0.
 *
 * A load is a full reset: the sim rebuilds, snapshots and merge events go with
 * it, and `seekGeneration` bumps to throw away trails belonging to a system
 * that no longer exists. The clock always lands at t = 0 — a loaded system is a
 * new trajectory with no time to carry into it.
 */
export function loadSystem(
  bodies: Body[],
  name = system.name,
  timing: SimulationOptions = {}
): void {
  system.name = name;
  // Undoing across a load would resurrect bodies from a system no longer open.
  history.clear();
  // A load is the only moment the timing grids can change, since it resets to
  // t = 0 — no step grid or snapshot store left to reconcile. Omitted fields
  // keep whatever the previous system used.
  sim.load(bodies, timing);
  time.simTime = 0;
  time.computedUntil = sim.computedUntil;
  time.playing = false;
  time.shuttleRate = 0;
  time.seekGeneration += 1;
  system.loadGeneration += 1;
  mirror();
}

/**
 * Load a system from the UI: `loadSystem`, plus the selection/frame reset every
 * load path needs. Without it, a selection or reference frame pointing into the
 * old system is left as a dangling id.
 */
export function loadSystemIntoUi(
  bodies: Body[],
  name: string,
  timing: SimulationOptions = {},
  source: LoadSource | null = null
): void {
  ui.selectedBodyId = null;
  // A preset can declare the view it opens in (see `PresetView`). Applied here
  // rather than at the picker so a revert restores the same view.
  const view = source?.kind === 'preset' ? presetById(source.id)?.view : undefined;
  const byName = (name: string | undefined) =>
    name !== undefined ? bodies.find((b) => b.name === name) : undefined;
  if (view?.exaggeration !== undefined) ui.radiusExaggeration = view.exaggeration;
  if (view?.parentRelativeTrails !== undefined) {
    ui.parentRelativeTrails = view.parentRelativeTrails;
  }
  ui.referenceFrame = byName(view?.center)?.id ?? BARYCENTER;
  const focus = byName(view?.focus);
  if (focus) {
    // Focus instead of recentering — not as well as: the scene consumes the
    // focus request before the center request, so a queued recenter would
    // undo the focus framing a frame later.
    ui.focusBody(focus.id);
  } else {
    // Reset the framing: a camera left zoomed on the old system's inner
    // planets opens the next one on empty sky. The capture script's
    // `zoomRequest` is consumed after this, so preset thumbnails keep their
    // own framing.
    ui.recenter();
  }
  // Always assigned, not just when the view carries one: a zoom queued by the
  // previous load must not leak into this one.
  ui.zoomRequest = view?.zoom ?? null;
  // The in-flight mission's system is gone with the load. The mission picker
  // re-arms *after* calling this, so a mission load survives its own reset.
  mission.abandon();
  // Keep the roster as loaded, before the sim hands back a rebased one:
  // `revertSystem` needs the t = 0 initial conditions.
  system.loaded = {
    name,
    bodies: bodies.map(cloneBody),
    timing: { ...timing },
    mission: null,
    source,
  };
  loadSystem(bodies, name, timing);
}

/**
 * Note that the system just loaded belongs to a mission run, so a revert
 * restarts the mission rather than dropping it. Called after `loadSystemIntoUi`
 * for the same ordering reason `mission.start` is.
 */
export function markLoadedAsMission(id: string, prediction: number): void {
  if (system.loaded) system.loaded.mission = { id, prediction };
}

/**
 * Reload the last-loaded system from its initial conditions, discarding every
 * edit since. A no-op when nothing has been loaded this session.
 *
 * The stored roster is re-cloned on the way out: the sim takes ownership of
 * what it's given, so handing over the stored array would let the next edits
 * rewrite what a second revert needs.
 */
export function revertSystem(): void {
  const loaded = system.loaded;
  if (!loaded) return;

  loadSystemIntoUi(loaded.bodies.map(cloneBody), loaded.name, loaded.timing, loaded.source);
  if (loaded.mission) {
    mission.start(loaded.mission.id, loaded.mission.prediction);
    markLoadedAsMission(loaded.mission.id, loaded.mission.prediction);
  }
}

// --- creation helpers ----------------------------------------------------

/** Next unused "Planet N" style name for a new body. */
export function defaultNameFor(type: BodyType): string {
  const base =
    type === 'star'
      ? 'Star'
      : type === 'moon'
        ? 'Moon'
        : type === 'satellite'
          ? 'Satellite'
          : type === 'asteroid'
            ? 'Asteroid'
            : 'Planet';
  const taken = new Set(system.bodies.map((b) => b.name));
  for (let n = 1; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Build a body from type defaults. The caller supplies position and velocity. */
export function makeBody(
  type: BodyType,
  overrides: Partial<Body> = {}
): Body {
  const defaults = TYPE_DEFAULTS[type];
  return {
    id: crypto.randomUUID(),
    name: defaultNameFor(type),
    color: defaults.color,
    type,
    mass: defaults.mass,
    radius: defaults.radius,
    rotationPeriod: defaults.rotationPeriod,
    axialTilt: defaults.axialTilt,
    position: vec3(),
    velocity: vec3(),
    ...overrides,
  };
}

/** What a click-to-place drop at a point would create — see `previewDrop`. */
export interface DropPreview {
  /** where the body would land (m) — the drop point, possibly pushed out */
  position: Vec3;
  /** circular-orbit velocity there (m/s); zero with no attractor */
  velocity: Vec3;
  /** the attractor's live state, or null when the body would be placed at rest */
  parent: StateVector | null;
  /** the attractor's body id, or null — lets the scene ask about its visuals */
  parentId: string | null;
}

/**
 * Resolve a drop at `position` (m, world frame): the dominant attractor there
 * and the circular-orbit velocity around it. Shared by the actual drop and the
 * ghost preview, so the ghost shows exactly what a click creates.
 *
 * The attractor is found by sphere of influence, with the new body's mass as
 * the candidate floor — dropping a star beside a lighter one doesn't put it in
 * orbit around the lighter one. A drop inside 1.5× the combined radii is pushed
 * radially out to that distance, so clicking on the Sun gives a tight orbit
 * rather than an instant merge.
 */
export function previewDrop(position: Vec3, bodyMass: number, bodyRadius: number): DropPreview {
  const { mass, radius, pos, vel, n } = sim.state;

  const placed = vec3(position.x, position.y, position.z);

  const parent = dominantAttractorAtPoint(placed.x, placed.y, placed.z, mass, pos, n, bodyMass);
  if (parent === null) return { position: placed, velocity: vec3(), parent: null, parentId: null };

  const p3 = parent * 3;
  const parentState: StateVector = {
    position: vec3(pos[p3], pos[p3 + 1], pos[p3 + 2]),
    velocity: vec3(vel[p3], vel[p3 + 1], vel[p3 + 2]),
  };

  const minDistance = 1.5 * (radius[parent] + bodyRadius);
  const dx = placed.x - parentState.position.x;
  const dy = placed.y - parentState.position.y;
  const dz = placed.z - parentState.position.z;
  const r = Math.hypot(dx, dy, dz);
  if (r === 0) {
    placed.x = parentState.position.x + minDistance;
  } else if (r < minDistance) {
    const push = minDistance / r;
    placed.x = parentState.position.x + dx * push;
    placed.y = parentState.position.y + dy * push;
    placed.z = parentState.position.z + dz * push;
  }

  const velocity = circularVelocityAt(mass[parent], parentState, placed, bodyMass);
  return { position: placed, velocity, parent: parentState, parentId: sim.aliveIds[parent] };
}

/** Click-to-place creation: the drop `previewDrop` describes, made real. */
export function addBodyAtPoint(type: BodyType, position: Vec3): Body {
  const defaults = TYPE_DEFAULTS[type];
  const drop = previewDrop(position, defaults.mass, defaults.radius);
  const body = makeBody(type, { position: drop.position, velocity: drop.velocity });
  addBody(body);
  return body;
}

/**
 * Orbit-mode placement: elements relative to a parent → absolute state, using
 * the parent's *current* state so the new body appears on its orbit from where
 * the parent is now. Null when the parent isn't alive at the current time,
 * which the dialog surfaces as a validation error.
 */
export function orbitState(orbit: OrbitInput, bodyMass: number): StateVector | null {
  const parent = system.byId(orbit.parentId);
  if (!parent) return null;

  const parentState = liveStateOf(parent.id);
  if (!parentState) return null;

  return elementsToStateVector(
    parent.mass,
    parentState,
    {
      a: orbit.distance,
      e: orbit.eccentricity,
      i: orbit.inclination,
      lan: 0,
      argPeriapsis: 0,
      trueAnomaly: orbit.phase,
    },
    bodyMass
  );
}

/**
 * Period the orbit form previews before creation, seconds. Uses the parent's
 * *roster* mass (μ = G(M+m)), matching what the sim will integrate.
 */
export function previewPeriod(orbit: OrbitInput, bodyMass: number): number | null {
  const parent = system.byId(orbit.parentId);
  if (!parent || !(orbit.distance > 0)) return null;
  return orbitalPeriod(orbit.distance, parent.mass, bodyMass);
}

// Mirror the constructed sim's roster out, so the scene and UI can read it.
mirror();

/** The provenance the autosave should carry — see `AutosaveSource`. */
export function currentLoadSource(): AutosaveSource | null {
  const loaded = system.loaded;
  if (!loaded) return null;
  if (loaded.mission) return { kind: 'mission', ...loaded.mission };
  return loaded.source;
}

/**
 * Re-arm "Revert system" after an autosave restore by rebuilding the pristine
 * roster from the source's registry. An id its registry no longer knows (a
 * removed preset, a pruned gallery entry) just leaves revert unavailable — the
 * restored roster itself is fine either way.
 */
function restoreLoadedFromSource(source: AutosaveSource): void {
  if (source.kind === 'preset') {
    const preset = presetById(source.id);
    if (!preset) return;
    system.loaded = {
      name: preset.name,
      bodies: preset.build(),
      timing: { ...preset.timing },
      mission: null,
      source: { kind: 'preset', id: preset.id },
    };
  } else if (source.kind === 'mission') {
    const picked = missionById(source.id);
    if (!picked) return;
    system.loaded = {
      name: picked.name,
      bodies: picked.build(),
      timing: { ...picked.timing },
      mission: { id: picked.id, prediction: source.prediction },
      source: null,
    };
  } else {
    // Gallery files live in public/, not the bundle, so the pristine roster has
    // to be fetched. Failure (offline, malformed file) just leaves revert
    // unavailable, and a load the user makes while the fetch is in flight wins.
    const entry = galleryEntryById(source.id);
    if (!entry) return;
    void fetch(`${import.meta.env.BASE_URL}gallery/${entry.id}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        const file = parseSystemFile(text);
        if (system.loaded !== null) return;
        system.loaded = {
          name: entry.name,
          bodies: file.bodies,
          timing: { ...file.settings },
          mission: null,
          source: { kind: 'gallery', id: entry.id },
        };
      })
      .catch(() => {});
  }
}

// The sim already booted from the share link or autosaved roster; this
// restores what it doesn't carry. The clock is deliberately not restored — see
// `AutosaveState`.
if (sharedSystem) {
  system.name = sharedSystem.name;
  // A share boot arms revert like an import: a pristine in-session copy with no
  // registry source. Cloned before the first step so it's true t = 0 state.
  system.loaded = {
    name: sharedSystem.name,
    bodies: sharedSystem.bodies.map(cloneBody),
    timing: { ...sharedSystem.settings },
    mission: null,
    source: null,
  };
} else if (restored) {
  system.name = restored.file.name;
  if (restored.source) restoreLoadedFromSource(restored.source);
}

// A bad share link falls through to the autosave above, so the user must be
// told why they aren't looking at the shared system. Queued before mount;
// the toast list renders once App does.
if (shareError) toast('error', shareError);

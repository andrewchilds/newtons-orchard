// The Simulation owns the bodies' physics state, the snapshot store, and the
// merge-event timeline.
//
// Physics state lives here in plain arrays — never in Svelte reactive state.
// The render loop reads positions directly from the sim each frame.
//
// Determinism is the hard requirement of this module. Two rules deliver it:
//
//  1. The sim only ever exists at times on the fixed grid `stepIndex · dt`.
//     `advanceTo(t)` stops at the largest grid time ≤ t, never taking a partial
//     step to land exactly on t — that would make the trajectory depend on when
//     the caller asked, so replaying at a different frame rate would diverge.
//  2. `seek` restores a snapshot and re-integrates forward — never backward,
//     never interpolated.
//
// Together: play to T, seek(0), seek(T) reproduces T bit for bit.

import { computeAccelerations, createContactList } from '../physics/gravity';
import { copyState, createState, rsFor, step, type PhysicsState } from '../physics/integrator';
import { DAY, schwarzschildRadius } from '../physics/constants';
import { SnapshotStore, type Snapshot } from './snapshots';
import type { Body } from '../types';

/** Recorded when two bodies merge; used by the UI/scene and by seek. */
export interface MergeEvent {
  t: number;
  survivorId: string;
  absorbedId: string;
  /** display convenience — ids alone can't label a toast after the merge */
  survivorName: string;
  absorbedName: string;
}

/**
 * Recorded when an edit removes a live body from the roster. The counterpart
 * of MergeEvent for interventions: it keeps the body dead through later edits
 * (its metadata stays in the roster so pre-deletion snapshots can render it,
 * and handing it a state slot would resurrect it) and lets the UI date the
 * disappearance. An edit can lift it by restoring the body state-authoritative
 * — that's undo bringing a deleted body back.
 */
interface DeletionEvent {
  t: number;
  id: string;
}

/**
 * Post-edit state captured when `applyBodyEdits` runs mid-timeline. Forward
 * re-integration can re-derive merges from physics, but an edit is an outside
 * intervention: without a record of its outcome, rewinding and playing forward
 * computes a timeline where the edit never happened — a body added at year 3
 * simply never appears — until a backward scrub happens to restore a post-edit
 * snapshot.
 */
interface EditEvent {
  stepIndex: number;
  /** aliveIds at the edit instant — a body may have been added or deleted */
  ids: string[];
  state: PhysicsState;
}

export interface SimulationOptions {
  /** fixed physics timestep, seconds */
  dt?: number;
  /** sim-time spacing between snapshots, seconds */
  snapshotInterval?: number;
  /** cap on retained snapshots before 2× decimation */
  maxSnapshots?: number;
  /**
   * Sim-time spacing between trail points, seconds. The sim never reads it —
   * it's carried here as the third of a system's three timing grids, so a load
   * sets all three from one place and the scene reads it back off the sim.
   */
  trailInterval?: number;
}

export const DEFAULT_DT = 600;
export const DEFAULT_SNAPSHOT_INTERVAL = DAY;
/** Default sim-seconds between trail points — see `SimulationOptions.trailInterval`. */
export const DEFAULT_TRAIL_INTERVAL = DAY / 4;

/** Per-frame step budget: beyond this, advanceTo returns early and the UI lags. */
export const DEFAULT_MAX_STEPS = 5000;

export class Simulation {
  /**
   * Fixed physics timestep, seconds. Mutable only through `load`, which resets
   * to t = 0. Changing it at any other time would silently reinterpret
   * `stepIndex` and every stored snapshot's place on the timeline.
   */
  dt: number;
  /** Sim-time spacing between snapshots, seconds. Mutable only through `load`. */
  snapshotInterval: number;
  /** Sim-time spacing between trail points, seconds. Read by the scene. */
  trailInterval: number;

  /** physics state at `time` — index-aligned with `aliveIds` */
  state: PhysicsState;

  private snapshots: SnapshotStore;
  /** Retained so `load` can rebuild the store when the interval changes. */
  private readonly maxSnapshots: number | undefined;
  private mergeEvents: MergeEvent[] = [];
  /** Time-ordered; cleared by reset, truncated with the future. See EditEvent. */
  private editEvents: EditEvent[] = [];
  /** Time-ordered; cleared by reset, truncated with the future. See DeletionEvent. */
  private deletionEvents: DeletionEvent[] = [];
  private listeners = new Set<(event: MergeEvent) => void>();
  /** See `staleBodyIds`. Reassigned wholesale on each roster rebase. */
  private staleIds = new Set<string>();

  /** Body definitions at t = 0, keyed by id — the source of truth for a reset. */
  private roster: Body[];
  /** Names by id, for merge-event labels; survives the body leaving the state. */
  private names = new Map<string, string>();

  private ids: string[];
  private stepIndex = 0;
  private maxStepIndex = 0;

  /**
   * Overlapping pairs found by the last `step`, as a side effect of the force
   * loop. Reused across steps and empty on all but the rare colliding one.
   */
  private contacts = createContactList();

  constructor(bodies: readonly Body[] = [], options: SimulationOptions = {}) {
    this.dt = options.dt ?? DEFAULT_DT;
    this.snapshotInterval = options.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.trailInterval = options.trailInterval ?? DEFAULT_TRAIL_INTERVAL;
    this.maxSnapshots = options.maxSnapshots;
    this.snapshots = new SnapshotStore(this.snapshotInterval, this.maxSnapshots);
    this.roster = bodies.map(cloneBody);
    this.ids = [];
    this.state = createState(0);
    this.reset();
  }

  /** current sim time, seconds — always an exact multiple of dt */
  get time(): number {
    return this.stepIndex * this.dt;
  }

  /** how far the timeline has been computed, seconds */
  get computedUntil(): number {
    return this.maxStepIndex * this.dt;
  }

  /** ids of bodies alive at the current time, index-aligned with `state` */
  get aliveIds(): readonly string[] {
    return this.ids;
  }

  /**
   * Every body the timeline knows, including ones dead at the current time
   * (merged away or deleted mid-run) — the scene needs their metadata to render
   * a scrub back across the death. Saves filter with `staleBodyIds`.
   */
  get bodies(): readonly Body[] {
    return this.roster;
  }

  /** Merge events recorded so far, in time order. */
  get merges(): readonly MergeEvent[] {
    return this.mergeEvents;
  }

  /**
   * Roster entries dead when the last edit rebased the roster onto the
   * then-current state — absorbed by a merge, or removed by a deletion. They
   * stay in the roster because snapshots predating the death need their
   * metadata to render a scrub back, but a save must exclude them: a saved
   * stale entry resurrects the body on the next load, at whatever position it
   * holds.
   *
   * Empty while the roster is untouched initial conditions, where a save keeps
   * merged-away bodies deliberately — replaying from t = 0 re-runs the
   * collisions.
   */
  get staleBodyIds(): ReadonlySet<string> {
    return this.staleIds;
  }

  /** Subscribe to merges as they happen. Returns an unsubscribe function. */
  onMerge(listener: (event: MergeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rewind everything to t = 0 and rebuild state from the roster. */
  reset(): void {
    this.stepIndex = 0;
    this.maxStepIndex = 0;
    this.mergeEvents.length = 0;
    this.editEvents.length = 0;
    this.deletionEvents.length = 0;
    this.snapshots.clear();
    this.names.clear();
    // Every roster body is alive at t = 0, so none is stale.
    this.staleIds.clear();

    this.ids = this.roster.map((b) => b.id);
    for (const b of this.roster) this.names.set(b.id, b.name);

    const s = createState(this.roster.length);
    for (let i = 0; i < this.roster.length; i++) {
      const b = this.roster[i];
      const i3 = i * 3;
      s.mass[i] = b.mass;
      // The physics `radius` array is the collision size — see Body.collisionRadius.
      s.radius[i] = b.collisionRadius ?? b.radius;
      s.rs[i] = rsFor(b);
      s.pos[i3] = b.position.x;
      s.pos[i3 + 1] = b.position.y;
      s.pos[i3 + 2] = b.position.z;
      s.vel[i3] = b.velocity.x;
      s.vel[i3 + 1] = b.velocity.y;
      s.vel[i3 + 2] = b.velocity.z;
    }
    computeAccelerations(s);
    this.state = s;

    this.snapshots.record(0, this.ids, this.state);
  }

  /**
   * Step at fixed dt up to the last grid time ≤ `t`, recording snapshots on
   * interval. Returns true if it hit the step budget, meaning playback lags the
   * requested warp and the UI should show "computing…".
   *
   * Requesting a time before the current one is a no-op (use `seek`).
   */
  advanceTo(t: number, maxSteps = DEFAULT_MAX_STEPS): boolean {
    const targetIndex = Math.floor(t / this.dt);
    let remaining = targetIndex - this.stepIndex;
    if (remaining <= 0) return false;

    let budgetHit = false;
    if (remaining > maxSteps) {
      remaining = maxSteps;
      budgetHit = true;
    }

    let nextEdit = this.editEvents.findIndex((e) => e.stepIndex > this.stepIndex);

    for (let k = 0; k < remaining; k++) {
      step(this.state, this.dt, this.contacts);
      this.stepIndex += 1;
      const now = this.time;

      // Merges change mass/radius/roster, so they must run before the snapshot
      // that claims to describe this instant.
      if (this.contacts.pairs.length > 0) this.resolveCollisions(now);

      // Replaying across an edit restores its recorded outcome — integration
      // alone would compute a timeline where the edit never happened. After
      // the step and its merges, so merges at the same instant still re-emit;
      // the record already reflects them.
      const edit = nextEdit >= 0 ? this.editEvents[nextEdit] : undefined;
      if (edit !== undefined && edit.stepIndex === this.stepIndex) {
        this.state = copyState(edit.state);
        this.ids = edit.ids.slice();
        nextEdit += 1;
      }

      if (this.snapshots.shouldRecord(now)) {
        this.snapshots.record(now, this.ids, this.state);
      }
    }

    if (this.stepIndex > this.maxStepIndex) this.maxStepIndex = this.stepIndex;
    return budgetHit;
  }

  /**
   * Move to the largest grid time ≤ `t`. Backward moves restore the nearest
   * snapshot ≤ t and re-integrate from there; forward moves just extend.
   * Restore-and-replay is the same path that produced the original trajectory,
   * so seeking is exactly reproducible.
   */
  seek(t: number, maxSteps = Infinity): boolean {
    const targetIndex = Math.max(0, Math.floor(t / this.dt));
    const targetTime = targetIndex * this.dt;

    if (targetIndex === this.stepIndex) return false;

    if (targetIndex > this.stepIndex) return this.advanceTo(targetTime, maxSteps);

    const snapshot = this.snapshots.findAtOrBefore(targetTime);
    if (snapshot === null) {
      // Nothing stored at or before the target (possible only if t < 0 was
      // clamped away or the store was cleared): rebuild from the roster.
      this.reset();
    } else {
      this.restore(snapshot);
    }

    // Merge events after the restored time describe a future we are about to
    // recompute; drop them so replay re-emits them rather than double-counting.
    this.dropMergeEventsAfter(this.time);

    return this.advanceTo(targetTime, maxSteps);
  }

  /**
   * Drop snapshots and merge events after `t` — the future is invalidated.
   * Callers that changed body properties must also update the roster (see
   * `applyBodyEdits`).
   */
  invalidateAfter(t: number): void {
    this.snapshots.dropAfter(t);
    this.dropMergeEventsAfter(t);
    const index = Math.floor(t / this.dt);
    while (this.editEvents.length > 0 && this.editEvents[this.editEvents.length - 1].stepIndex > index) {
      this.editEvents.pop();
    }
    while (
      this.deletionEvents.length > 0 &&
      this.deletionEvents[this.deletionEvents.length - 1].t > t
    ) {
      this.deletionEvents.pop();
    }
    if (this.maxStepIndex > index) this.maxStepIndex = Math.max(index, this.stepIndex);
  }

  /**
   * Apply roster/property edits at the current time, never at t = 0. Live
   * bodies keep their position/velocity unless the edit supplies new ones; new
   * bodies enter at the current time; bodies already merged away stay dead (see
   * `staleBodyIds`). The future is invalidated and the current instant
   * re-snapshotted, so a seek back restores the edited values. The edit is also
   * recorded as an event `advanceTo` replays, so rewinding past it and playing
   * forward re-applies it at the same instant.
   *
   * `stateAuthoritative` names bodies whose roster position/velocity *are* the
   * edit (a drag, the editor's state-vector fields) and must be taken verbatim
   * even though the body is alive. Everyone else keeping their live state is
   * what makes a mass edit at year 3 not also a teleport back to the roster's
   * initial coordinates.
   *
   * A live body absent from `bodies` is a deletion *from now on*: its roster
   * entry is retained (snapshots before this instant still contain it, and the
   * scene needs its metadata to render a scrub back) and a DeletionEvent keeps
   * it dead through later edits. A deletion-dead body handed back
   * state-authoritative is revived at the given state — that's how undoing a
   * delete works. At t = 0 absence is a true removal instead, because there is
   * no past for the body to survive in.
   */
  applyBodyEdits(bodies: readonly Body[], stateAuthoritative?: ReadonlySet<string>): void {
    if (this.stepIndex === 0) {
      // At t = 0 the roster *is* the state, so a full rebuild is correct and
      // also resets the snapshot store's decimation.
      this.roster = bodies.map(cloneBody);
      this.reset();
      return;
    }

    const incoming = bodies.map(cloneBody);
    const incomingIds = new Set(incoming.map((b) => b.id));

    // Bodies the edit no longer carries stay in the roster with their old
    // entries — dropping them is what made a deleted star's planets orbit an
    // invisible mass after a scrub back. Positions are preserved so the list
    // order doesn't churn on every edit.
    const incomingById = new Map(incoming.map((b) => [b.id, b]));
    const known = new Set(this.roster.map((b) => b.id));
    this.roster = [
      ...this.roster.map((old) => incomingById.get(old.id) ?? old),
      ...incoming.filter((b) => !known.has(b.id)),
    ];
    for (const b of this.roster) this.names.set(b.id, b.name);

    const liveIndex = new Map<string, number>();
    for (let i = 0; i < this.ids.length; i++) liveIndex.set(this.ids[i], i);

    // A live body absent from the edit is being deleted right now. Recorded
    // into `deletionEvents` only after `invalidateAfter` below, so the list
    // stays time-ordered while future events are being truncated.
    const deletedNowIds = this.ids.filter((id) => !incomingIds.has(id));

    // A body absorbed at or before now stays dead. Its roster entry is kept
    // for pre-merge snapshots, but handing every roster body a state slot
    // resurrects it: an unrelated edit after a collision brought the absorbed
    // body back at its stale roster position, and autosave then persisted the
    // ghost so it replayed on every cold load.
    const dead = new Set<string>();
    for (const event of this.mergeEvents) {
      if (event.t <= this.time) dead.add(event.absorbedId);
    }
    // Same for a body deleted at or before now — unless this edit is the one
    // putting it back: alive again on this timeline (an earlier edit revived
    // it), or handed over state-authoritative (undo restoring a deleted body).
    for (const event of this.deletionEvents) {
      if (event.t > this.time) continue;
      const present =
        incomingIds.has(event.id) &&
        (liveIndex.has(event.id) || stateAuthoritative?.has(event.id) === true);
      if (!present) dead.add(event.id);
    }
    for (const id of deletedNowIds) dead.add(id);
    this.staleIds = dead;

    const enlivened = incoming.filter((b) => !dead.has(b.id));
    const next = createState(enlivened.length);
    const nextIds: string[] = [];

    for (let i = 0; i < enlivened.length; i++) {
      const b = enlivened[i];
      const i3 = i * 3;
      next.mass[i] = b.mass;
      next.radius[i] = b.collisionRadius ?? b.radius;
      next.rs[i] = rsFor(b);
      nextIds.push(b.id);

      const live = liveIndex.get(b.id);
      if (live === undefined || stateAuthoritative?.has(b.id)) {
        next.pos[i3] = b.position.x;
        next.pos[i3 + 1] = b.position.y;
        next.pos[i3 + 2] = b.position.z;
        next.vel[i3] = b.velocity.x;
        next.vel[i3 + 1] = b.velocity.y;
        next.vel[i3 + 2] = b.velocity.z;
      } else {
        const l3 = live * 3;
        next.pos[i3] = this.state.pos[l3];
        next.pos[i3 + 1] = this.state.pos[l3 + 1];
        next.pos[i3 + 2] = this.state.pos[l3 + 2];
        next.vel[i3] = this.state.vel[l3];
        next.vel[i3 + 1] = this.state.vel[l3 + 1];
        next.vel[i3 + 2] = this.state.vel[l3 + 2];
      }
    }

    computeAccelerations(next);
    this.state = next;
    this.ids = nextIds;

    // Drop the invalidated future, then overwrite any snapshot sitting exactly
    // at the current time with the post-edit state.
    this.invalidateAfter(this.time);
    this.snapshots.dropAfter(this.time - this.dt / 2);
    this.snapshots.record(this.time, this.ids, this.state);

    // Same replacement rule for the edit record: invalidateAfter kept only
    // events at or before now, and one exactly at now is superseded — a drag
    // commits dozens of edits at a single instant and only the last one is
    // the timeline.
    const last = this.editEvents[this.editEvents.length - 1];
    if (last !== undefined && last.stepIndex === this.stepIndex) this.editEvents.pop();
    this.editEvents.push({
      stepIndex: this.stepIndex,
      ids: this.ids.slice(),
      state: copyState(this.state),
    });

    for (const id of deletedNowIds) this.deletionEvents.push({ t: this.time, id });
  }

  /**
   * When an edit removed `id` from the timeline, seconds — the record behind a
   * "not present" readout, as seen from at or after the deletion. Null when the
   * body is alive at the current time (including deleted-then-revived) or no
   * deletion at or before now names it.
   */
  deletedAt(id: string): number | null {
    if (this.ids.includes(id)) return null;
    for (let i = this.deletionEvents.length - 1; i >= 0; i--) {
      const event = this.deletionEvents[i];
      if (event.id === id && event.t <= this.time) return event.t;
    }
    return null;
  }

  /**
   * Sim time of the last mid-timeline edit, seconds — the instant the roster
   * was last rebased onto, which is what every saved or shared copy will call
   * t = 0. Zero while the roster still holds true initial conditions (no edits,
   * or the last edit landed at t = 0 and rebuilt from scratch), so a nonzero
   * value means saving flattens history: the UI warns off it.
   */
  get lastEditTime(): number {
    const last = this.editEvents[this.editEvents.length - 1];
    return last === undefined ? 0 : last.stepIndex * this.dt;
  }

  /**
   * When `id` next enters the timeline, seconds — the recorded birth of a body
   * added mid-run, as seen from a time before it. Null when nothing ahead of
   * the current time introduces it.
   */
  appearsAt(id: string): number | null {
    for (const event of this.editEvents) {
      if (event.stepIndex <= this.stepIndex) continue;
      if (event.ids.includes(id)) return event.stepIndex * this.dt;
    }
    return null;
  }

  /**
   * Replace the roster and restart at t = 0.
   *
   * The timing grids may be changed here and only here, because a load resets
   * to t = 0 — the one moment there is no step grid or snapshot store to
   * reconcile. A system with short orbits (a satellite shell, a lunar free
   * return) needs finer grids to resolve them at all.
   *
   * Omitted grids fall back to the defaults, not the current values: they
   * belong to the system being loaded, so a previous system's 60 s dt must not
   * linger and make every subsequent load 10× slower.
   */
  load(bodies: readonly Body[], options: SimulationOptions = {}): void {
    this.dt = positiveOr(options.dt, DEFAULT_DT);
    this.snapshotInterval = positiveOr(options.snapshotInterval, DEFAULT_SNAPSHOT_INTERVAL);
    this.trailInterval = positiveOr(options.trailInterval, DEFAULT_TRAIL_INTERVAL);
    // The store holds its interval at construction and decimates from it, so a
    // changed interval needs a new one rather than a cleared one.
    this.snapshots = new SnapshotStore(this.snapshotInterval, this.maxSnapshots);
    this.roster = bodies.map(cloneBody);
    this.reset();
  }

  positionOf(id: string): { x: number; y: number; z: number } | null {
    const i = this.ids.indexOf(id);
    if (i < 0) return null;
    const i3 = i * 3;
    return { x: this.state.pos[i3], y: this.state.pos[i3 + 1], z: this.state.pos[i3 + 2] };
  }

  /** Deep copy of the live physics state — for throwaway forward integration. */
  cloneState(): PhysicsState {
    return copyState(this.state);
  }

  /**
   * Stored snapshots in `[from, to]`, oldest→newest — history on the snapshot
   * grid rather than the instants the render loop sampled. The scene rebuilds
   * trails from this after a seek or load; see `SnapshotStore.between`.
   */
  snapshotsBetween(from: number, to: number): readonly Snapshot[] {
    return this.snapshots.between(from, to);
  }

  /**
   * The three timing grids, in the shape `load` and the save format take. Lets
   * a save round-trip the loaded system's own grids rather than the defaults.
   */
  get timing(): Required<Pick<SimulationOptions, 'dt' | 'snapshotInterval' | 'trailInterval'>> {
    return {
      dt: this.dt,
      snapshotInterval: this.snapshotInterval,
      trailInterval: this.trailInterval,
    };
  }

  /** Sim-time spacing of retained snapshots; widens as decimation kicks in. */
  get snapshotSpacing(): number {
    return this.snapshots.interval;
  }

  private restore(snapshot: Snapshot): void {
    const n = snapshot.aliveIds.length;
    const s = createState(n);
    s.mass.set(snapshot.mass);
    s.radius.set(snapshot.radius);
    s.rs.set(snapshot.rs);
    s.pos.set(snapshot.pos);
    s.vel.set(snapshot.vel);
    computeAccelerations(s);

    this.state = s;
    this.ids = snapshot.aliveIds.slice();
    this.stepIndex = Math.round(snapshot.t / this.dt);
  }

  private dropMergeEventsAfter(t: number): void {
    let keep = this.mergeEvents.length;
    while (keep > 0 && this.mergeEvents[keep - 1].t > t) keep -= 1;
    this.mergeEvents.length = keep;
  }

  /**
   * Merge any pair whose true radii overlap. The more massive body survives,
   * taking the other's mass with a momentum-conserving velocity and a
   * mass-weighted position; the new radius comes from summed volumes.
   *
   * Pairs come from `computeAccelerations` during the step rather than a second
   * O(n²) sweep here, which at ~90 bodies cost as much as the gravity kernel to
   * report nothing almost every time.
   *
   * Only the first pair is merged per pass: merging moves the survivor and
   * grows its radius, so the rest of the list is stale the moment we touch it.
   * `removeBody` refreshes the contact list in the pass it already does, so the
   * loop re-reads fresh pairs for free. Index order keeps a three-way pile-up
   * resolving identically to a full rescan.
   */
  private resolveCollisions(t: number): void {
    while (this.contacts.pairs.length > 0) {
      const i = this.contacts.pairs[0];
      const j = this.contacts.pairs[1];
      const { mass, rs } = this.state;

      // A black hole always survives contact: anything reaching its collision
      // radius has crossed the horizon, whatever the mass ratio. Between two
      // of a kind, mass decides as usual.
      let survivor: number;
      if ((rs[i] > 0) !== (rs[j] > 0)) survivor = rs[i] > 0 ? i : j;
      else survivor = mass[i] >= mass[j] ? i : j;
      const absorbed = survivor === i ? j : i;
      this.merge(survivor, absorbed, t);
    }
  }

  private merge(survivor: number, absorbed: number, t: number): void {
    const { mass, radius, rs, pos, vel } = this.state;
    const mA = mass[survivor];
    const mB = mass[absorbed];
    const total = mA + mB;

    const s3 = survivor * 3;
    const a3 = absorbed * 3;

    for (let k = 0; k < 3; k++) {
      // Mass-weighted position, momentum-conserving velocity.
      pos[s3 + k] = (mA * pos[s3 + k] + mB * pos[a3 + k]) / total;
      vel[s3 + k] = (mA * vel[s3 + k] + mB * vel[a3 + k]) / total;
    }

    mass[survivor] = total;
    if (rs[survivor] > 0) {
      // The horizon is linear in mass, so volume-summing would understate the
      // growth. Keeps `rs` equal to schwarzschildRadius(mass), which the force
      // law and the dilation readout both assume.
      rs[survivor] = schwarzschildRadius(total);
      radius[survivor] = rs[survivor];
    } else {
      // Volumes add: r = (r₁³ + r₂³)^{1/3}.
      radius[survivor] = Math.cbrt(
        radius[survivor] ** 3 + radius[absorbed] ** 3
      );
    }

    const event: MergeEvent = {
      t,
      survivorId: this.ids[survivor],
      absorbedId: this.ids[absorbed],
      survivorName: this.names.get(this.ids[survivor]) ?? this.ids[survivor],
      absorbedName: this.names.get(this.ids[absorbed]) ?? this.ids[absorbed],
    };
    this.mergeEvents.push(event);

    this.removeBody(absorbed);

    for (const listener of this.listeners) listener(event);
  }

  /** Drop index `i` from the physics state and the id roster, compacting both. */
  private removeBody(i: number): void {
    const old = this.state;
    const n = old.n - 1;
    const next = createState(n);

    let w = 0;
    for (let r = 0; r < old.n; r++) {
      if (r === i) continue;
      next.mass[w] = old.mass[r];
      next.radius[w] = old.radius[r];
      next.rs[w] = old.rs[r];
      for (let k = 0; k < 3; k++) {
        next.pos[w * 3 + k] = old.pos[r * 3 + k];
        next.vel[w * 3 + k] = old.vel[r * 3 + k];
      }
      w += 1;
    }

    // Accelerations must be rebuilt: the absorbed body's pull is gone and the
    // survivor moved, and stale acc would corrupt the next Verlet step. The
    // same pass refreshes the contact list against the compacted indices, which
    // is what lets `resolveCollisions` loop safely — otherwise the list would
    // still name the body just removed.
    computeAccelerations(next, this.contacts);

    this.state = next;
    this.ids = this.ids.filter((_, index) => index !== i);
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
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

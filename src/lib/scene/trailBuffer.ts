// Orbit-trail bookkeeping, kept free of Three.js so it can be tested directly.
//
// Relative-frame rendering is the pointwise subtraction `trail[i] -
// refTrail[i]`, which only works if every body samples at *identical sim
// times*. Sampling is therefore driven by sim time on a fixed grid, never by
// frames, and every alive body is appended on the same tick. Bodies that appear
// or vanish mid-timeline still get a slot at every sample time, carrying an
// `alive` flag rather than being skipped, so a gap is a gap in the drawn line
// and not a shift in indices.

/** One sample time shared by all bodies. */
export interface TrailSample {
  t: number;
}

export interface TrailBufferOptions {
  /** sim-seconds between samples */
  interval: number;
  /** samples retained per body */
  capacity: number;
}

/**
 * A fixed-capacity ring of sim-time samples, with per-body xyz history stored
 * in index-aligned parallel arrays.
 *
 * Positions are in *scene units*, already divided by the scene scale — this is
 * a render-side structure and never feeds physics.
 */
export class TrailBuffer {
  /**
   * Sim-seconds between samples. Mutable only via `setInterval`, which clears:
   * retained samples sit on the old `k · interval` grid, and mixing two grids
   * in one ring makes the spacing silently wrong across the join.
   */
  private _interval: number;

  /**
   * Samples retained per body; the trail-length slider moves it at runtime.
   * Lowering trims the oldest immediately so the drawn trail shortens next
   * frame rather than waiting for the ring to fill.
   */
  private _capacity: number;

  /** sample times, oldest→newest, length ≤ capacity */
  private times: number[] = [];
  /** body id → xyz triples index-aligned with `times` */
  private tracks = new Map<string, number[]>();
  /** body id → per-sample alive flags, index-aligned with `times` */
  private alive = new Map<string, boolean[]>();

  /** sim time of the last recorded sample; -Infinity when empty */
  private lastSampleTime = -Infinity;

  /**
   * Sim time of the trailing live-state cap when the newest sample is one,
   * else null. The cap sits off both the snapshot and trail grids, so
   * `catchUp` replaces it rather than appending after it — otherwise every
   * high-warp frame leaves one frame-time vertex behind and they eat the ring.
   */
  private capTime: number | null = null;

  private _version = 0;

  constructor(options: TrailBufferOptions) {
    this._interval = options.interval;
    this._capacity = Math.max(2, Math.floor(options.capacity));
  }

  get interval(): number {
    return this._interval;
  }

  /** Re-grid the buffer. Clears, for the reason on `_interval`. */
  setInterval(next: number): void {
    if (!(next > 0) || next === this._interval) return;
    this._interval = next;
    this.clear();
  }

  get capacity(): number {
    return this._capacity;
  }

  set capacity(next: number) {
    const clamped = Math.max(2, Math.floor(next));
    if (clamped === this._capacity) return;
    this._capacity = clamped;
    if (this.times.length > clamped) this.dropOldest(this.times.length - clamped);
  }

  get length(): number {
    return this.times.length;
  }

  /**
   * Bumped on every content mutation, so the renderer can skip rebuilding
   * geometry that would come out identical — which is every frame while
   * paused, and every frame between samples while playing.
   */
  get version(): number {
    return this._version;
  }

  get sampleTimes(): readonly number[] {
    return this.times;
  }

  /** Sim time of the newest sample, -Infinity when empty — where catch-up resumes. */
  get newestTime(): number {
    return this.lastSampleTime;
  }

  /** Forget everything. Called on seek-backward, body edits, and system loads. */
  clear(): void {
    this.times.length = 0;
    this.tracks.clear();
    this.alive.clear();
    this.lastSampleTime = -Infinity;
    this.capTime = null;
    this._version += 1;
  }

  /**
   * True when `t` has crossed onto the next sample slot.
   *
   * Slots are on the fixed grid `k · interval`, not "interval seconds since the
   * last sample", so replaying a span at a different frame rate lands on the
   * same sample times and a rebuilt trail overlays the original exactly.
   */
  shouldSample(t: number): boolean {
    if (this.times.length === 0) return true;
    return Math.floor(t / this.interval) > Math.floor(this.lastSampleTime / this.interval);
  }

  /**
   * True when `t` is more than one slot past the last recorded sample — the sim
   * outran the render loop (high warp, autosave restore), so appending a single
   * point would draw a chord across the orbit. Callers should rebuild from a
   * denser source instead. False when empty: nothing skipped if nothing
   * recorded.
   */
  outranSampling(t: number): boolean {
    if (this.times.length === 0) return false;
    return Math.floor(t / this.interval) > Math.floor(this.lastSampleTime / this.interval) + 1;
  }

  /**
   * Append one sample for every currently-alive body.
   *
   * `positions` is xyz-interleaved and index-aligned with `aliveIds`. Bodies
   * known to the buffer but absent from `aliveIds` get a dead slot, preserving
   * index alignment across merges.
   */
  record(t: number, aliveIds: readonly string[], positions: ArrayLike<number>, scale: number): void {
    this.append(t, aliveIds, positions, scale);
    if (this.times.length > this.capacity) this.dropOldest(this.times.length - this.capacity);
  }

  /** `record` without the capacity trim, so batch callers can trim once. */
  private append(
    t: number,
    aliveIds: readonly string[],
    positions: ArrayLike<number>,
    scale: number,
    cap = false
  ): void {
    const slot = this.times.length;

    for (let i = 0; i < aliveIds.length; i++) {
      const id = aliveIds[i];
      let track = this.tracks.get(id);
      let flags = this.alive.get(id);

      if (!track || !flags) {
        // Pad a newly-seen body's history with dead slots so index i still
        // means "sample time times[i]".
        track = new Array<number>(slot * 3).fill(0);
        flags = new Array<boolean>(slot).fill(false);
        this.tracks.set(id, track);
        this.alive.set(id, flags);
      }

      const i3 = i * 3;
      track.push(positions[i3] / scale, positions[i3 + 1] / scale, positions[i3 + 2] / scale);
      flags.push(true);
    }

    // Bodies that didn't report this tick (merged away) still advance a slot.
    // The loop above gives every alive id a track, so an equal count means the
    // sets match and nobody needs a dead slot — the common case, worth skipping
    // the per-call Set.
    if (this.tracks.size > aliveIds.length) {
      const aliveSet = new Set(aliveIds);
      for (const [id, track] of this.tracks) {
        if (aliveSet.has(id)) continue;
        const flags = this.alive.get(id)!;
        if (flags.length > slot) continue;
        // Repeat the last position so the dead slot holds finite numbers; the
        // alive flag is what suppresses drawing.
        const n = track.length;
        const x = n >= 3 ? track[n - 3] : 0;
        const y = n >= 3 ? track[n - 2] : 0;
        const z = n >= 3 ? track[n - 1] : 0;
        track.push(x, y, z);
        flags.push(false);
      }
    }

    this.times.push(t);
    this.lastSampleTime = t;
    this.capTime = cap ? t : null;
    this._version += 1;
  }

  /**
   * Replace all history with `samples`, oldest→newest — used after a seek,
   * load, or autosave restore, where per-frame sampling would contribute one
   * point per thousands of steps and chord across the orbit.
   *
   * Each sample supplies its own `aliveIds`, so bodies that merged or appeared
   * mid-history keep their per-slot alive flags. Samples beyond `capacity` are
   * dropped from the oldest end.
   */
  rebuild(
    samples: readonly { t: number; aliveIds: readonly string[]; pos: ArrayLike<number> }[],
    scale: number,
    current?: { t: number; aliveIds: readonly string[]; pos: ArrayLike<number> }
  ): void {
    this.clear();
    const start = Math.max(0, samples.length - this.capacity);
    for (let i = start; i < samples.length; i++) {
      const sample = samples[i];
      this.append(sample.t, sample.aliveIds, sample.pos, scale);
    }

    // Cap with the live state. Snapshots trail the current time by up to their
    // own spacing, so without this the buffer stays a slot behind, still reads
    // as outrunning the grid, and rebuilds again every frame.
    if (current && current.t > this.lastSampleTime) {
      this.append(current.t, current.aliveIds, current.pos, scale, true);
    }
    if (this.times.length > this.capacity) this.dropOldest(this.times.length - this.capacity);
  }

  /**
   * Extend snapshot-derived history forward to `current` without discarding
   * the ring. At high warp the sim outruns the sample grid on *every* frame,
   * and a full `rebuild` there is O(capacity × bodies) per frame plus
   * reallocating every track — this appends only what the frame added.
   *
   * Only valid while existing history is still good; seeks, regrids and
   * capacity growth invalidate it and must `rebuild`.
   */
  catchUp(
    samples: readonly { t: number; aliveIds: readonly string[]; pos: ArrayLike<number> }[],
    scale: number,
    current: { t: number; aliveIds: readonly string[]; pos: ArrayLike<number> }
  ): void {
    if (this.capTime !== null) this.dropNewest(1);
    for (const sample of samples) {
      if (sample.t <= this.lastSampleTime) continue;
      this.append(sample.t, sample.aliveIds, sample.pos, scale);
    }
    if (current.t > this.lastSampleTime) {
      this.append(current.t, current.aliveIds, current.pos, scale, true);
    }
    if (this.times.length > this.capacity) this.dropOldest(this.times.length - this.capacity);
  }

  /** Drop a body entirely (deleted from the roster, not merged). */
  forget(id: string): void {
    this.tracks.delete(id);
    this.alive.delete(id);
    this._version += 1;
  }

  get trackedIds(): IterableIterator<string> {
    return this.tracks.keys();
  }

  /**
   * Per-slot alive flags for `id`, index-aligned with `sampleTimes`. Exposed
   * for tests and debugging, since `pointsFor` hides the alignment by returning
   * only the newest alive run.
   */
  aliveFlagsFor(id: string): readonly boolean[] {
    return this.alive.get(id) ?? [];
  }

  /**
   * Build the drawable point list for `id` in the frame of `referenceId`
   * (null = inertial/barycentric).
   *
   * Returns xyz triples for the newest run of samples where both the body and
   * the reference are alive, oldest→newest; a trail outliving its reference
   * body would otherwise draw against a stale origin.
   *
   * `limit` caps how many of the newest samples are returned, so callers can
   * draw different lengths per body from one shared history. `oldest` bounds
   * by sample time instead — the ring can hold mixed sample spacing (fine
   * live-sampled history after a coarse snapshot rebuild), so only a time
   * bound draws the same sim-span either way; a count there quietly draws the
   * coarse history several times longer.
   */
  pointsFor(id: string, referenceId: string | null, limit = Infinity, oldest = -Infinity): Float32Array {
    const count = this.countFor(id, referenceId, limit, oldest);
    if (count === 0) return EMPTY;
    const out = new Float32Array(count * 3);
    this.copyPointsInto(id, referenceId, count, out);
    return out;
  }

  /**
   * The number of points `pointsFor` would return: the newest run of samples
   * where both the body and the reference are alive, capped by `limit` and by
   * sample time ≥ `oldest`; 0 when fewer than two (nothing drawable). Split
   * from the copy so the renderer can size its GPU-side array before filling
   * it in place — allocating a fresh return array per body per frame was a
   * measured GC hotspot at high warp.
   */
  countFor(id: string, referenceId: string | null, limit = Infinity, oldest = -Infinity): number {
    const flags = this.alive.get(id);
    if (!this.tracks.has(id) || !flags || flags.length === 0) return 0;

    const refFlags = referenceId === null ? null : (this.alive.get(referenceId) ?? null);
    if (referenceId !== null && (!refFlags || !this.tracks.has(referenceId))) return 0;

    // Walk back over the alive run, stopping once `limit` points are gathered.
    const last = flags.length - 1;
    const stop = Number.isFinite(limit) ? Math.max(0, last - Math.max(0, Math.floor(limit)) + 1) : 0;
    let first = last;
    while (first >= stop) {
      if (!flags[first]) break;
      if (refFlags && !refFlags[first]) break;
      if (this.times[first] < oldest) break;
      first -= 1;
    }
    first += 1;

    const count = last - first + 1;
    return count < 2 ? 0 : count;
  }

  /**
   * Write the `count` newest drawable points for `id` into `out` as xyz
   * triples, oldest→newest, reference-relative. `count` must come from a
   * `countFor` call with the same arguments and no buffer mutation in between
   * — it is what locates the run — and `out` must hold at least `count · 3`.
   */
  copyPointsInto(id: string, referenceId: string | null, count: number, out: Float32Array): void {
    const track = this.tracks.get(id);
    const flags = this.alive.get(id);
    if (!track || !flags) return;
    const refTrack = referenceId === null ? null : (this.tracks.get(referenceId) ?? null);
    if (referenceId !== null && !refTrack) return;

    const first = flags.length - count;
    for (let k = 0; k < count; k++) {
      const s = (first + k) * 3;
      const o = k * 3;
      if (refTrack) {
        out[o] = track[s] - refTrack[s];
        out[o + 1] = track[s + 1] - refTrack[s + 1];
        out[o + 2] = track[s + 2] - refTrack[s + 2];
      } else {
        out[o] = track[s];
        out[o + 1] = track[s + 1];
        out[o + 2] = track[s + 2];
      }
    }
  }

  /** Discard the `count` newest samples, keeping every track aligned. */
  private dropNewest(count: number): void {
    const keep = Math.max(0, this.times.length - count);
    this.times.length = keep;
    for (const track of this.tracks.values()) track.length = keep * 3;
    for (const flags of this.alive.values()) flags.length = keep;
    this.lastSampleTime = keep > 0 ? this.times[keep - 1] : -Infinity;
    this.capTime = null;
    this._version += 1;
  }

  /** Discard the `count` oldest samples, keeping every track aligned. */
  private dropOldest(count: number): void {
    this.times.splice(0, count);
    for (const track of this.tracks.values()) track.splice(0, count * 3);
    for (const flags of this.alive.values()) flags.splice(0, count);
    this._version += 1;
  }
}

const EMPTY = new Float32Array(0);

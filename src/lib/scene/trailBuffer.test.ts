import { describe, expect, it } from 'vitest';
import { TrailBuffer } from './trailBuffer';

/** Build an xyz-interleaved position array from per-body triples (in meters). */
function positions(...triples: [number, number, number][]): Float64Array {
  const out = new Float64Array(triples.length * 3);
  triples.forEach(([x, y, z], i) => {
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  });
  return out;
}

const SCALE = 1; // keep test numbers readable; scaling is a plain divide

describe('TrailBuffer sampling', () => {
  it('samples on a fixed sim-time grid, not per call', () => {
    const buffer = new TrailBuffer({ interval: 100, capacity: 10 });

    expect(buffer.shouldSample(0)).toBe(true);
    buffer.record(0, ['a'], positions([0, 0, 0]), SCALE);

    // Still inside the first slot.
    expect(buffer.shouldSample(50)).toBe(false);
    expect(buffer.shouldSample(99)).toBe(false);
    // Crossed onto the next.
    expect(buffer.shouldSample(100)).toBe(true);
  });

  it('lands one sample per grid slot regardless of call cadence', () => {
    const fine = new TrailBuffer({ interval: 100, capacity: 100 });
    const coarse = new TrailBuffer({ interval: 100, capacity: 100 });

    // A "60 fps" caller and a "10 fps" caller over the same span.
    for (let t = 0; t <= 1000; t += 10) {
      if (fine.shouldSample(t)) fine.record(t, ['a'], positions([t, 0, 0]), SCALE);
    }
    for (let t = 0; t <= 1000; t += 60) {
      if (coarse.shouldSample(t)) coarse.record(t, ['a'], positions([t, 0, 0]), SCALE);
    }

    // Neither caller ever double-samples a slot, and both walk consecutive
    // slots from 0 — the grid is what makes a rebuilt trail overlay the
    // original. (The two need not end on the same slot: a coarse caller can
    // stop stepping before it observes the last one.)
    const fineSlots = fine.sampleTimes.map((t) => Math.floor(t / 100));
    const coarseSlots = coarse.sampleTimes.map((t) => Math.floor(t / 100));

    expect(fineSlots).toEqual(fineSlots.map((_, i) => i));
    expect(coarseSlots).toEqual(coarseSlots.map((_, i) => i));
    expect(coarseSlots).toEqual(fineSlots.slice(0, coarseSlots.length));
  });

  it('divides positions by the scene scale', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });
    buffer.record(0, ['a'], positions([1e9, 2e9, 3e9]), 1e9);
    buffer.record(1, ['a'], positions([2e9, 4e9, 6e9]), 1e9);

    const points = buffer.pointsFor('a', null);
    expect(Array.from(points)).toEqual([1, 2, 3, 2, 4, 6]);
  });
});

describe('TrailBuffer reference frames', () => {
  it('subtracts the reference body pointwise', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });

    // Earth moves along x; the Moon sits 1 unit ahead of it the whole time.
    for (let t = 0; t < 4; t++) {
      buffer.record(t, ['earth', 'moon'], positions([t, 0, 0], [t + 1, 0, 0]), SCALE);
    }

    const inertial = buffer.pointsFor('moon', null);
    expect(Array.from(inertial)).toEqual([1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]);

    // In Earth's frame the Moon is stationary at x = 1 — the helix collapses.
    const relative = buffer.pointsFor('moon', 'earth');
    expect(Array.from(relative)).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
  });

  it('keeps indices aligned when a body appears mid-buffer', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });

    buffer.record(0, ['a'], positions([0, 0, 0]), SCALE);
    buffer.record(1, ['a'], positions([1, 0, 0]), SCALE);
    // 'b' shows up two slots late; its history is back-padded as dead so slot i
    // still means sampleTimes[i] for every body.
    buffer.record(2, ['a', 'b'], positions([2, 0, 0], [20, 0, 0]), SCALE);
    buffer.record(3, ['a', 'b'], positions([3, 0, 0], [30, 0, 0]), SCALE);

    // Only the run where both are alive is drawn.
    const relative = buffer.pointsFor('b', 'a');
    expect(Array.from(relative)).toEqual([18, 0, 0, 27, 0, 0]);
  });

  it('stops the trail at a merge rather than misaligning it', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });

    buffer.record(0, ['a', 'b'], positions([0, 0, 0], [10, 0, 0]), SCALE);
    buffer.record(1, ['a', 'b'], positions([1, 0, 0], [11, 0, 0]), SCALE);
    // 'b' is absorbed: it stops reporting, but still advances a slot.
    buffer.record(2, ['a'], positions([2, 0, 0]), SCALE);
    buffer.record(3, ['a'], positions([3, 0, 0]), SCALE);

    // 'a' keeps a full trail...
    expect(buffer.pointsFor('a', null).length / 3).toBe(4);
    // ...while 'b', dead at the newest sample, draws nothing.
    expect(buffer.pointsFor('b', null).length).toBe(0);
  });

  // One shared history, drawn at different lengths per body — this is how the
  // selected body shows more of its orbit than everything else in the scene.
  describe('per-call limit', () => {
    const filled = () => {
      const buffer = new TrailBuffer({ interval: 1, capacity: 100 });
      for (let t = 0; t < 10; t++) buffer.record(t, ['a'], positions([t, 0, 0]), SCALE);
      return buffer;
    };

    it('returns only the newest `limit` samples', () => {
      const points = filled().pointsFor('a', null, 3);
      // Newest three, still oldest→newest.
      expect(Array.from(points)).toEqual([7, 0, 0, 8, 0, 0, 9, 0, 0]);
    });

    it('draws the full history when the limit exceeds it', () => {
      expect(filled().pointsFor('a', null, 500).length / 3).toBe(10);
      expect(filled().pointsFor('a', null).length / 3).toBe(10);
    });

    it('does not disturb the shared buffer, so a longer draw still works after a shorter one', () => {
      const buffer = filled();
      expect(buffer.pointsFor('a', null, 2).length / 3).toBe(2);
      expect(buffer.pointsFor('a', null, 10).length / 3).toBe(10);
    });

    it('still honours the alive run inside the limit', () => {
      const buffer = new TrailBuffer({ interval: 1, capacity: 100 });
      buffer.record(0, ['a', 'b'], positions([0, 0, 0], [10, 0, 0]), SCALE);
      buffer.record(1, ['a'], positions([1, 0, 0]), SCALE); // b dies
      buffer.record(2, ['a', 'b'], positions([2, 0, 0], [12, 0, 0]), SCALE); // and returns
      buffer.record(3, ['a', 'b'], positions([3, 0, 0], [13, 0, 0]), SCALE);

      // A generous limit can't reach past the gap at slot 1.
      expect(Array.from(buffer.pointsFor('b', null, 99))).toEqual([12, 0, 0, 13, 0, 0]);
    });

    it('yields nothing when the limit leaves fewer than two points', () => {
      expect(filled().pointsFor('a', null, 1).length).toBe(0);
      expect(filled().pointsFor('a', null, 0).length).toBe(0);
    });
  });

  // The renderer bounds drawn length by *time*, not count: a snapshot rebuild
  // fills the ring on a coarser grid than live sampling, and a count sized for
  // the fine grid drew several times the intended sim-span of coarse history.
  describe('per-call oldest bound', () => {
    it('returns only samples at or after `oldest`, across mixed spacing', () => {
      const buffer = new TrailBuffer({ interval: 1, capacity: 100 });
      // Coarse rebuild history (every 4), then fine live samples (every 1).
      for (let t = 0; t <= 16; t += 4) buffer.record(t, ['a'], positions([t, 0, 0]), SCALE);
      for (let t = 17; t <= 20; t++) buffer.record(t, ['a'], positions([t, 0, 0]), SCALE);

      const points = buffer.pointsFor('a', null, Infinity, 12);
      expect(Array.from(points)).toEqual([
        12, 0, 0, 16, 0, 0, 17, 0, 0, 18, 0, 0, 19, 0, 0, 20, 0, 0
      ]);
    });

    it('yields nothing when the bound leaves fewer than two points', () => {
      const buffer = new TrailBuffer({ interval: 1, capacity: 100 });
      for (let t = 0; t < 5; t++) buffer.record(t, ['a'], positions([t, 0, 0]), SCALE);
      expect(buffer.pointsFor('a', null, Infinity, 4).length).toBe(0);
    });
  });

  // The renderer sizes the geometry from countFor, then fills its attribute
  // array in place — writing past count or allocating would defeat the point.
  it('fills a caller-owned array in place, touching only count·3 slots', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });
    buffer.record(0, ['a', 'r'], positions([1, 2, 3], [1, 0, 0]), SCALE);
    buffer.record(1, ['a', 'r'], positions([4, 5, 6], [2, 0, 0]), SCALE);

    const count = buffer.countFor('a', 'r');
    expect(count).toBe(2);

    // Oversized and pre-poisoned, the way a grown geometry buffer would be.
    const out = new Float32Array(count * 3 + 3).fill(9);
    buffer.copyPointsInto('a', 'r', count, out);

    expect(Array.from(out)).toEqual([0, 2, 3, 2, 5, 6, 9, 9, 9]);
    expect(Array.from(buffer.pointsFor('a', 'r'))).toEqual([0, 2, 3, 2, 5, 6]);
  });

  it('returns nothing for an unknown body or unknown reference', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });
    buffer.record(0, ['a'], positions([0, 0, 0]), SCALE);
    buffer.record(1, ['a'], positions([1, 0, 0]), SCALE);

    expect(buffer.pointsFor('nope', null).length).toBe(0);
    expect(buffer.pointsFor('a', 'nope').length).toBe(0);
  });
});

// Regression: a satellite thousands of scene units from the origin drew a
// jumpy trail when zoomed close — absolute float32 vertices quantize to
// hundreds of km at that magnitude. The renderer rebases each trail around its
// newest point and carries the offset in the line transform instead.
describe('TrailBuffer rebase origin', () => {
  it('subtracts the origin in float64, before the float32 narrowing', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });
    // ~3000 scene units out, moving 1e-5 units per sample — well below
    // float32 resolution at that magnitude (~2.4e-4).
    buffer.record(0, ['a'], positions([3000, 0, 0]), SCALE);
    buffer.record(1, ['a'], positions([3000.00001, 0, 0]), SCALE);

    // Without a rebase the motion collapses entirely.
    const absolute = buffer.pointsFor('a', null);
    expect(absolute[3] - absolute[0]).toBe(0);

    const origin = { x: 0, y: 0, z: 0 };
    expect(buffer.newestPointInto('a', null, origin)).toBe(true);
    expect(origin.x).toBe(3000.00001);

    const out = new Float32Array(6);
    buffer.copyPointsInto('a', null, 2, out, origin.x, origin.y, origin.z);
    // The newest point lands exactly on the origin; the older one keeps the
    // sub-float32 offset.
    expect(out[3]).toBe(0);
    expect(out[0]).toBeCloseTo(-1e-5, 9);
  });

  it('newestPointInto is reference-relative and reports unknown tracks', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });
    buffer.record(0, ['a', 'r'], positions([5, 0, 0], [1, 0, 0]), SCALE);
    buffer.record(1, ['a', 'r'], positions([7, 1, 0], [2, 0, 0]), SCALE);

    const out = { x: NaN, y: NaN, z: NaN };
    expect(buffer.newestPointInto('a', 'r', out)).toBe(true);
    expect([out.x, out.y, out.z]).toEqual([5, 1, 0]);

    expect(buffer.newestPointInto('nope', null, out)).toBe(false);
    expect(buffer.newestPointInto('a', 'nope', out)).toBe(false);
  });
});

describe('TrailBuffer capacity', () => {
  it('drops the oldest samples while keeping every track aligned', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 3 });

    for (let t = 0; t < 6; t++) {
      buffer.record(t, ['a', 'b'], positions([t, 0, 0], [t + 100, 0, 0]), SCALE);
    }

    expect(buffer.length).toBe(3);
    expect(Array.from(buffer.sampleTimes)).toEqual([3, 4, 5]);

    expect(Array.from(buffer.pointsFor('a', null))).toEqual([3, 0, 0, 4, 0, 0, 5, 0, 0]);
    // Alignment survives the drop: b − a is still a constant 100.
    expect(Array.from(buffer.pointsFor('b', 'a'))).toEqual([100, 0, 0, 100, 0, 0, 100, 0, 0]);
  });

  // The trail-length slider moves capacity at runtime.
  it('lowering capacity trims the oldest samples immediately', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });
    for (let t = 0; t < 8; t++) {
      buffer.record(t, ['a', 'b'], positions([t, 0, 0], [t + 100, 0, 0]), SCALE);
    }

    buffer.capacity = 3;

    expect(buffer.capacity).toBe(3);
    expect(Array.from(buffer.sampleTimes)).toEqual([5, 6, 7]);
    // Index alignment has to survive the trim, same as an organic drop.
    expect(Array.from(buffer.pointsFor('b', 'a'))).toEqual([100, 0, 0, 100, 0, 0, 100, 0, 0]);
  });

  it('raising capacity keeps existing history and accumulates further', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 3 });
    for (let t = 0; t < 5; t++) buffer.record(t, ['a'], positions([t, 0, 0]), SCALE);
    expect(Array.from(buffer.sampleTimes)).toEqual([2, 3, 4]);

    buffer.capacity = 6;
    for (let t = 5; t < 8; t++) buffer.record(t, ['a'], positions([t, 0, 0]), SCALE);

    // Nothing already held was discarded, and the ring now holds more.
    expect(Array.from(buffer.sampleTimes)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('clear() resets sampling so the next call records', () => {
    const buffer = new TrailBuffer({ interval: 100, capacity: 10 });
    buffer.record(0, ['a'], positions([0, 0, 0]), SCALE);
    buffer.record(100, ['a'], positions([1, 0, 0]), SCALE);

    buffer.clear();

    expect(buffer.length).toBe(0);
    expect(buffer.pointsFor('a', null).length).toBe(0);
    // After a seek-backward clear, the very next frame must re-seed the trail
    // even though sim time hasn't crossed a new slot.
    expect(buffer.shouldSample(50)).toBe(true);
  });

  // Regression: trails drawn during an autosave catch-up came out as stars /
  // polygons rather than ellipses. Sampling is driven from the render loop, so
  // a frame that advances the sim by thousands of steps contributes exactly one
  // point — and the line then chords straight across the orbit between them.
  // Rebuilding from snapshots restores the path the sim actually took.
  describe('rebuild from snapshots', () => {
    /** A body on a unit circle sampled every `step` radians. */
    const circle = (step: number, count: number, from = 0) =>
      Array.from({ length: count }, (_, k) => {
        const angle = from + k * step;
        return {
          t: k * 100,
          aliveIds: ['a'] as readonly string[],
          pos: positions([Math.cos(angle), Math.sin(angle), 0]),
        };
      });

    /** Largest gap between consecutive drawn points — the jaggedness measure. */
    function longestChord(points: Float32Array): number {
      let worst = 0;
      for (let i = 3; i < points.length; i += 3) {
        worst = Math.max(
          worst,
          Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2], points[i + 2] - points[i - 1])
        );
      }
      return worst;
    }

    it('replaces sparse frame-sampled history with dense snapshot history', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 500 });

      // What a catch-up produces: three frames, each a third of the way round.
      const stride = (2 * Math.PI) / 3;
      buffer.record(0, ['a'], positions([1, 0, 0]), SCALE);
      buffer.record(100, ['a'], positions([Math.cos(stride), Math.sin(stride), 0]), SCALE);
      buffer.record(200, ['a'], positions([Math.cos(2 * stride), Math.sin(2 * stride), 0]), SCALE);

      // A triangle inscribed in the unit circle: chords of ~1.73.
      expect(longestChord(buffer.pointsFor('a', null))).toBeGreaterThan(1.5);

      buffer.rebuild(circle((2 * Math.PI) / 60, 60), SCALE);

      expect(buffer.length).toBe(60);
      // 60 points around the same circle: chords under a tenth of the radius.
      expect(longestChord(buffer.pointsFor('a', null))).toBeLessThan(0.11);
    });

    it('keeps only the newest `capacity` samples', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 10 });
      buffer.rebuild(circle(0.1, 25), SCALE);

      expect(buffer.length).toBe(10);
      // The newest 10 of 25, so times 1500…2400.
      expect(buffer.sampleTimes[0]).toBe(1500);
      expect(buffer.sampleTimes[9]).toBe(2400);
    });

    it('preserves index alignment when a body dies partway through', () => {
      const buffer = new TrailBuffer({ interval: 1, capacity: 100 });

      buffer.rebuild(
        [
          { t: 0, aliveIds: ['a', 'b'], pos: positions([0, 0, 0], [10, 0, 0]) },
          { t: 1, aliveIds: ['a', 'b'], pos: positions([1, 0, 0], [11, 0, 0]) },
          // b merges away here.
          { t: 2, aliveIds: ['a'], pos: positions([2, 0, 0]) },
          { t: 3, aliveIds: ['a'], pos: positions([3, 0, 0]) },
        ],
        SCALE
      );

      expect(buffer.length).toBe(4);
      // a's full history survives...
      expect(Array.from(buffer.pointsFor('a', null))).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);

      // ...and b, whose newest slots are dead, draws nothing: `pointsFor`
      // returns only the newest alive run, so a merged body's stale trail
      // doesn't linger, and neither does a trail drawn against it as a
      // reference frame.
      expect(Array.from(buffer.pointsFor('b', null))).toEqual([]);
      expect(Array.from(buffer.pointsFor('a', 'b'))).toEqual([]);

      // The slots themselves stay aligned, which is the invariant that makes
      // the relative-frame subtraction valid: b occupies one slot per sample
      // time, with the last two flagged dead rather than omitted. Were they
      // omitted, b's index 2 would mean t = 3 while a's meant t = 2.
      expect(buffer.sampleTimes).toEqual([0, 1, 2, 3]);
      expect(buffer.aliveFlagsFor('b')).toEqual([true, true, false, false]);
    });

    it('starts clean, discarding any prior history', () => {
      const buffer = new TrailBuffer({ interval: 1, capacity: 100 });
      buffer.record(0, ['old'], positions([9, 9, 9]), SCALE);

      buffer.rebuild(circle(0.1, 5), SCALE);

      expect([...buffer.trackedIds]).toEqual(['a']);
      expect(buffer.pointsFor('old', null).length).toBe(0);
    });

    it('leaves the buffer empty and re-seedable when there are no snapshots', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 10 });
      buffer.record(0, ['a'], positions([1, 0, 0]), SCALE);

      buffer.rebuild([], SCALE);

      expect(buffer.length).toBe(0);
      expect(buffer.shouldSample(0)).toBe(true);
    });

    // Snapshots lag the current time by up to their own spacing. Without
    // capping the rebuild with live state, the buffer stays behind the sample
    // grid and every subsequent frame rebuilds again.
    it('caps history with the live state so it is not left behind the grid', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 50 });
      const snapshots = [
        { t: 0, aliveIds: ['a'], pos: positions([0, 0, 0]) },
        { t: 500, aliveIds: ['a'], pos: positions([5, 0, 0]) },
      ];

      buffer.rebuild(snapshots, SCALE, { t: 900, aliveIds: ['a'], pos: positions([9, 0, 0]) });

      expect(Array.from(buffer.sampleTimes)).toEqual([0, 500, 900]);
      expect(buffer.outranSampling(900)).toBe(false);
      expect(buffer.outranSampling(950)).toBe(false);
    });

    it('ignores a live state that is not newer than the last snapshot', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 50 });
      buffer.rebuild([{ t: 500, aliveIds: ['a'], pos: positions([5, 0, 0]) }], SCALE, {
        t: 500,
        aliveIds: ['a'],
        pos: positions([5, 0, 0]),
      });

      expect(Array.from(buffer.sampleTimes)).toEqual([500]);
    });
  });

  // The per-frame path at high warp: rebuild is O(capacity × bodies), so once
  // the sim outruns the grid every frame, only the new snapshots are appended.
  describe('catch-up from snapshots', () => {
    const snap = (t: number, x: number) => ({
      t,
      aliveIds: ['a'] as readonly string[],
      pos: positions([x, 0, 0]),
    });
    const live = (t: number, x: number) => ({ t, aliveIds: ['a'], pos: positions([x, 0, 0]) });

    it('extends history to match what a full rebuild would produce', () => {
      const whole = [snap(0, 0), snap(500, 5), snap(1000, 10), snap(1500, 15)];

      const rebuilt = new TrailBuffer({ interval: 100, capacity: 50 });
      rebuilt.rebuild(whole, SCALE, live(1700, 17));

      const caught = new TrailBuffer({ interval: 100, capacity: 50 });
      caught.rebuild(whole.slice(0, 2), SCALE, live(700, 7));
      caught.catchUp(whole.slice(2), SCALE, live(1700, 17));

      expect(Array.from(caught.sampleTimes)).toEqual(Array.from(rebuilt.sampleTimes));
      expect(Array.from(caught.pointsFor('a', null))).toEqual(
        Array.from(rebuilt.pointsFor('a', null))
      );
      expect(caught.outranSampling(1700)).toBe(false);
    });

    it('replaces the previous live-state cap instead of accumulating one per frame', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 50 });
      buffer.rebuild([snap(0, 0), snap(500, 5)], SCALE, live(690, 6.9));

      // Two frames before the next snapshot lands: the cap moves, the ring
      // doesn't grow.
      buffer.catchUp([], SCALE, live(780, 7.8));
      buffer.catchUp([], SCALE, live(870, 8.7));

      expect(Array.from(buffer.sampleTimes)).toEqual([0, 500, 870]);
    });

    it('keeps a grid sample recorded after the cap', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 50 });
      buffer.rebuild([snap(0, 0)], SCALE, live(150, 1.5));
      // Ordinary per-frame sampling takes over for a while...
      buffer.record(200, ['a'], positions([2, 0, 0]), SCALE);
      // ...then a high-warp frame catches up again: 200 is history, not a cap.
      buffer.catchUp([snap(500, 5)], SCALE, live(640, 6.4));

      expect(Array.from(buffer.sampleTimes)).toEqual([0, 150, 200, 500, 640]);
    });

    it('drops the oldest samples past capacity', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 3 });
      buffer.rebuild([snap(0, 0), snap(500, 5)], SCALE);
      buffer.catchUp([snap(1000, 10), snap(1500, 15)], SCALE, live(1600, 16));

      expect(Array.from(buffer.sampleTimes)).toEqual([1000, 1500, 1600]);
    });

    it('ignores snapshots not newer than the recorded history', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 50 });
      buffer.rebuild([snap(0, 0), snap(500, 5)], SCALE);

      // The fetch window is inclusive, so the newest sample can come back.
      buffer.catchUp([snap(500, 5), snap(1000, 10)], SCALE, live(1000, 10));

      expect(Array.from(buffer.sampleTimes)).toEqual([0, 500, 1000]);
    });
  });

  // The trigger for rebuilding: sampling is driven per frame, so it only keeps
  // up while the sim advances less than one interval per frame.
  describe('outranSampling', () => {
    it('is false while the sim advances at most one slot per frame', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 10 });
      buffer.record(0, ['a'], positions([0, 0, 0]), SCALE);

      expect(buffer.outranSampling(50)).toBe(false);
      expect(buffer.outranSampling(100)).toBe(false);
      expect(buffer.outranSampling(199)).toBe(false);
    });

    it('is true once a frame skips a whole slot', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 10 });
      buffer.record(0, ['a'], positions([0, 0, 0]), SCALE);

      expect(buffer.outranSampling(200)).toBe(true);
      // What a catch-up actually looks like: 35 days at a 6-hour interval.
      expect(buffer.outranSampling(140 * 100)).toBe(true);
    });

    it('is false when empty — nothing has been skipped yet', () => {
      const buffer = new TrailBuffer({ interval: 100, capacity: 10 });
      expect(buffer.outranSampling(1e9)).toBe(false);
    });
  });

  it('forget() drops a deleted body without disturbing the rest', () => {
    const buffer = new TrailBuffer({ interval: 1, capacity: 10 });
    buffer.record(0, ['a', 'b'], positions([0, 0, 0], [10, 0, 0]), SCALE);
    buffer.record(1, ['a', 'b'], positions([1, 0, 0], [11, 0, 0]), SCALE);

    buffer.forget('b');

    expect([...buffer.trackedIds]).toEqual(['a']);
    expect(Array.from(buffer.pointsFor('a', null))).toEqual([0, 0, 0, 1, 0, 0]);
  });
});

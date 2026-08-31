import { describe, expect, it } from 'vitest';
import { SnapshotStore } from './snapshots';
import { createState, type PhysicsState } from '../physics/integrator';
import { DAY } from '../physics/constants';

/** A one-body state whose position encodes `value`, so restores are checkable. */
function stateAt(value: number): PhysicsState {
  const s = createState(1);
  s.mass[0] = 1;
  s.radius[0] = 1;
  s.pos[0] = value;
  s.vel[0] = value * 2;
  return s;
}

describe('SnapshotStore', () => {
  it('finds the latest snapshot at or before a time', () => {
    const store = new SnapshotStore(DAY);
    for (let d = 0; d <= 5; d++) store.record(d * DAY, ['a'], stateAt(d));

    expect(store.findAtOrBefore(3 * DAY)?.t).toBe(3 * DAY);
    expect(store.findAtOrBefore(3.7 * DAY)?.t).toBe(3 * DAY);
    expect(store.findAtOrBefore(100 * DAY)?.t).toBe(5 * DAY);
    expect(store.findAtOrBefore(0)?.t).toBe(0);
  });

  it('returns null when nothing precedes the requested time', () => {
    const store = new SnapshotStore(DAY);
    store.record(5 * DAY, ['a'], stateAt(5));
    expect(store.findAtOrBefore(DAY)).toBeNull();
  });

  it('copies state rather than aliasing it', () => {
    const store = new SnapshotStore(DAY);
    const live = stateAt(1);
    store.record(0, ['a'], live);

    live.pos[0] = 999;
    expect(store.findAtOrBefore(0)?.pos[0]).toBe(1);
  });

  it('copies the roster rather than aliasing it', () => {
    const store = new SnapshotStore(DAY);
    const ids = ['a', 'b'];
    store.record(0, ids, stateAt(1));

    ids.push('c');
    expect(store.findAtOrBefore(0)?.aliveIds).toEqual(['a', 'b']);
  });

  it('records on interval, not on every offered time', () => {
    const store = new SnapshotStore(DAY);
    expect(store.shouldRecord(0)).toBe(true);
    store.record(0, ['a'], stateAt(0));

    expect(store.shouldRecord(0.5 * DAY)).toBe(false);
    expect(store.shouldRecord(DAY)).toBe(true);
  });

  it('decimates 2× at the cap, keeping t = 0 and widening the interval', () => {
    const store = new SnapshotStore(DAY, 10);
    for (let d = 0; d <= 10; d++) store.record(d * DAY, ['a'], stateAt(d));

    // 11 records exceeds the cap of 10 ⇒ one decimation.
    expect(store.count).toBe(6);
    expect(store.interval).toBe(2 * DAY);
    expect(store.findAtOrBefore(0)?.t).toBe(0);
    expect(store.findAtOrBefore(10 * DAY)?.t).toBe(10 * DAY);
    // Odd days were dropped; the lookup falls back to the even one below.
    expect(store.findAtOrBefore(5 * DAY)?.t).toBe(4 * DAY);
  });

  it('stays under the cap across repeated decimations', () => {
    const store = new SnapshotStore(DAY, 8);
    for (let d = 0; d < 200; d++) {
      if (store.shouldRecord(d * DAY)) store.record(d * DAY, ['a'], stateAt(d));
    }
    expect(store.count).toBeLessThanOrEqual(8);
    expect(store.findAtOrBefore(0)?.t).toBe(0);
  });

  it('drops everything after a time', () => {
    const store = new SnapshotStore(DAY);
    for (let d = 0; d <= 5; d++) store.record(d * DAY, ['a'], stateAt(d));

    store.dropAfter(2 * DAY);
    expect(store.count).toBe(3);
    expect(store.latestTime).toBe(2 * DAY);
  });

  it('clear resets the interval along with the contents', () => {
    const store = new SnapshotStore(DAY, 4);
    for (let d = 0; d < 40; d++) {
      if (store.shouldRecord(d * DAY)) store.record(d * DAY, ['a'], stateAt(d));
    }
    expect(store.interval).toBeGreaterThan(DAY);

    store.clear();
    expect(store.count).toBe(0);
    expect(store.interval).toBe(DAY);
    expect(store.latestTime).toBe(-Infinity);
  });

  // The scene rebuilds trail history from this after a seek or a load — frame
  // sampling alone can't cover a jump, since one frame contributes one point
  // however far the sim moved.
  describe('between', () => {
    const store = new SnapshotStore(DAY);
    for (let d = 0; d <= 10; d++) store.record(d * DAY, ['a'], stateAt(d));

    it('returns the inclusive range, oldest→newest', () => {
      const got = store.between(3 * DAY, 6 * DAY);
      expect(got.map((s) => s.t / DAY)).toEqual([3, 4, 5, 6]);
    });

    it('clamps to what exists rather than failing on an out-of-range request', () => {
      expect(store.between(-100 * DAY, 2 * DAY).map((s) => s.t / DAY)).toEqual([0, 1, 2]);
      expect(store.between(9 * DAY, 500 * DAY).map((s) => s.t / DAY)).toEqual([9, 10]);
      expect(store.between(50 * DAY, 60 * DAY)).toEqual([]);
    });

    it('returns empty when the range is inverted', () => {
      expect(store.between(6 * DAY, 3 * DAY)).toEqual([]);
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { BLACK_HOLE_UNLOCK_MISSIONS, unlocks } from './unlocks.svelte';
import { mission } from './mission.svelte';
import { PRESETS, presetById } from '../presets/examples';
import { BODY_TYPES } from '../ui/units';

/** Fake a tally of `n` completed missions without touching localStorage. */
function setCompleted(n: number): void {
  mission.completedIds = Array.from({ length: n }, (_, i) => `fake-${i}`);
}

afterEach(() => setCompleted(0));

describe('black hole unlock', () => {
  it('takes its threshold from the preset, so the two cannot drift', () => {
    expect(BLACK_HOLE_UNLOCK_MISSIONS).toBe(presetById('black-hole')?.unlockAfterMissions);
    expect(BLACK_HOLE_UNLOCK_MISSIONS).toBeGreaterThan(0);
  });

  it('is locked below the threshold and unlocked at it', () => {
    setCompleted(BLACK_HOLE_UNLOCK_MISSIONS - 1);
    expect(unlocks.blackHolesUnlocked).toBe(false);
    expect(unlocks.blackHoleMissionsRemaining).toBe(1);

    setCompleted(BLACK_HOLE_UNLOCK_MISSIONS);
    expect(unlocks.blackHolesUnlocked).toBe(true);
    expect(unlocks.blackHoleMissionsRemaining).toBe(0);
  });

  it('never reports negative missions remaining past the threshold', () => {
    setCompleted(BLACK_HOLE_UNLOCK_MISSIONS + 5);
    expect(unlocks.blackHoleMissionsRemaining).toBe(0);
  });

  it('drops blackhole from the offered types while locked', () => {
    setCompleted(0);
    expect(unlocks.offeredTypes()).not.toContain('blackhole');
    // Everything else still on offer — the gate is one type, not a whitelist.
    expect(unlocks.offeredTypes()).toEqual(BODY_TYPES.filter((t) => t !== 'blackhole'));
  });

  it('keeps blackhole offered when it is the edited body’s own type', () => {
    // A file may carry a black hole into a locked session; the editor's select
    // must still have an option matching the body, or it renders blank and
    // rewrites the type on the next touch.
    setCompleted(0);
    expect(unlocks.offeredTypes('blackhole')).toContain('blackhole');
    expect(unlocks.offeredTypes('rocky')).not.toContain('blackhole');
  });

  it('offers every type once unlocked', () => {
    setCompleted(BLACK_HOLE_UNLOCK_MISSIONS);
    expect(unlocks.offeredTypes()).toEqual(BODY_TYPES);
  });
});

describe('resetting mission progress', () => {
  it('clears the tally', () => {
    setCompleted(3);
    expect(mission.completedCount).toBe(3);

    mission.resetProgress();

    expect(mission.completedCount).toBe(0);
    expect(mission.completedIds).toEqual([]);
  });

  it('abandons the in-flight mission, so it cannot land on a cleared tally', () => {
    setCompleted(1);
    mission.start('half-a-sun', 0);
    expect(mission.activeId).toBe('half-a-sun');

    mission.resetProgress();

    expect(mission.activeId).toBeNull();
    expect(mission.prediction).toBeNull();
    // Completing now is a no-op: there's nothing in flight to record.
    mission.completeActive();
    expect(mission.completedCount).toBe(0);
  });

  it('re-locks what the tally had unlocked', () => {
    setCompleted(BLACK_HOLE_UNLOCK_MISSIONS);
    expect(unlocks.blackHolesUnlocked).toBe(true);

    mission.resetProgress();

    expect(unlocks.blackHolesUnlocked).toBe(false);
    expect(unlocks.blackHoleMissionsRemaining).toBe(BLACK_HOLE_UNLOCK_MISSIONS);
    expect(unlocks.offeredTypes()).not.toContain('blackhole');
  });

  it('is safe to run with nothing completed', () => {
    setCompleted(0);
    expect(() => mission.resetProgress()).not.toThrow();
    expect(mission.completedCount).toBe(0);
  });
});

describe('locked presets', () => {
  it('sorts the black hole preset last, where the picker also puts it', () => {
    expect(presetById('black-hole')).toBeDefined();
    expect(PRESETS[PRESETS.length - 1].id).toBe('black-hole');
  });

  it('leaves every other preset unlocked', () => {
    const locked = PRESETS.filter((p) => p.unlockAfterMissions !== undefined);
    expect(locked.map((p) => p.id)).toEqual(['black-hole']);
  });
});

// What the mission tally has unlocked.
//
// This gates *offering* a black hole, never *loading* one. Saved files, imports
// and autosaves still restore their black holes whatever the tally says —
// dropping bodies out of a user's file would be data loss, and the physics
// integrates them either way. `blackHole()` stays callable so the screenshot
// script produces reproducible thumbnails.

import { presetById } from '../presets/examples';
import type { BodyType } from '../types';
import { BODY_TYPES } from '../ui/units';
import { mission } from './mission.svelte';

/**
 * Missions required before black holes appear. Read off the preset so the card
 * and the body type can't drift apart.
 */
export const BLACK_HOLE_UNLOCK_MISSIONS = presetById('black-hole')?.unlockAfterMissions ?? 0;

class UnlockState {
  get blackHolesUnlocked(): boolean {
    return mission.completedCount >= BLACK_HOLE_UNLOCK_MISSIONS;
  }

  get blackHoleMissionsRemaining(): number {
    return Math.max(0, BLACK_HOLE_UNLOCK_MISSIONS - mission.completedCount);
  }

  /**
   * Body types to offer in a picker, dropping what's still locked. `current` is
   * always kept: a loaded body may be a black hole while the tally is short, and
   * a `<select>` with no matching option renders blank and rewrites the type.
   */
  offeredTypes(current?: BodyType): BodyType[] {
    if (this.blackHolesUnlocked) return BODY_TYPES;
    return BODY_TYPES.filter((t) => t !== 'blackhole' || t === current);
  }
}

export const unlocks = new UnlockState();

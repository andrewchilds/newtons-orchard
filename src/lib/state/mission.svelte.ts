// The active mission and the completed-mission tally.
//
// A mission run is predict → observe → explain: commit to a prediction, load the
// system, then open the debrief. Nothing scores the prediction; it is kept only
// so the panel can show it back mid-run. Completion is persisted by id so the
// tally survives reloads; the in-flight mission deliberately is not — an
// abandoned tab shouldn't reopen mid-experiment.

import { MISSIONS, missionById, type EditedField, type Mission } from '../presets/missions';
import { readCompletedMissions, writeCompletedMissions } from '../storage/persistence';

/**
 * Keys for the checklist's latched observations, built here so the writers
 * (`system.svelte.ts`, `missionGuide.observe`) and the reader (`missionGuide`)
 * can't drift apart on the format.
 */
export const noteKeys = {
  edited: (body: string, field: EditedField) => `edited:${body}:${field}`,
  selected: (body: string) => `selected:${body}`,
  played: 'played',
};

class MissionState {
  activeId = $state<string | null>(null);
  /** Index into the active mission's `choices` the user predicted. */
  prediction = $state<number | null>(null);
  /** Mirrors localStorage. */
  completedIds = $state<string[]>(readCompletedMissions(MISSIONS.map((m) => m.id)));

  /**
   * Sticky observations for the step checklist — "the Sun has been selected",
   * "the Mass box was edited", "Play was pressed". Latched rather than read
   * live because they describe moments: a student who pauses to look shouldn't
   * see "Press Play" un-tick. Keyed by `noteKeys`; cleared with the mission.
   */
  private notes = $state<Record<string, true>>({});

  note(key: string): void {
    if (this.activeId === null || this.notes[key]) return;
    this.notes = { ...this.notes, [key]: true };
  }

  noted(key: string): boolean {
    return this.notes[key] === true;
  }

  get active(): Mission | undefined {
    return this.activeId === null ? undefined : missionById(this.activeId);
  }

  get completedCount(): number {
    return this.completedIds.length;
  }

  isCompleted(id: string): boolean {
    return this.completedIds.includes(id);
  }

  /** The caller loads the system; this only records the quiz. */
  start(id: string, prediction: number): void {
    this.activeId = id;
    this.prediction = prediction;
    this.notes = {};
  }

  /** Drop the in-flight mission without completing it. */
  abandon(): void {
    this.activeId = null;
    this.prediction = null;
    this.notes = {};
  }

  /**
   * Called when the debrief opens: nothing is graded, so reaching the outcome
   * completes the mission. Idempotent, so re-runs can't inflate the tally.
   */
  completeActive(): void {
    if (this.activeId === null || this.completedIds.includes(this.activeId)) return;
    this.completedIds = [...this.completedIds, this.activeId];
    writeCompletedMissions(this.completedIds);
  }

  /**
   * Forget every completed mission. This re-locks whatever the tally unlocked
   * (see `state/unlocks.svelte.ts`) without losing data: the gate is on
   * *offering* a type, never on loading one. The in-flight mission is abandoned
   * too, or its completion would land back on a tally just cleared.
   */
  resetProgress(): void {
    this.abandon();
    this.completedIds = [];
    writeCompletedMissions(this.completedIds);
  }
}

export const mission = new MissionState();

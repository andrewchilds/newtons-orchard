// The in-flight mission's checklist: which steps are done, which is current,
// and which control the chrome should point at. Lives outside
// `mission.svelte.ts` because evaluating checks needs `system.svelte.ts`,
// which itself imports `mission.svelte.ts` — this module sits above both.

import type { StepCheck, StepTarget } from '../presets/missions';
import { mission, noteKeys } from './mission.svelte';
import { liveStateOf, system } from './system.svelte';
import { time } from './time.svelte';
import { ui } from './ui.svelte';

export interface StepView {
  index: number;
  text: string;
  done: boolean;
  current: boolean;
}

class MissionGuide {
  /**
   * Latch the moment-shaped observations ("selected", "played"). Driven by an
   * `$effect` in App rather than computed here: latching is a state write, so
   * it can't happen inside a derived. `note` ignores repeats, so the effect
   * converges instead of looping.
   */
  observe(): void {
    if (mission.activeId === null) return;
    const selected = system.byId(ui.selectedBodyId);
    if (selected) mission.note(noteKeys.selected(selected.name));
    if (time.playing) mission.note(noteKeys.played);
  }

  private satisfied(check: StepCheck): boolean {
    switch (check.kind) {
      case 'selected':
        return mission.noted(noteKeys.selected(check.body));
      case 'edited':
        return mission.noted(noteKeys.edited(check.body, check.field));
      case 'playing':
        return mission.noted(noteKeys.played);
      case 'typeIs':
        return system.bodies.some((b) => b.name === check.body && b.type === check.type);
      case 'deleted':
        // A *deleted* body leaves the roster; a merged-away one keeps its entry,
        // so a collision doesn't tick a delete step.
        return !system.bodies.some((b) => b.name === check.body);
      case 'added': {
        // Creation issues fresh UUIDs, so "new" is any id the load didn't carry.
        const original = new Set((system.loaded?.bodies ?? []).map((b) => b.id));
        return system.bodies.some((b) => !original.has(b.id));
      }
      case 'centerIs': {
        const body = system.bodies.find((b) => b.name === check.body);
        return body !== undefined && ui.referenceFrame === body.id;
      }
      case 'near': {
        // Live positions aren't reactive — touch the clock and the edit
        // generation so this re-evaluates as the bodies move or get dragged.
        void time.simTime;
        void time.seekGeneration;
        const a = this.livePositionOf(check.body);
        const b = this.livePositionOf(check.other);
        if (a === null || b === null) return false;
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= check.within;
      }
    }
  }

  private livePositionOf(name: string): { x: number; y: number; z: number } | null {
    const body = system.bodies.find((b) => b.name === name);
    const live = body ? liveStateOf(body.id) : null;
    return live?.position ?? null;
  }

  readonly steps: StepView[] = $derived.by(() => {
    const active = mission.active;
    if (!active) return [];
    const done = active.steps.map((s) => (s.check ? this.satisfied(s.check) : false));
    // A checkless step is a watch-finale: nothing completes it, so the pointer
    // parks there. The registry test keeps such steps last.
    const current = active.steps.findIndex((s, i) => (s.check ? !done[i] : true));
    return active.steps.map((step, index) => ({
      index,
      text: step.text,
      done: done[index],
      current: index === current,
    }));
  });

  /** What the chrome should point at right now, or null. */
  readonly target: StepTarget | null = $derived.by(() => {
    const active = mission.active;
    const current = this.steps.find((s) => s.current);
    return active && current ? (active.steps[current.index].target ?? null) : null;
  });

  /** True when the current step points at this body's roster row. */
  targetsRoster(name: string): boolean {
    const t = this.target;
    return t?.kind === 'roster' && t.body === name;
  }
}

export const missionGuide = new MissionGuide();

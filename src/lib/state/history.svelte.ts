// Undo/redo for body edits.
//
// A stack of *whole rosters* captured just before each `commit` in
// system.svelte.ts, not a diff log: rosters are small, restoring one is what
// `commit` already does, and the coarse form can't drift out of sync with a
// partial replay.
//
// Scope is the roster only. State is restored *at the current sim time*, the
// same rule ordinary edits follow, so undo never moves the clock.

import type { Body } from '../types';

/** Deep enough copy that a later mutation of the live roster can't reach in. */
function cloneBody(b: Body): Body {
  return {
    ...b,
    position: { ...b.position },
    velocity: { ...b.velocity },
    atmosphere: b.atmosphere ? { ...b.atmosphere } : undefined,
    rings: b.rings ? { ...b.rings } : undefined,
  };
}

function cloneRoster(bodies: readonly Body[]): Body[] {
  return bodies.map(cloneBody);
}

/** Bounds memory against a long drag session; far more depth than anyone uses. */
const MAX_DEPTH = 100;

class HistoryState {
  /** rosters as they were *before* each recorded edit, oldest first */
  private undoStack = $state<Body[][]>([]);
  /** rosters undone, for redo — cleared by any fresh edit */
  private redoStack = $state<Body[][]>([]);

  /**
   * While set, `record` folds into the entry already pushed under this label. A
   * drag commits every frame, so without coalescing one drag would take dozens
   * of undo clicks. The label is the gesture's identity.
   */
  private coalesceLabel: string | null = null;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Capture `before` as the state an undo would restore. `coalesceAs` groups a
   * continuous gesture into one entry; pass null for a discrete edit.
   */
  record(before: readonly Body[], coalesceAs: string | null = null): void {
    if (coalesceAs !== null && coalesceAs === this.coalesceLabel && this.undoStack.length > 0) {
      // Already have this gesture's starting state.
      return;
    }
    this.coalesceLabel = coalesceAs;

    this.undoStack = [...this.undoStack, cloneRoster(before)].slice(-MAX_DEPTH);
    // A new edit forks the timeline: whatever was undone is no longer reachable.
    this.redoStack = [];
  }

  /**
   * Discard the most recent entry without restoring it, for a gesture that undid
   * itself: an Escape-cancelled drag already put the body back, so its entry
   * describes the current state and would cost an undo click that does nothing.
   */
  dropLast(): void {
    this.undoStack = this.undoStack.slice(0, -1);
    this.coalesceLabel = null;
  }

  /**
   * End the current coalescing group so the next `record` starts a fresh entry
   * even under the same label — two drags of one body are two undo steps.
   */
  endCoalescing(): void {
    this.coalesceLabel = null;
  }

  /** Pops the last roster, pushing `current` onto the redo stack. */
  takeUndo(current: readonly Body[]): Body[] | null {
    const previous = this.undoStack.at(-1);
    if (previous === undefined) return null;
    this.undoStack = this.undoStack.slice(0, -1);
    this.redoStack = [...this.redoStack, cloneRoster(current)];
    this.coalesceLabel = null;
    return previous;
  }

  /** The mirror of `takeUndo`. */
  takeRedo(current: readonly Body[]): Body[] | null {
    const next = this.redoStack.at(-1);
    if (next === undefined) return null;
    this.redoStack = this.redoStack.slice(0, -1);
    this.undoStack = [...this.undoStack, cloneRoster(current)];
    this.coalesceLabel = null;
    return next;
  }

  /**
   * Loading a system replaces the roster wholesale; an undo across that boundary
   * would resurrect bodies from a system that's no longer open.
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.coalesceLabel = null;
  }
}

export const history = new HistoryState();

/**
 * Mac uses ⌘ for undo, everything else Ctrl. `navigator` is guarded so the
 * module stays importable under Vitest's node environment.
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

/** The undo modifier as a label, for tooltips: "⌘" or "Ctrl+". */
export const UNDO_MODIFIER = IS_MAC ? '⌘' : 'Ctrl+';

/**
 * Structural rather than `KeyboardEvent` so the logic is testable without a DOM;
 * the suite runs in node and jsdom isn't worth pulling in for one predicate.
 */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

/**
 * True for a target whose own text editing owns the keystroke. Checked by tag
 * name rather than `instanceof` so it doesn't depend on DOM globals.
 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * Which history action a keystroke means, if any. Keystrokes inside a text field
 * belong to the field's own undo — retyping a name shouldn't roll back an orbit.
 */
export function historyShortcut(event: ShortcutEvent): 'undo' | 'redo' | null {
  if (isTextEntry(event.target)) return null;

  const modifier = IS_MAC ? event.metaKey : event.ctrlKey;
  if (!modifier) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !IS_MAC) return 'redo';
  return null;
}

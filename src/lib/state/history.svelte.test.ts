import { describe, expect, it } from 'vitest';
import { history, historyShortcut, IS_MAC, type ShortcutEvent } from './history.svelte';
import type { Body } from '../types';
import { vec3 } from '../physics/vec3';

function body(id: string, x = 0): Body {
  return {
    id,
    name: id,
    color: '#fff',
    type: 'rocky',
    mass: 1e24,
    radius: 6e6,
    rotationPeriod: 86400,
    axialTilt: 0,
    position: vec3(x, 0, 0),
    velocity: vec3(),
  };
}

describe('history stack', () => {
  it('undoes and redoes a single edit', () => {
    history.clear();
    const before = [body('a', 1)];
    const after = [body('a', 2)];

    history.record(before);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    expect(history.takeUndo(after)?.[0].position.x).toBe(1);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    expect(history.takeRedo(before)?.[0].position.x).toBe(2);
    expect(history.canRedo).toBe(false);
  });

  it('collapses a coalesced gesture into one entry', () => {
    history.clear();
    // Three frames of one drag, each committing a further-along position.
    history.record([body('a', 1)], 'move:a');
    history.record([body('a', 2)], 'move:a');
    history.record([body('a', 3)], 'move:a');

    // One undo returns the state from *before* the whole drag.
    expect(history.takeUndo([body('a', 4)])?.[0].position.x).toBe(1);
    expect(history.canUndo).toBe(false);
  });

  it('starts a new entry once a gesture ends', () => {
    history.clear();
    history.record([body('a', 1)], 'move:a');
    history.endCoalescing();
    history.record([body('a', 2)], 'move:a');

    expect(history.takeUndo([body('a', 3)])?.[0].position.x).toBe(2);
    expect(history.takeUndo([body('a', 2)])?.[0].position.x).toBe(1);
  });

  it('treats a different label as a separate gesture', () => {
    history.clear();
    history.record([body('a', 1)], 'velocity:a:x');
    history.record([body('a', 2)], 'velocity:a:y');

    expect(history.takeUndo([body('a', 3)])?.[0].position.x).toBe(2);
    expect(history.canUndo).toBe(true);
  });

  it('drops the last entry without restoring it (cancelled drag)', () => {
    history.clear();
    history.record([body('a', 1)]);
    history.dropLast();
    expect(history.canUndo).toBe(false);
  });

  it('clears redo when a fresh edit forks the timeline', () => {
    history.clear();
    history.record([body('a', 1)]);
    history.takeUndo([body('a', 2)]);
    expect(history.canRedo).toBe(true);

    history.record([body('a', 3)]);
    expect(history.canRedo).toBe(false);
  });

  it('snapshots the roster rather than aliasing it', () => {
    history.clear();
    const roster = [body('a', 1)];
    history.record(roster);
    // Mutating the live roster afterwards must not reach into the entry.
    roster[0].position.x = 99;
    expect(history.takeUndo([])?.[0].position.x).toBe(1);
  });
});

describe('historyShortcut', () => {
  // The suite runs in node; `historyShortcut` takes a structural event so it
  // can be exercised without a DOM. A bare `{ tagName }` is all the predicate
  // reads, so that's all these stand-ins carry.
  function target(tagName: string): ShortcutEvent['target'] {
    return { tagName } as unknown as EventTarget;
  }

  function press(key: string, opts: Partial<ShortcutEvent> = {}): ShortcutEvent {
    return {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      target: null,
      // The modifier that means "undo" differs by platform, so tests press
      // whichever one this platform actually listens for.
      ...(IS_MAC ? { metaKey: true } : { ctrlKey: true }),
      ...opts,
    };
  }

  it('maps the platform modifier + Z to undo', () => {
    expect(historyShortcut(press('z'))).toBe('undo');
  });

  it('maps modifier + shift + Z to redo', () => {
    expect(historyShortcut(press('z', { shiftKey: true }))).toBe('redo');
  });

  it('accepts an uppercase key', () => {
    expect(historyShortcut(press('Z'))).toBe('undo');
  });

  it('ignores Z with no modifier', () => {
    expect(historyShortcut(press('z', { metaKey: false, ctrlKey: false }))).toBeNull();
  });

  it('ignores an unrelated key', () => {
    expect(historyShortcut(press('a'))).toBeNull();
  });

  it('ignores the shortcut while typing in a field', () => {
    expect(historyShortcut(press('z', { target: target('INPUT') }))).toBeNull();
    expect(
      historyShortcut(press('z', { target: target('TEXTAREA') }))
    ).toBeNull();
  });

  it('still fires over a non-text element', () => {
    expect(historyShortcut(press('z', { target: target('CANVAS') }))).toBe(
      'undo'
    );
  });
});

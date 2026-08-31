import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIALOG_MS, PANEL_MS, duration, reducedMotion } from './motion';

/**
 * Stand in for the `matchMedia` the browser provides. Tests run in Node with no
 * DOM, so the global is absent unless a test installs one — which is the case
 * `motion.ts` guards against, and the first test below pins.
 */
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches, media: query }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reducedMotion', () => {
  it('is false without a DOM rather than throwing', () => {
    // The transitions import this module at load; a bare `matchMedia` call
    // would take out any test that imports a component transitively.
    expect(typeof matchMedia).toBe('undefined');
    expect(reducedMotion()).toBe(false);
  });

  it('follows the prefers-reduced-motion query', () => {
    stubMatchMedia(true);
    expect(reducedMotion()).toBe(true);

    stubMatchMedia(false);
    expect(reducedMotion()).toBe(false);
  });

  it('asks for the reduce preference specifically', () => {
    const seen: string[] = [];
    vi.stubGlobal('matchMedia', (query: string) => {
      seen.push(query);
      return { matches: false, media: query };
    });

    reducedMotion();
    expect(seen).toEqual(['(prefers-reduced-motion: reduce)']);
  });

  it('re-reads the preference on every call', () => {
    // Cached at module load, toggling the OS setting would need a reload.
    stubMatchMedia(false);
    expect(reducedMotion()).toBe(false);
    stubMatchMedia(true);
    expect(reducedMotion()).toBe(true);
  });
});

describe('duration', () => {
  it('passes the duration through when motion is allowed', () => {
    stubMatchMedia(false);
    expect(duration(DIALOG_MS)).toBe(DIALOG_MS);
    expect(duration(PANEL_MS)).toBe(PANEL_MS);
  });

  it('zeroes every duration under reduced motion', () => {
    stubMatchMedia(true);
    expect(duration(DIALOG_MS)).toBe(0);
    expect(duration(PANEL_MS)).toBe(0);
  });
});

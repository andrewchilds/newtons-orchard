// The single Simulation instance the app drives.
//
// Deliberately not a .svelte.ts rune: the sim holds hot physics arrays that must
// stay out of reactivity (see GUIDE.md). Components read it directly each frame.
//
// The autosave and share link are read *at construction*, not in a component
// effect, so the sim never briefly holds the default system — the scene builds
// meshes from the roster on its first run, and swapping underneath it would
// build and dispose bodies for nothing. The share link's async decode is why
// this module top-level awaits.

import { Simulation } from '../sim/simulation';
import { solarSystem } from '../presets/solarSystem';
import { readAutosave, type AutosaveState } from '../storage/persistence';
import { consumeSharedSystem } from '../storage/shareUrl';

/**
 * The autosaved session, if valid. The clock is not restored; a cold load always
 * starts at t = 0 (see `AutosaveState`).
 */
export const restored: AutosaveState | null = readAutosave();

/**
 * A system carried in by the URL fragment, plus the decode failure if the
 * fragment was present but unreadable (surfaced as a toast by
 * `system.svelte.ts` — this module stays free of UI state). A share link
 * outranks the autosave: opening one is an explicit request for that system.
 */
export const { file: sharedSystem, error: shareError } = await consumeSharedSystem();

// The autosave carries the system's timing grids as well as its roster; a
// restored satellite swarm needs its 60 s dt back or it boots as a spiral.
// The cold-boot roster. The solar-system preset needs no timing overrides, so
// default Simulation settings match loading it from the System menu. Its name
// lives in `system.svelte.ts` (`SystemState.name`'s initial value) — keep the
// two in sync.
export const sim = sharedSystem
  ? new Simulation(sharedSystem.bodies, sharedSystem.settings)
  : restored
    ? new Simulation(restored.file.bodies, restored.file.settings)
    : new Simulation(solarSystem());

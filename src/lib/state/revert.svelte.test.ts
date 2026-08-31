// "Revert system": reload the last-loaded system from its initial conditions.
//
// The trap this guards is the roster the sim hands back. Edits apply at the
// *current* time, so every mirror after a load carries positions rebased to
// whenever the user edited — reverting from that would restore the shape of the
// system at year 3, not the system that was loaded. The pristine copy is taken
// in `loadSystemIntoUi`, before the sim ever sees it.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteBody,
  isSatelliteLanding,
  loadSystemIntoUi,
  markLoadedAsMission,
  revertSystem,
  system,
  updateBody,
} from './system.svelte';
import { mission } from './mission.svelte';
import { time } from './time.svelte';
import { BARYCENTER, ui } from './ui.svelte';
import { presetById } from '../presets/examples';
import { vec3 } from '../physics/vec3';
import type { Body } from '../types';

function body(id: string, x: number): Body {
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
    velocity: vec3(0, 1e3, 0),
  };
}

function roster(): Body[] {
  return [body('a', 1e11), body('b', 2e11)];
}

beforeEach(() => {
  mission.abandon();
  system.loaded = null;
});

describe('revert system', () => {
  it('is unavailable until something is loaded', () => {
    expect(system.loaded).toBeNull();
    // A no-op, not a throw — the menu hides the item, but nothing should break
    // if it's reached another way.
    expect(() => revertSystem()).not.toThrow();
  });

  it('records the loaded system, name and timing', () => {
    loadSystemIntoUi(roster(), 'Test System', { dt: 300 });
    expect(system.loaded?.name).toBe('Test System');
    expect(system.loaded?.bodies).toHaveLength(2);
    expect(system.loaded?.timing.dt).toBe(300);
  });

  it('restores the initial conditions after an edit', () => {
    loadSystemIntoUi(roster(), 'Test System');
    updateBody('a', { mass: 9e25, name: 'edited' });
    expect(system.byId('a')?.mass).toBe(9e25);

    revertSystem();
    expect(system.byId('a')?.mass).toBe(1e24);
    expect(system.byId('a')?.name).toBe('a');
    expect(system.bodies).toHaveLength(2);
    expect(system.name).toBe('Test System');
    expect(time.simTime).toBe(0);
  });

  it('restores bodies that were deleted since the load', () => {
    loadSystemIntoUi(roster(), 'Test System');
    deleteBody('b');
    expect(system.bodies.map((b) => b.id)).toEqual(['a']);

    revertSystem();
    expect(system.bodies.map((b) => b.id).sort()).toEqual(['a', 'b']);
  });

  it('survives being reverted twice — the stored roster is not consumed', () => {
    loadSystemIntoUi(roster(), 'Test System');

    updateBody('a', { mass: 5e25 });
    revertSystem();
    expect(system.byId('a')?.mass).toBe(1e24);

    // The second revert is the one that catches handing the stored array
    // straight to the sim: the first revert's edits would have rewritten it.
    updateBody('a', { mass: 7e25 });
    revertSystem();
    expect(system.byId('a')?.mass).toBe(1e24);
    expect(system.byId('a')?.position.x).toBe(1e11);
  });

  it('re-arms a mission run rather than dropping it', () => {
    loadSystemIntoUi(roster(), 'Mission System');
    mission.start('m1', 2);
    markLoadedAsMission('m1', 2);

    revertSystem();
    expect(mission.activeId).toBe('m1');
    expect(mission.prediction).toBe(2);
    // And it must still be re-armable after a second revert.
    revertSystem();
    expect(mission.activeId).toBe('m1');
  });

  it('clears the mission when the reverted system was not a mission', () => {
    loadSystemIntoUi(roster(), 'Test System');
    mission.start('m1', 0);

    // No `markLoadedAsMission`, so this load was not a mission run — reverting
    // it drops the mission the way any other load does.
    revertSystem();
    expect(mission.activeId).toBeNull();
  });
});

// A preset's `view` is applied by `loadSystemIntoUi` (only there — the picker
// and revert share the path), so the assertions live with the revert tests.
describe('preset opening view', () => {
  it('opens Artemis II focused on Orion in the Earth frame, ×1, close in', () => {
    const preset = presetById('artemis-ii')!;
    loadSystemIntoUi(preset.build(), preset.name, preset.timing, { kind: 'preset', id: preset.id });

    const orion = system.bodies.find((b) => b.name === 'Orion');
    const earth = system.bodies.find((b) => b.name === 'Earth');
    expect(orion).toBeDefined();
    expect(ui.focusedBodyId).toBe(orion!.id);
    expect(ui.selectedBodyId).toBe(orion!.id);
    expect(ui.referenceFrame).toBe(earth!.id);
    expect(ui.radiusExaggeration).toBe(1);
    expect(ui.parentRelativeTrails).toBe(false);
    expect(ui.zoomRequest).toBe(1.5e9);
  });

  it('restores the same view on revert', () => {
    const preset = presetById('artemis-ii')!;
    loadSystemIntoUi(preset.build(), preset.name, preset.timing, { kind: 'preset', id: preset.id });
    ui.clearFocus();
    ui.radiusExaggeration = 500;
    ui.parentRelativeTrails = true;

    revertSystem();
    expect(system.bodies.find((b) => b.id === ui.focusedBodyId)?.name).toBe('Orion');
    expect(system.bodies.find((b) => b.id === ui.referenceFrame)?.name).toBe('Earth');
    expect(ui.radiusExaggeration).toBe(1);
    expect(ui.parentRelativeTrails).toBe(false);
  });

  // Orion reaching Earth is an arrival (no burst, re-entry/impact wording);
  // everything else — including a moon falling into a planet — stays a merge.
  it('classifies a satellite reaching a planet as a landing, nothing else', () => {
    const preset = presetById('artemis-ii')!;
    loadSystemIntoUi(preset.build(), preset.name, preset.timing, { kind: 'preset', id: preset.id });
    const id = (name: string) => system.bodies.find((b) => b.name === name)!.id;
    const event = (absorbed: string, survivor: string) => ({
      t: 0,
      absorbedId: id(absorbed),
      survivorId: id(survivor),
      absorbedName: absorbed,
      survivorName: survivor,
    });

    expect(isSatelliteLanding(event('Orion', 'Earth'))).toBe(true);
    expect(isSatelliteLanding(event('Orion', 'Moon'))).toBe(true);
    expect(isSatelliteLanding(event('Moon', 'Earth'))).toBe(false);
  });

  it('resets focus, frame and queued zoom on a load with no view', () => {
    const preset = presetById('artemis-ii')!;
    loadSystemIntoUi(preset.build(), preset.name, preset.timing, { kind: 'preset', id: preset.id });
    expect(ui.focusedBodyId).not.toBeNull();

    loadSystemIntoUi(roster(), 'Test System');
    expect(ui.focusedBodyId).toBeNull();
    expect(ui.referenceFrame).toBe(BARYCENTER);
    // The queued zoom must not leak into a system it was never framed for.
    expect(ui.zoomRequest).toBeNull();
  });
});

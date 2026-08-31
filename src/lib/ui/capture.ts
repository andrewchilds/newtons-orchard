// The hook `npm run preset-screenshots` drives. Installed on `window` by
// App.svelte; nothing in the app calls it.
//
// Not a click path: that would couple the thumbnails to the very menu markup
// they're rendered into, and there's no UI control for camera distance anyway.
// It only touches public state (`loadSystem`, `ui`, `time`), so a capture and a
// user driving the same preset by hand land in the same place.

import { PRESETS, type PresetShot, type PresetTiming } from '../presets/examples';
import { GALLERY } from '../presets/gallery';
import { MISSIONS, type MissionSetup } from '../presets/missions';
import { parseSystemFile } from '../storage/persistence';
import {
  addBody,
  deleteBody,
  liveStateOf,
  loadSystem,
  system,
  updateBody,
} from '../state/system.svelte';
import { sim } from '../state/simInstance';
import { time, seekTo } from '../state/time.svelte';
import { ui, BARYCENTER } from '../state/ui.svelte';
import { toasts } from '../state/toasts.svelte';
import { circularVelocityAt } from '../physics/kepler';
import { DAY } from '../physics/constants';
import type { Body } from '../types';

export interface CaptureApi {
  /** Load a preset and settle it into its `shot` framing. Resolves when the scene is ready to photograph. */
  shoot: (id: string) => Promise<void>;
  /** Preset ids that declare a `shot`, in menu order. */
  ids: () => string[];
  /** Same as `shoot`, for a mission's card portrait. */
  shootMission: (id: string) => Promise<void>;
  /** Every mission id, in menu order. */
  missionIds: () => string[];
  /** Same as `shoot`, for a gallery entry — fetches its JSON like the app does. */
  shootGallery: (id: string) => Promise<void>;
  /** Every gallery entry id, in gallery order. */
  galleryIds: () => string[];
  /**
   * Center a named body in the loaded system and pull the camera to `zoom`
   * metres, on the lit side. The close-up path for scripted verification —
   * the UI has no control for camera distance, and a driver can't reach the
   * app's module instances (Vite hands a dynamic import its own copy).
   */
  frameBody: (name: string, zoom: number, exaggeration?: number) => Promise<void>;
}

/**
 * Not the frame tick: playing at warp costs as many wall-seconds as the shot
 * has warp-seconds, and the tick's per-frame step budget would silently cap a
 * multi-year run. `seekTo` integrates the whole span at the fixed dt with no
 * budget — the same trajectory the user would reach by waiting.
 */
function runTo(days: number): void {
  time.playing = false;
  seekTo(sim, days * DAY);
}

function applyShot(shot: PresetShot): void {
  ui.radiusExaggeration = shot.exaggeration ?? ui.radiusExaggeration;
  // Trails are drawn from snapshot history, so the window has to cover the span
  // that was just integrated or the orbit reads as a stub.
  ui.trailDays = shot.trailDays ?? Math.ceil(shot.days);
  ui.showLabels = false;
  ui.showTrails = true;
  ui.parentRelativeTrails = shot.parentRelativeTrails ?? true;
  ui.lensing = shot.lensing ?? false;
}

/**
 * Perform a mission's declared edit on the live system — the student's own
 * keystroke, made after the pre-roll.
 *
 * The registry describes the edit as data (`MissionEdit`) rather than
 * performing it, because `presets/` can't import the mutation path without a
 * cycle through `mission.svelte.ts`. Applying it is this module's job, and it
 * goes through `state/system.svelte.ts` like any other edit: at the current
 * time, leaving every body where the pre-roll put it.
 *
 * Targets resolve by name against the *live* roster, and velocities/positions
 * come from `liveStateOf` rather than the roster, which still holds t = 0
 * state after a seek.
 */
export function applySetup(label: string, setup: MissionSetup): void {
  const named = (name: string): Body => {
    const body = system.bodies.find((b) => b.name === name);
    if (!body) throw new Error(`${label}: no body named ${name}`);
    return body;
  };
  const liveOf = (name: string) => {
    const state = liveStateOf(named(name).id);
    if (!state) throw new Error(`${label}: ${name} isn't alive to edit`);
    return state;
  };

  for (const edit of setup) {
    switch (edit.kind) {
      case 'scaleMass': {
        const body = named(edit.body);
        updateBody(body.id, { mass: body.mass * edit.factor });
        break;
      }
      case 'scaleVelocity': {
        const { velocity } = liveOf(edit.body);
        updateBody(named(edit.body).id, {
          velocity: {
            x: velocity.x * edit.factor,
            y: velocity.y * edit.factor,
            z: velocity.z * edit.factor,
          },
        });
        break;
      }
      case 'scaleVelocityAxis': {
        const { velocity } = liveOf(edit.body);
        updateBody(named(edit.body).id, {
          velocity: { ...velocity, [edit.axis]: velocity[edit.axis] * edit.factor },
        });
        break;
      }
      case 'setType': {
        const body = named(edit.body);
        updateBody(body.id, { type: edit.type, radius: edit.radius(body.mass) });
        break;
      }
      case 'delete': {
        deleteBody(named(edit.body).id);
        break;
      }
      case 'circularOrbit': {
        // The parent's live state, so a body added after a pre-roll lands on an
        // orbit around where the Sun *is*, not where it started.
        const parent = named(edit.around);
        const parentState = liveOf(edit.around);
        const position = {
          x: parentState.position.x + edit.distance,
          y: parentState.position.y,
          z: parentState.position.z,
        };
        if (edit.create) {
          // Mass is the new body's own, so build it once to read the mass, then
          // again with the velocity that mass implies. Two calls rather than a
          // mutable body: `create` owns the whole specification.
          const provisional = edit.create(position, { x: 0, y: 0, z: 0 });
          const velocity = circularVelocityAt(
            parent.mass,
            parentState,
            position,
            provisional.mass
          );
          addBody(edit.create(position, velocity));
        } else {
          const body = named(edit.body);
          updateBody(body.id, {
            position,
            velocity: circularVelocityAt(parent.mass, parentState, position, body.mass),
          });
        }
        break;
      }
    }
  }
}

/** The scene rebuilds trails and moves the camera on its own tick. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (left-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

/**
 * Load a system, run it forward and settle it into `shot`'s framing.
 *
 * `setup` (missions only) makes the mission's edit *last*, on the system as it
 * stands after the pre-roll — the card is the moment the change lands, before
 * any of its consequences have played out. See `MissionSetup`: a card that
 * showed the outcome answered the question it was supposed to be asking.
 *
 * So `shot.days` is a pre-roll of the *unedited* system: it exists to lay down
 * trails, not to show a result. The edit then goes through
 * `state/system.svelte.ts` like any other, which is exactly right — edits apply
 * at the current time, leaving every body where the pre-roll put it.
 */
async function settleShot(
  label: string,
  build: () => Body[],
  name: string,
  timing: PresetTiming | undefined,
  shot: PresetShot,
  setup?: MissionSetup
): Promise<void> {
  ui.selectedBodyId = null;
  ui.clearFocus();
  ui.chromeHidden = true;
  ui.referenceFrame = BARYCENTER;

  loadSystem(build(), name, timing);
  applyShot(shot);

  runTo(shot.days);

  // The edit lands after the pre-roll, at the current time — the student's
  // "type *2 and press Enter" on a system they have been watching. It goes
  // through the mutation path, so `applyBodyEdits` keeps every body's live
  // state and changes only what was edited.
  if (setup) applySetup(label, setup);

  // Center *after* setup: the name resolves against the post-edit roster, and
  // Lights Out deletes the body its shot would otherwise name.
  if (shot.center) {
    const body = sim.bodies.find((b) => b.name === shot.center);
    if (!body) throw new Error(`${label}: no body named ${shot.center}`);
    ui.referenceFrame = body.id;
  }

  // The seek replays merge events, whose toasts live on the wall clock — one
  // from the last span would still be on screen when the shot fires. Toasts
  // deliberately ignore chromeHidden, so drop them here instead.
  toasts.length = 0;

  // The scene consumes centerRequest and zoomRequest on its next frame, in
  // that order, so both are queued together and given a frame to land.
  ui.recenter();
  ui.sunwardRequest = shot.sunward ?? false;
  if (shot.zoom !== undefined) ui.zoomRequest = shot.zoom;

  // Trails rebuild from snapshots over a few frames after a seek, and the
  // camera damps toward its target rather than snapping; this is long
  // enough for both to settle at 60 fps.
  await frames(45);
}

/**
 * Whether the page was opened by the screenshot script (`?capture=1`).
 *
 * The script runs in a throwaway browser profile, which is a first visit by
 * definition — left alone, the welcome dialog would cover the scene in every
 * preset and mission thumbnail. It can't be inferred from the capture API being
 * installed: `installCaptureApi` runs on every load, driven or not.
 */
export function isCaptureRun(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('capture') === '1';
  } catch {
    return false;
  }
}

export function installCaptureApi(): void {
  const api: CaptureApi = {
    ids: () => PRESETS.filter((p) => p.shot).map((p) => p.id),

    async shoot(id: string) {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) throw new Error(`unknown preset: ${id}`);
      if (!preset.shot) throw new Error(`preset has no shot config: ${id}`);
      await settleShot(`preset ${id}`, preset.build, preset.name, preset.timing, preset.shot);
    },

    missionIds: () => MISSIONS.map((m) => m.id),

    async shootMission(id: string) {
      const mission = MISSIONS.find((m) => m.id === id);
      if (!mission) throw new Error(`unknown mission: ${id}`);
      await settleShot(
        `mission ${id}`,
        mission.build,
        mission.name,
        mission.timing,
        mission.shot,
        mission.setup
      );
    },

    galleryIds: () => GALLERY.map((e) => e.id),

    async shootGallery(id: string) {
      const entry = GALLERY.find((e) => e.id === id);
      if (!entry) throw new Error(`unknown gallery entry: ${id}`);
      // The same path the gallery UI takes: fetch the split-out JSON, validate
      // it as untrusted input, and load on the settings it carries — so the
      // thumbnail integrates on the same timing grids the app will.
      const response = await fetch(`${import.meta.env.BASE_URL}gallery/${id}.json`);
      if (!response.ok) throw new Error(`gallery ${id}: fetch failed (HTTP ${response.status})`);
      const file = parseSystemFile(await response.text());
      await settleShot(`gallery ${id}`, () => file.bodies, entry.name, file.settings, entry.shot);
    },

    async frameBody(name: string, zoom: number, exaggeration?: number) {
      const body = system.bodies.find((b) => b.name === name);
      if (!body) throw new Error(`no body named ${name}`);
      if (exaggeration !== undefined) ui.radiusExaggeration = exaggeration;
      ui.referenceFrame = body.id;
      ui.recenter();
      ui.sunwardRequest = true;
      ui.zoomRequest = zoom;
      await frames(45);
    },
  };

  (window as unknown as { __capture?: CaptureApi }).__capture = api;
}

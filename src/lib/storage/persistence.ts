// Saving, loading, export and import of systems.
//
// "Serverless" here means static hosting with zero backend, so persistence is
// localStorage plus JSON files the user downloads. Two hard rules:
//
//   * **Never store snapshot history.** localStorage gives us ~5 MB; a single
//     snapshot of ten bodies is ~1 kB and the sim keeps up to 100k of them. Only
//     body definitions at t = 0 and the current sim time are saved — everything
//     else is recomputed, deterministically, from those.
//   * **Validate everything on the way in.** An imported file is untrusted
//     input, and a NaN mass or a missing velocity doesn't fail loudly; it
//     silently poisons the integrator and the whole system's trajectory becomes
//     NaN a few steps later. `parseSystemFile` rejects at the boundary with a
//     message naming the field.

import { REAL_TEXTURE_KEYS, type Body, type BodyType, type RealTextureKey, type SystemFile } from '../types';
import {
  DEFAULT_DT,
  DEFAULT_SNAPSHOT_INTERVAL,
  DEFAULT_TRAIL_INTERVAL,
} from '../sim/simulation';

const SLOT_PREFIX = 'space-sim:slot:';
const AUTOSAVE_KEY = 'space-sim:autosave';
const MISSIONS_KEY = 'space-sim:missions-completed';
const WELCOMED_KEY = 'space-sim:welcomed';

export const CURRENT_VERSION = 1;

const BODY_TYPES: readonly BodyType[] = [
  'star',
  'earthlike',
  'rocky',
  'gas',
  'ice',
  'dwarf',
  'moon',
  'asteroid',
  'satellite',
  'blackhole',
];

/** A named save slot as listed in the System menu. */
export interface SaveSlot {
  name: string;
  /** ms since epoch, for the "saved 3 minutes ago" line */
  savedAt: number;
  bodyCount: number;
}

/**
 * Autosave payload: the system, and nothing about the clock.
 *
 * Restoring a clock as well was tried and removed. The sim only exists on the
 * `stepIndex · dt` grid and can't jump, so reopening a session parked at year 3
 * meant re-integrating three years before the page was usable — minutes of
 * grinding to arrive somewhere the user hadn't necessarily asked to be. A cold
 * load now always starts at t = 0, which is instant and identical every time.
 */
export interface AutosaveState {
  file: SystemFile;
  savedAt: number;
  /** Where the session's load came from, so revert can survive a reload. */
  source: AutosaveSource | null;
}

/**
 * Provenance of the loaded system, for re-arming "Revert system" after a
 * restore. The autosave itself is a snapshot of the *edited* state, so revert
 * needs the pristine roster rebuilt from the source registry — which is why
 * only bundle-backed sources appear here. Imports have no source to point at,
 * and save slots are mutable referents: the shelf's plain Save writes under the
 * loaded slot's name, so a by-reference revert could silently target the very
 * edits being reverted.
 */
export type AutosaveSource =
  | { kind: 'preset'; id: string }
  | { kind: 'gallery'; id: string }
  | { kind: 'mission'; id: string; prediction: number };

// --- serialization -------------------------------------------------------

export function toSystemFile(
  name: string,
  bodies: readonly Body[],
  settings: SystemFile['settings'] = {
    dt: DEFAULT_DT,
    snapshotInterval: DEFAULT_SNAPSHOT_INTERVAL,
    trailInterval: DEFAULT_TRAIL_INTERVAL,
  }
): SystemFile {
  return {
    version: CURRENT_VERSION,
    name,
    bodies: bodies.map(cloneBody),
    settings: { ...settings },
  };
}

function cloneBody(b: Body): Body {
  return {
    ...b,
    position: { ...b.position },
    velocity: { ...b.velocity },
    atmosphere: b.atmosphere ? { ...b.atmosphere } : undefined,
    rings: b.rings ? { ...b.rings } : undefined,
  };
}

/** Thrown by `parseSystemFile`; the message is safe to show the user. */
export class ImportError extends Error {}

/**
 * Parse and validate untrusted JSON into a `SystemFile`.
 *
 * Every failure names what's wrong and where — an import that just says
 * "invalid file" is useless for a hand-edited system, which is a thing people
 * will do with an exported JSON.
 */
export function parseSystemFile(text: string): SystemFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError('Not valid JSON.');
  }

  if (!isRecord(raw)) throw new ImportError('File must contain a JSON object.');

  if (raw.version !== CURRENT_VERSION) {
    throw new ImportError(
      `Unsupported file version ${JSON.stringify(raw.version)} — expected ${CURRENT_VERSION}.`
    );
  }

  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : 'Imported System';

  if (!Array.isArray(raw.bodies)) throw new ImportError('File has no "bodies" array.');
  if (raw.bodies.length === 0) throw new ImportError('File contains no bodies.');

  const seenIds = new Set<string>();
  const bodies = raw.bodies.map((entry, index) => {
    const body = parseBody(entry, index);
    // Duplicate ids would make the roster ambiguous: selection, the reference
    // frame and mesh keying all look bodies up by id. Re-issue rather than
    // reject, since it's recoverable and the rest of the body is fine.
    if (seenIds.has(body.id)) body.id = crypto.randomUUID();
    seenIds.add(body.id);
    return body;
  });

  return {
    version: CURRENT_VERSION,
    name,
    bodies,
    settings: parseSettings(raw.settings),
  };
}

function parseSettings(raw: unknown): SystemFile['settings'] {
  const defaults = {
    dt: DEFAULT_DT,
    snapshotInterval: DEFAULT_SNAPSHOT_INTERVAL,
    trailInterval: DEFAULT_TRAIL_INTERVAL,
  };
  if (!isRecord(raw)) return defaults;
  return {
    dt: positiveOr(raw.dt, defaults.dt),
    snapshotInterval: positiveOr(raw.snapshotInterval, defaults.snapshotInterval),
    trailInterval: positiveOr(raw.trailInterval, defaults.trailInterval),
  };
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseBody(raw: unknown, index: number): Body {
  const where = `Body ${index + 1}`;
  if (!isRecord(raw)) throw new ImportError(`${where} is not an object.`);

  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : `Body ${index + 1}`;
  const label = `"${name}"`;

  const type = BODY_TYPES.includes(raw.type as BodyType) ? (raw.type as BodyType) : 'rocky';

  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : crypto.randomUUID(),
    name,
    color: typeof raw.color === 'string' && raw.color !== '' ? raw.color : '#cccccc',
    type,
    // Coerced, not rejected: an unknown key (older build, hand-edit) just
    // falls back to the procedural surface.
    texture: REAL_TEXTURE_KEYS.includes(raw.texture as RealTextureKey)
      ? (raw.texture as RealTextureKey)
      : undefined,
    mass: requirePositive(raw.mass, `${label} mass`),
    radius: requirePositive(raw.radius, `${label} radius`),
    // Optional, and absent for everything except the planetesimal disk — but it
    // has to survive a round-trip, or saving that system quietly turns off the
    // merges it exists to demonstrate.
    collisionRadius:
      raw.collisionRadius === undefined || raw.collisionRadius === null
        ? undefined
        : requirePositive(raw.collisionRadius, `${label} collision radius`),
    // 0 means "don't spin" and negative means retrograde, so any finite number
    // is legal here; only NaN/absent is not.
    rotationPeriod: requireFinite(raw.rotationPeriod, `${label} rotation period`, 0),
    // Optional spin phase — absent for everything except tidally locked moons,
    // but it has to survive a round-trip or a saved Moon faces Earth wrong.
    rotationPhase:
      raw.rotationPhase === undefined || raw.rotationPhase === null
        ? undefined
        : requireFinite(raw.rotationPhase, `${label} rotation phase`),
    axialTilt: requireFinite(raw.axialTilt, `${label} axial tilt`, 0),
    position: requireVec3(raw.position, `${label} position`),
    velocity: requireVec3(raw.velocity, `${label} velocity`),
    atmosphere: parseAtmosphere(raw.atmosphere, label),
    rings: parseRings(raw.rings, label),
  };
}

function parseAtmosphere(raw: unknown, label: string): Body['atmosphere'] {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ImportError(`${label} has a malformed atmosphere.`);
  return {
    color: typeof raw.color === 'string' && raw.color !== '' ? raw.color : '#9fd0ff',
    density: clamp01(requireFinite(raw.density, `${label} atmosphere density`, 0.5)),
  };
}

function parseRings(raw: unknown, label: string): Body['rings'] {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ImportError(`${label} has malformed rings.`);

  const innerRadius = requirePositive(raw.innerRadius, `${label} ring inner radius`);
  const outerRadius = requirePositive(raw.outerRadius, `${label} ring outer radius`);
  if (outerRadius <= innerRadius) {
    throw new ImportError(`${label} ring outer radius must exceed the inner radius.`);
  }

  return {
    innerRadius,
    outerRadius,
    color: typeof raw.color === 'string' && raw.color !== '' ? raw.color : '#d9c9a3',
    opacity: clamp01(requireFinite(raw.opacity, `${label} ring opacity`, 0.6)),
  };
}

function requireFinite(value: unknown, what: string, fallback?: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined && fallback !== undefined) return fallback;
  throw new ImportError(`${what} must be a finite number.`);
}

function requirePositive(value: unknown, what: string): number {
  const n = requireFinite(value, what);
  if (n <= 0) throw new ImportError(`${what} must be greater than zero.`);
  return n;
}

function requireVec3(value: unknown, what: string): { x: number; y: number; z: number } {
  if (!isRecord(value)) throw new ImportError(`${what} must be an {x, y, z} object.`);
  return {
    x: requireFinite(value.x, `${what}.x`),
    y: requireFinite(value.y, `${what}.y`),
    z: requireFinite(value.z, `${what}.z`),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- localStorage --------------------------------------------------------
//
// Every read and write goes through these wrappers, which swallow the two ways
// localStorage throws in practice: unavailable entirely (Safari private mode,
// disabled cookies) and quota exceeded on write. Neither should take the app
// down — the sim runs fine without persistence.

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const store = storage();
  if (!store) return null;
  try {
    const text = store.getItem(key);
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

interface StoredSlot {
  file: SystemFile;
  savedAt: number;
}

/** Named save slots, most recently saved first. */
export function listSlots(): SaveSlot[] {
  const store = storage();
  if (!store) return [];

  const slots: SaveSlot[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null || !key.startsWith(SLOT_PREFIX)) continue;

    const stored = readJson<StoredSlot>(key);
    if (!stored || !stored.file || !Array.isArray(stored.file.bodies)) continue;

    slots.push({
      name: key.slice(SLOT_PREFIX.length),
      savedAt: typeof stored.savedAt === 'number' ? stored.savedAt : 0,
      bodyCount: stored.file.bodies.length,
    });
  }

  return slots.sort((a, b) => b.savedAt - a.savedAt);
}

/** Save a system under `name`, overwriting any slot with that name. */
export function saveSlot(name: string, file: SystemFile, now: number): boolean {
  return writeJson(SLOT_PREFIX + name, { file, savedAt: now } satisfies StoredSlot);
}

/** Load a named slot, or null if it's missing or unreadable. */
export function loadSlot(name: string): SystemFile | null {
  const stored = readJson<StoredSlot>(SLOT_PREFIX + name);
  if (!stored?.file) return null;
  try {
    // Round-trip through the validator: a slot written by an older build, or
    // hand-edited in devtools, is no more trustworthy than an imported file.
    return parseSystemFile(JSON.stringify(stored.file));
  } catch {
    return null;
  }
}

export function deleteSlot(name: string): void {
  storage()?.removeItem(SLOT_PREFIX + name);
}

/** Overwrite the autosave. Called debounced — see `SystemMenu`. */
export function writeAutosave(
  file: SystemFile,
  now: number,
  source: AutosaveSource | null = null
): boolean {
  return writeJson(AUTOSAVE_KEY, { file, savedAt: now, source } satisfies AutosaveState);
}

/**
 * The autosaved system, or null if there is none or it doesn't validate.
 *
 * A corrupt autosave must never block startup: returning null just boots the
 * default system instead.
 */
export function readAutosave(): AutosaveState | null {
  const stored = readJson<AutosaveState>(AUTOSAVE_KEY);
  if (!stored?.file) return null;
  try {
    // An autosave written by an older build carries a `simTime`; it's read past
    // deliberately, so upgrading lands at t = 0 like every other cold load
    // rather than resurrecting a clock this build no longer restores.
    return {
      file: parseSystemFile(JSON.stringify(stored.file)),
      savedAt: typeof stored.savedAt === 'number' ? stored.savedAt : 0,
      source: parseAutosaveSource(stored.source),
    };
  } catch {
    return null;
  }
}

/**
 * A bad source must not invalidate the autosave — the roster is intact, only
 * revert's provenance is lost — so this degrades to null instead of throwing.
 * Whether the id still exists in its registry is the reconstitution site's
 * problem (`state/system.svelte.ts`), not a storage concern.
 */
function parseAutosaveSource(raw: unknown): AutosaveSource | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  if (raw.kind === 'preset' || raw.kind === 'gallery') return { kind: raw.kind, id: raw.id };
  if (raw.kind === 'mission' && typeof raw.prediction === 'number') {
    return { kind: 'mission', id: raw.id, prediction: raw.prediction };
  }
  return null;
}

export function clearAutosave(): void {
  storage()?.removeItem(AUTOSAVE_KEY);
}

// --- mission progress ----------------------------------------------------

/**
 * Ids of missions the user has completed — the mission dialog's tally. Stored
 * as ids rather than a count so re-completing a mission can't inflate it, and
 * so the dialog can mark individual missions done. Unknown ids (from a build
 * whose mission list has since changed) are filtered out on read.
 */
export function readCompletedMissions(validIds: readonly string[]): string[] {
  const stored = readJson<unknown>(MISSIONS_KEY);
  if (!Array.isArray(stored)) return [];
  return [
    ...new Set(stored.filter((id): id is string => typeof id === 'string' && validIds.includes(id))),
  ];
}

export function writeCompletedMissions(ids: readonly string[]): boolean {
  return writeJson(MISSIONS_KEY, ids);
}

// --- first visit ---------------------------------------------------------

/**
 * Whether the welcome dialog has been shown before.
 *
 * A returning visitor with no storage (private mode, disabled cookies) reads as
 * a first visit and sees the welcome again on every load. That's the same
 * degradation as every other persisted thing here — the alternative is
 * suppressing the welcome for genuinely new users, which is the worse failure.
 */
export function hasBeenWelcomed(): boolean {
  return readJson<unknown>(WELCOMED_KEY) === true;
}

export function markWelcomed(): boolean {
  return writeJson(WELCOMED_KEY, true);
}

// --- file export / import ------------------------------------------------

/** Serialize for download, pretty-printed so the file is hand-editable. */
export function serializeSystemFile(file: SystemFile): string {
  return JSON.stringify(file, null, 2);
}

/** Filename-safe version of a system name. */
export function exportFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'system'}.json`;
}

export function downloadSystemFile(file: SystemFile): void {
  const blob = new Blob([serializeSystemFile(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename(file.name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; one turn of
  // the event loop is enough for the click to have been consumed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Core data model. See GUIDE.md — Architecture / Data model.
// Units are SI everywhere: meters, kilograms, seconds.

import type { Vec3 } from './physics/vec3';

export type BodyType =
  | 'star'
  | 'earthlike'
  | 'rocky'
  | 'gas'
  | 'ice'
  | 'dwarf'
  | 'moon'
  | 'asteroid'
  | 'satellite'
  | 'blackhole';

/**
 * Bodies with a photographic surface map committed under
 * `public/textures/real/<key>.jpg`. The list is the contract between the data
 * model, the import validator, and the files on disk.
 */
export const REAL_TEXTURE_KEYS = [
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'ceres',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
] as const;

export type RealTextureKey = (typeof REAL_TEXTURE_KEYS)[number];

export interface Body {
  id: string; // crypto.randomUUID()
  name: string;
  color: string; // hex, tints the procedural texture + trail + UI
  /**
   * Photographic map to draw instead of the procedural (type, id-hash) one.
   * A real body's surface is not recolorable: the hue rotation `color` applies
   * to procedural maps is skipped, and `color` only tints trail, label and UI.
   */
  texture?: RealTextureKey;
  // Drives texture style + material. 'blackhole' also switches the body's
  // gravity to the Paczyński–Wiita pseudo-potential — see physics/gravity.ts.
  type: BodyType;
  mass: number; // kg
  radius: number; // m — display size; also the collision size unless overridden
  /**
   * m — merge-detection radius when it should differ from the drawn one;
   * defaults to `radius`. Exists for the planetesimal disk, where bodies at
   * honest radii never touch on a scrubbable timescale — inflating `radius`
   * instead would draw them at tens of times their true size.
   */
  collisionRadius?: number;
  rotationPeriod: number; // s; negative = retrograde; 0 = tidally locked display off
  /**
   * degrees — spin angle at t = 0, defaulting to 0. Exists for tidally locked
   * moons: which face points at the parent is set by the phase, not the period.
   */
  rotationPhase?: number;
  axialTilt: number; // degrees
  position: Vec3; // m — system barycentric frame
  velocity: Vec3; // m/s
  atmosphere?: {
    color: string; // glow rim color
    density: number; // 0–1, drives glow thickness/opacity
  };
  rings?: {
    innerRadius: number; // m
    outerRadius: number; // m
    color: string;
    opacity: number; // 0–1
  };
}

// Save/export format, versioned.
export interface SystemFile {
  version: 1;
  name: string;
  bodies: Body[]; // state at t = 0
  /**
   * Timing grids. `trailInterval` is optional so older v1 files still parse; it
   * falls back to the default on load.
   */
  settings: { dt: number; snapshotInterval: number; trailInterval?: number };
}

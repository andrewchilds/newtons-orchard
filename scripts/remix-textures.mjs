// Remix renderer for the cratered body types (rocky, moon, dwarf, asteroid).
//
// Procedural crater synthesis was tried at length and never stopped reading as
// CG — crater profiles came out as donuts or bubbles no matter how the analytic
// curve was tuned. Real cratering statistics are unfakeable at a glance, so
// these variants are instead *remixes* of the committed public-domain mosaics
// in `public/textures/real/` (moon, mercury, mars, ceres — provenance in
// SOURCES.md): each variant wrap-shifts, mirrors and exposure-matches the
// sources, composites them through smooth province masks, and gradient-maps the
// result to the type's REFERENCE_COLOR so the runtime hue-rotation shader works
// exactly as it does on the procedural bakes.
//
// Everything is seeded per (type, variant) — a given variant bakes
// byte-identical output, same contract as textureCore.ts.
//
// Node-only (reads files, decodes JPEG); the browser never imports this. The
// non-cratered types (star, gas, ice, earthlike, satellite) stay procedural in
// textureCore.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decode as decodeJpeg } from 'jpeg-js';

import {
  REFERENCE_COLOR,
  TEX_SIZES,
  VARIANTS_BY_TYPE,
  mulberry32,
  hashSeed,
} from '../src/lib/scene/textureCore.ts';

export const REMIXED_TYPES = ['rocky', 'moon', 'dwarf', 'asteroid'];

const REAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures', 'real');

// Ceres is overlay-only: the HAMO mosaic's high latitudes carry baked-in
// low-sun shadows, so it can never be the layer that survives at the poles.
const BASE_SOURCES = ['moon', 'mercury', 'mars'];
const ALL_SOURCES = [...BASE_SOURCES, 'ceres'];

// --- luminance sources ----------------------------------------------------

/** (name, width) → Float32Array luminance in [0, 1], cached across jobs. */
const lumCache = new Map();

function sourceLuminance(name, width, height) {
  const key = `${name}|${width}`;
  let lum = lumCache.get(key);
  if (lum) return lum;

  const { width: sw, height: sh, data } = decodeJpeg(readFileSync(join(REAL_DIR, `${name}.jpg`)), {
    useTArray: true,
  });
  const full = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    // Rec. 709 luma on the RGBA decode.
    full[i] = (data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722) / 255;
  }

  lum = sw === width ? full : resampleArea(full, sw, sh, width, height);
  lumCache.set(key, lum);
  return lum;
}

/** Area-weighted resample (separable), correct for non-integer ratios. */
function resampleArea(src, sw, sh, dw, dh) {
  const pass = (input, inLen, outLen, lines, stride, lineStride, outStride, outLineStride) => {
    const out = new Float32Array(outLen * lines);
    const ratio = inLen / outLen;
    for (let o = 0; o < outLen; o++) {
      const start = o * ratio;
      const end = start + ratio;
      const i0 = Math.floor(start);
      const i1 = Math.min(inLen - 1, Math.ceil(end) - 1);
      for (let line = 0; line < lines; line++) {
        let sum = 0;
        for (let i = i0; i <= i1; i++) {
          const cover = Math.min(end, i + 1) - Math.max(start, i);
          sum += input[line * lineStride + i * stride] * cover;
        }
        out[line * outLineStride + o * outStride] = sum / ratio;
      }
    }
    return out;
  };
  // Horizontal (rows are lines), then vertical (columns are lines).
  const horiz = pass(src, sw, dw, sh, 1, sw, 1, dw);
  return pass(horiz, sh, dh, dw, dw, 1, dw, 1);
}

// --- field ops ------------------------------------------------------------

function rollMirror(src, width, height, shift, mirror) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const sx = (x + shift) % width;
      out[row + (mirror ? width - 1 - x : x)] = src[row + sx];
    }
  }
  return out;
}

/** Normalize to mean 0.5 / std 0.15 so composites have no exposure steps. */
function standardize(field) {
  let mean = 0;
  for (let i = 0; i < field.length; i++) mean += field[i];
  mean /= field.length;
  let varSum = 0;
  for (let i = 0; i < field.length; i++) varSum += (field[i] - mean) ** 2;
  const std = Math.sqrt(varSum / field.length) + 1e-9;
  for (let i = 0; i < field.length; i++) field[i] = ((field[i] - mean) / std) * 0.15 + 0.5;
  return field;
}

/**
 * Box radii whose triple application approximates a Gaussian of `sigma`
 * (Kovesi's construction). Exact Gaussian shape is irrelevant here — the masks
 * are thresholded smooth noise — but O(n) running-sum blurs keep a sigma-110
 * blur over 2 M texels affordable where a direct kernel would not be.
 */
function boxRadiiFor(sigma, passes = 3) {
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - passes * wl * wl - 4 * passes * wl - 3 * passes) / (-4 * wl - 4));
  return Array.from({ length: passes }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

/** Horizontal box blur, wrapping — the map is periodic in longitude. */
function boxBlurH(field, width, height, r) {
  if (r <= 0) return;
  const norm = 1 / (2 * r + 1);
  const row = new Float32Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += field[base + ((i + width) % width)];
    for (let x = 0; x < width; x++) {
      row[x] = sum * norm;
      sum += field[base + ((x + r + 1) % width)] - field[base + ((x - r + width) % width)];
    }
    field.set(row, base);
  }
}

/** Vertical box blur, reflecting at the poles. */
function boxBlurV(field, width, height, r) {
  if (r <= 0) return;
  const norm = 1 / (2 * r + 1);
  // Reflect indexing (scipy "reflect": d c b a | a b c d).
  const ref = (y) => {
    const period = 2 * height;
    let m = ((y % period) + period) % period;
    return m < height ? m : period - 1 - m;
  };
  const col = new Float32Array(height);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += field[ref(i) * width + x];
    for (let y = 0; y < height; y++) {
      col[y] = sum * norm;
      sum += field[ref(y + r + 1) * width + x] - field[ref(y - r) * width + x];
    }
    for (let y = 0; y < height; y++) field[y * width + x] = col[y];
  }
}

/**
 * Smooth periodic province mask: uniform noise Gaussian-blurred to `sigma`,
 * min-max normalized to [0, 1].
 */
function smoothMask(seed, width, height, sigma) {
  const rand = mulberry32(seed);
  const field = new Float32Array(width * height);
  for (let i = 0; i < field.length; i++) field[i] = rand();
  for (const r of boxRadiiFor(sigma)) {
    boxBlurH(field, width, height, r);
    boxBlurV(field, width, height, r);
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    if (field[i] < min) min = field[i];
    if (field[i] > max) max = field[i];
  }
  const inv = 1 / (max - min + 1e-9);
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - min) * inv;
  return field;
}

/** True separable Gaussian — the unsharp radius is small enough to afford. */
function gaussianBlur(src, width, height, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(2 * r + 1);
  let kSum = 0;
  for (let i = -r; i <= r; i++) {
    kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    kSum += kernel[i + r];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= kSum;

  const tmp = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[base + ((x + i + width) % width)] * kernel[i + r];
      tmp[base + x] = sum;
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(height - 1, Math.max(0, y + i));
        sum += tmp[yy * width + x] * kernel[i + r];
      }
      out[y * width + x] = sum;
    }
  }
  return out;
}

// --- the recipe -----------------------------------------------------------

// Overlay masks, largest provinces first: falling sigma and rising threshold
// give one or two broad provinces, then smaller patches of the later sources.
const MASK_SIGMAS = [110, 80, 60];
const MASK_THRESHOLDS = [0.48, 0.58, 0.66];
const MASK_TRANSITION = 0.055;

const clip01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Render one remixed variant as `Pixels` (same shape textureCore's renderers
 * return), ready for the baker's JPEG encoder.
 */
export function renderRemixedTexture(type, variant) {
  if (!REMIXED_TYPES.includes(type)) throw new Error(`not a remixed type: ${type}`);
  if (variant >= VARIANTS_BY_TYPE[type]) throw new Error(`no variant ${variant} for ${type}`);

  const width = TEX_SIZES[type];
  const height = width / 2;
  // Everything below scales with the map so a 512 asteroid gets the same
  // pattern proportions as a 2048 rocky.
  const rel = width / 2048;
  const rand = mulberry32(hashSeed(`${type}|${variant}`));

  // Per-source processing, in fixed order so the rand stream is stable.
  const layers = {};
  for (const name of ALL_SOURCES) {
    const shift = Math.floor(rand() * width);
    const mirror = rand() < 0.5;
    layers[name] = standardize(
      rollMirror(sourceLuminance(name, width, height), width, height, shift, mirror)
    );
  }

  const baseName = BASE_SOURCES[Math.floor(rand() * BASE_SOURCES.length)];
  const overlays = ALL_SOURCES.filter((n) => n !== baseName);
  // Fisher–Yates so which source gets the broad provinces varies per variant.
  for (let i = overlays.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [overlays[i], overlays[j]] = [overlays[j], overlays[i]];
  }

  const comp = Float32Array.from(layers[baseName]);

  // Latitude feather: overlays die out before the map's longitudes converge at
  // the poles — a province boundary crossing the pole pinches into a visible
  // wedge on the sphere.
  // Polar handover to the processed moon layer: mercury's poles are mosaic
  // coverage gaps and mars's are ice caps — both wrong for a generic rock.
  // Mars's caps reach much further from the pole than mercury's gaps (down to
  // |lat| ≈ 0.84), so a mars base hands over early enough to be fully moon by
  // 0.82 — the latitude where the overlay feather has already gone to zero.
  const handoverStart = baseName === 'mars' ? 0.68 : 0.8;
  const handoverWidth = 0.14;
  const feather = new Float32Array(height);
  const polar = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const lat = 1 - (2 * (y + 0.5)) / height;
    feather[y] = clip01((0.82 - Math.abs(lat)) / 0.18) ** 2;
    polar[y] = clip01((Math.abs(lat) - handoverStart) / handoverWidth) ** 2;
  }

  overlays.forEach((name, k) => {
    const mask = smoothMask(hashSeed(`${type}|${variant}|mask${k}`), width, height, MASK_SIGMAS[k] * rel);
    const layer = layers[name];
    const threshold = MASK_THRESHOLDS[k];
    for (let y = 0; y < height; y++) {
      const f = feather[y];
      if (f === 0) continue;
      const base = y * width;
      for (let x = 0; x < width; x++) {
        const i = base + x;
        const w = clip01((mask[i] - threshold) / MASK_TRANSITION) * f;
        if (w > 0) comp[i] += (layer[i] - comp[i]) * w;
      }
    }
  });

  const moonLayer = layers.moon;
  for (let y = 0; y < height; y++) {
    const p = polar[y];
    if (p === 0) continue;
    const base = y * width;
    for (let x = 0; x < width; x++) {
      comp[base + x] += (moonLayer[base + x] - comp[base + x]) * p;
    }
  }

  // Unsharp mask: the exposure-matching above costs local contrast; this buys
  // crater-scale contrast back without touching the global histogram.
  const blurred = gaussianBlur(comp, width, height, 2.5 * rel);
  for (let i = 0; i < comp.length; i++) comp[i] += (comp[i] - blurred[i]) * 0.5;

  // Gradient-map luminance to the type's reference color, midpoint pinned to
  // it, so the hue-rotation shader sees the same reference hue as every other
  // bake. Shadows keep a trace of the hue (×0.15, not black) and highlights
  // stop short of white — full-range mapping reads as scorched.
  const ref = [REFERENCE_COLOR[type].r / 255, REFERENCE_COLOR[type].g / 255, REFERENCE_COLOR[type].b / 255];
  const lo = ref.map((c) => c * 0.15);
  const hi = ref.map((c) => c + (1 - c) * 0.6);
  const data = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < comp.length; i++) {
    const l = clip01(comp[i]);
    for (let ch = 0; ch < 3; ch++) {
      const v =
        l < 0.5 ? lo[ch] + (ref[ch] - lo[ch]) * (l / 0.5) : ref[ch] + (hi[ch] - ref[ch]) * ((l - 0.5) / 0.5);
      data[i * 3 + ch] = v * 255;
    }
  }
  return { width, height, data };
}

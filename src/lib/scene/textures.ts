// Baked body textures: loading, sharing, and hue rotation.
//
// Surfaces are rendered offline by `scripts/bake-textures.mjs` from the
// generators in `textureCore.ts`, committed under `public/textures/`, and
// described by `textureManifest.json`.
//
// Each type is baked in a fixed *reference color* (hue recorded in the
// manifest); a body's color is applied at render time by rotating the sampled
// texel's hue by (bodyHue − referenceHue) — see `applyHueRotation`. Rotating
// rather than multiplying a tint preserves intra-map hue relationships (green
// land vs blue ocean, gold foil vs silver radiators), which a tint multiply
// would collapse toward one hue.
//
// A body's variant is chosen by hashing its id, so it keeps the same surface
// across reloads and seeks.

import * as THREE from 'three';
import type { BodyType, RealTextureKey } from '../types';

/**
 * Types with baked surface maps — everything but `blackhole`, which renders as
 * a plain black sphere. The narrower type makes asking for a black hole's
 * texture a compile error rather than a missing-manifest crash at runtime.
 */
export type TexturedBodyType = Exclude<BodyType, 'blackhole'>;
import manifest from './textureManifest.json';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a 32-bit seed (FNV-1a). Must match the baker's. */
function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- loading and caching ----------------------------------------------------

/**
 * Loaded textures keyed by file, never evicted or disposed. The key space is
 * bounded (Σ variants per type), and a texture shared by several live bodies
 * has no single owner: per-body disposal would free a map still in use by
 * another body the moment one of them was deleted.
 */
const textureCache = new Map<string, THREE.Texture>();

/** Drop every cached texture. Only for teardown in tests. */
export function clearTextureCache(): void {
  for (const texture of textureCache.values()) texture.dispose();
  textureCache.clear();
}

/**
 * Load an image from `public/textures/` into a texture, synchronously
 * returning a 1×1 `placeholder`-colored texture that the real pixels replace
 * when the download lands — so a new body renders roughly the right color
 * while the image is in flight rather than flashing black.
 */
function loadShared(
  file: string,
  placeholder: string,
  configure: (texture: THREE.Texture) => void
): THREE.Texture {
  const cached = textureCache.get(file);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = placeholder;
    ctx.fillRect(0, 0, 1, 1);
  }

  // Annotated as the base type: the constructor argument would otherwise pin
  // `image` to HTMLCanvasElement, which the loaded HTMLImageElement replaces.
  const texture: THREE.Texture = new THREE.Texture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  configure(texture);
  texture.needsUpdate = true;

  const image = new Image();
  image.onload = () => {
    texture.image = image;
    // A frame rendered mid-download allocated GL storage immutably
    // (texStorage2D) at the placeholder's 1×1 size; needsUpdate alone would
    // texSubImage2D the real image into that one texel, leaving a flat sphere
    // forever. Dispose frees the GL texture so the next render re-allocates at
    // the image's true size.
    texture.dispose();
    texture.needsUpdate = true;
  };
  image.src = `${import.meta.env.BASE_URL}textures/${file}`;

  textureCache.set(file, texture);
  return texture;
}

/**
 * The texture for a body. **Shared and owned by this module** — callers must
 * not dispose it; see `textureCache`.
 *
 * `seed` should be the body id: stable per body, so it looks the same across
 * reloads. It selects one of the type's baked variants. Color doesn't split
 * the cache — it's a shader uniform, not pixels.
 */
export function createBodyTexture(type: TexturedBodyType, seed: string): THREE.Texture {
  const variant = hashSeed(seed) % manifest.types[type].variants;
  return loadShared(`${type}-${variant}.jpg`, referenceCss(type), (texture) => {
    // Equirectangular wrap: seamless around the equator, clamped at the poles.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 4;
  });
}

/**
 * Rough mean color of each real map, for the loading placeholder — same role
 * as `referenceCss` for the procedural maps.
 */
const REAL_PLACEHOLDERS: Record<RealTextureKey, string> = {
  mercury: '#8a8481',
  venus: '#c9a468',
  earth: '#2c4a6e',
  moon: '#8f8d8a',
  mars: '#a1583a',
  ceres: '#74716c',
  jupiter: '#c3a183',
  saturn: '#cbb586',
  uranus: '#9dc9d6',
  neptune: '#3c5dc0',
};

/**
 * Photographic map for a real solar-system body, shared like the procedural
 * maps. No hue rotation is ever applied to these — the photo already carries
 * the body's true colors, and there is no baked reference hue to rotate from.
 */
export function createRealBodyTexture(key: RealTextureKey): THREE.Texture {
  return loadShared(`real/${key}.jpg`, REAL_PLACEHOLDERS[key], (texture) => {
    // Equirectangular wrap: seamless around the equator, clamped at the poles.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 4;
  });
}

/**
 * Solar-array texture for a satellite's wings, shared like the body maps.
 *
 * Deliberately **not** hue-rotated: photovoltaic cells are blue-violet
 * whatever the craft's accent color is, and recoloring reads as a toy.
 */
export function createSolarPanelTexture(seed: string): THREE.Texture {
  const variant = hashSeed(seed) % manifest.panelVariants;
  return loadShared(`panel-${variant}.png`, '#12172b', (texture) => {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 4;
  });
}

// --- hue rotation -------------------------------------------------------------

/** Hue of a `#rgb`/`#rrggbb` color in [0, 1), by the standard HSL formula. */
function hueOf(colorHex: string): number {
  let hex = colorHex.replace('#', '');
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h / 6;
}

/** A CSS color at the type's reference hue, for the loading placeholder. */
function referenceCss(type: TexturedBodyType): string {
  return `hsl(${Math.round(manifest.types[type].hue * 360)}, 30%, 55%)`;
}

/**
 * GLSL for hue rotation, injected below. The conversion runs in sRGB — the
 * space the manifest hues were computed in — so rotating matches them exactly;
 * rotating the sampler's linear-light values lands near but off the body's
 * swatch. `sRGBTransferOETF`/`EOTF` come from the fragment shader prelude.
 */
const HUE_GLSL = /* glsl */ `
uniform float hueShift;

vec3 hueRgb2Hsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float l = (maxC + minC) * 0.5;
  float d = maxC - minC;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = d / (1.0 - abs(2.0 * l - 1.0));
  float h = maxC == c.r ? mod((c.g - c.b) / d, 6.0)
          : maxC == c.g ? (c.b - c.r) / d + 2.0
          : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

vec3 hueHsl2Rgb(vec3 hsl) {
  float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float hp = hsl.x * 6.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb = hp < 1.0 ? vec3(c, x, 0.0)
           : hp < 2.0 ? vec3(x, c, 0.0)
           : hp < 3.0 ? vec3(0.0, c, x)
           : hp < 4.0 ? vec3(0.0, x, c)
           : hp < 5.0 ? vec3(x, 0.0, c)
           : vec3(c, 0.0, x);
  return rgb + (hsl.z - c * 0.5);
}

vec3 hueRotate(vec3 linearColor) {
  vec3 srgb = sRGBTransferOETF(vec4(linearColor, 1.0)).rgb;
  vec3 hsl = hueRgb2Hsl(srgb);
  hsl.x = fract(hsl.x + hueShift);
  return sRGBTransferEOTF(vec4(hueHsl2Rgb(hsl), 1.0)).rgb;
}
`;

/**
 * Give a material a hue-rotated view of its (shared) map and emissiveMap.
 *
 * Callable repeatedly: the first call installs the shader patch, later calls
 * retarget the uniform, so a color or type edit needs no recompile. Both maps
 * rotate so a star's surface and glow shift together; a missing map compiles
 * its branch out.
 */
export function applyHueRotation(
  material: THREE.MeshStandardMaterial,
  type: TexturedBodyType,
  colorHex: string
): void {
  const shift = hueOf(colorHex) - manifest.types[type].hue;
  const existing = material.userData.hueShift as { value: number } | undefined;
  if (existing) {
    existing.value = shift;
    return;
  }

  const uniform = { value: shift };
  material.userData.hueShift = uniform;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hueShift = uniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${HUE_GLSL}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  sampledDiffuseColor.rgb = hueRotate( sampledDiffuseColor.rgb );
  diffuseColor *= sampledDiffuseColor;
#endif
`
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
  emissiveColor.rgb = hueRotate( emissiveColor.rgb );
  totalEmissiveRadiance *= emissiveColor.rgb;
#endif
`
      );
  };
  // One program cache entry for all hue-rotated materials: the patch is
  // identical, only the uniform differs.
  material.customProgramCacheKey = () => 'hue-rotate';
  material.needsUpdate = true;
}

/**
 * Make an installed hue rotation a no-op — for a material whose map switched
 * to a photographic one (`Body.texture`), where any rotation falsifies the
 * photo. A material that never had the patch needs nothing; a fresh real-map
 * material just skips `applyHueRotation` instead of calling this.
 */
export function neutralizeHueRotation(material: THREE.MeshStandardMaterial): void {
  const existing = material.userData.hueShift as { value: number } | undefined;
  if (existing) existing.value = 0;
}

// --- starfield ----------------------------------------------------------------

const SKY_RADIUS = 4e5;
const SKY_STAR_COUNT = 2400;
/** Extra stars concentrated toward the galactic plane. */
const BAND_STAR_COUNT = 1400;
const BRIGHT_STAR_COUNT = 90;
/** Gaussian half-thickness of the galactic band, radians of latitude. */
const BAND_SIGMA = 0.15;

/**
 * Peak channel for any sky star. The ceiling keeps every star under the bloom
 * pass's 0.62 threshold: a star that crosses it goes through UnrealBloom's
 * downsample/upsample chain, which resamples a ~1px dot differently each frame
 * and makes the whole sky shimmer. `bodyDots` assumes this ceiling when it
 * picks a dot peak that outranks the sky.
 */
const SKY_STAR_MAX = 0.56;

/** Standard normal from the seeded stream (Box–Muller). */
function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
}

/**
 * Star tint for temperature `t` ∈ [0, 1], warm → white → blue-white. The peak
 * channel stays at 1 so brightness remains an independent knob.
 */
function starTint(t: number): [number, number, number] {
  if (t < 0.5) {
    const k = t * 2;
    return [1, 0.72 + 0.28 * k, 0.5 + 0.5 * k];
  }
  const k = t * 2 - 1;
  return [1 - 0.34 * k, 1 - 0.18 * k, 1];
}

function makeStarPoints(positions: Float32Array, colors: Float32Array, size: number): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Screen-space sizing rather than `sizeAttenuation`: the sky sphere is parked
  // on the camera, so an attenuated point projects to a fixed *sub-pixel*
  // footprint that lands on a different sample each frame and shimmers under
  // bloom. A couple of screen pixels is stable under resampling and motion.
  const material = new THREE.PointsMaterial({
    size,
    sizeAttenuation: false,
    vertexColors: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -1;
  return points;
}

/**
 * The sky's diffuse content — galactic band glow, dust lanes, a few deep-sky
 * smudges — painted once onto an equirect canvas and worn on the inside of a
 * sphere. Additive over the near-black clear color, so unpainted canvas costs
 * nothing; a smooth low-frequency texture resamples stably, unlike sub-pixel
 * points, so it can't shimmer under bloom. Painted values stay far below the
 * 0.62 bloom threshold.
 */
function createSkyDome(rand: () => number): THREE.Mesh {
  const W = 2048;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const finalCtx = canvas.getContext('2d')!;
  const paint = document.createElement('canvas');
  paint.width = W;
  paint.height = H;
  let ctx = paint.getContext('2d')!;
  const mid = H / 2;

  // Soft elliptical gradient blob; re-drawn shifted a canvas-width when it
  // overhangs a seam, or the band shows a gap at the wrap longitude.
  const blob = (
    x: number,
    y: number,
    r: number,
    aspect: number,
    angle: number,
    color: string
  ): void => {
    for (const dx of [0, -W, W]) {
      if (dx !== 0 && Math.abs(x + dx - W / 2) > W / 2 + r) continue;
      ctx.save();
      ctx.translate(x + dx, y);
      ctx.rotate(angle);
      ctx.scale(1, aspect);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r, -r / aspect, r * 2, (r * 2) / aspect);
      ctx.restore();
    }
  };
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const starlight = (warm: number, alpha: number) =>
    `rgba(${mix(198, 255, warm)},${mix(213, 236, warm)},${mix(255, 216, warm)},${alpha})`;

  // The band: clumped soft blobs along the equator (the group's rotation
  // tilts it to its place in the sky).
  for (let i = 0; i < 260; i++) {
    const x = rand() * W;
    const y = mid + gaussian(rand) * 40;
    blob(x, y, 50 + rand() * 110, 0.5 + rand() * 0.5, 0, starlight(rand(), 0.016 + rand() * 0.024));
  }

  // The bulge: a brighter, warmer clump around one longitude.
  const bulgeX = W * 0.62;
  blob(bulgeX, mid, 260, 0.45, 0, starlight(0.85, 0.04));
  for (let i = 0; i < 50; i++) {
    const x = bulgeX + gaussian(rand) * 140;
    const y = mid + gaussian(rand) * 28;
    blob(x, y, 40 + rand() * 80, 0.5 + rand() * 0.4, 0, starlight(0.6 + rand() * 0.4, 0.02 + rand() * 0.03));
  }

  // Dust lanes: erase streaks hugging the centerline. Erasing beats painting
  // dark — the sphere is additive, so "dark" can only mean less glow.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 70; i++) {
    const x = rand() * W;
    const y = mid + gaussian(rand) * 16;
    blob(x, y, 30 + rand() * 70, 0.2 + rand() * 0.2, (rand() - 0.5) * 0.5, `rgba(0,0,0,${0.05 + rand() * 0.1})`);
  }
  ctx.globalCompositeOperation = 'source-over';

  // Nebulas: faintly colored patches in and near the band, layered pairs so
  // they read as irregular rather than round.
  const nebulaColors = ['rgba(120,190,185,', 'rgba(205,150,160,', 'rgba(150,160,215,'];
  for (let i = 0; i < 4; i++) {
    const x = rand() * W;
    const y = mid + gaussian(rand) * 70;
    const color = nebulaColors[i % nebulaColors.length];
    const r = 26 + rand() * 34;
    blob(x, y, r, 0.5 + rand() * 0.4, rand() * Math.PI, `${color}${0.04 + rand() * 0.03})`);
    blob(x + (rand() - 0.5) * r, y + (rand() - 0.5) * r * 0.6, r * 0.6, 0.6, rand() * Math.PI, `${color}0.04)`);
  }

  // Canvas gradients are dithered (Skia's banding fix), and at this texel
  // density the noise magnifies into a visible dot lattice on screen. Blurring
  // the diffuse layer into the final canvas averages it out; the three shifted
  // copies keep the wrap seam continuous under the blur window.
  // Flatten onto opaque black first: on a transparent canvas the stored color
  // is premultiplied, so at these low alphas the un-premultiplied RGB the GPU
  // receives is quantized to a handful of coarse steps (multi-LSB banding no
  // amount of dither survives — the noise rescales by alpha on upload).
  // Opaque means RGB *is* the light value, quantized at full 8-bit precision.
  finalCtx.fillStyle = '#000';
  finalCtx.fillRect(0, 0, W, H);
  finalCtx.filter = 'blur(5px)';
  for (const dx of [0, -W, W]) finalCtx.drawImage(paint, dx, 0);
  finalCtx.filter = 'none';
  ctx = finalCtx;

  // The blur also removes the dither, which re-exposes 8-bit banding as
  // contour arcs across the glow. Re-dither with structureless noise — ±1.5
  // LSB, one offset per pixel so the grain doesn't sparkle with false color.
  const img = finalCtx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) continue;
    const n = rand() * 4 - 2;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  finalCtx.putImageData(img, 0, 0);

  // Distant galaxies: tiny tilted ellipses off the band, a dim halo around a
  // small warm core. Drawn after the blur so their cores stay crisp. The
  // first is the local "Andromeda", a bit larger.
  for (let i = 0; i < 6; i++) {
    const x = rand() * W;
    const side = rand() < 0.5 ? -1 : 1;
    const y = mid + side * (H * 0.12 + rand() * H * 0.26);
    const size = i === 0 ? 20 : 7 + rand() * 9;
    const angle = rand() * Math.PI;
    blob(x, y, size, 0.3 + rand() * 0.3, angle, `rgba(215,220,255,${i === 0 ? 0.2 : 0.3})`);
    blob(x, y, size * 0.3, 0.5, angle, 'rgba(255,244,228,0.4)');
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // No mipmaps: near the dome's poles the u axis minifies hard, and mip
  // selection lands on a level where the dither noise has averaged away and
  // the requantized gradient breaks into contour rings around the pole
  // (anisotropic filtering would fix it, but SwiftShader — the CI/screenshot
  // renderer — doesn't support it). Level-0 sampling keeps the grain, which
  // is what masks the banding; the texture is low-frequency, so skipping
  // minification can't alias anything else.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  // Slightly inside the star shell; depthWrite is off, so it can't occlude.
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS * 0.98, 64, 32), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return mesh;
}

/**
 * Starfield background on a far sphere: field stars, a galactic band of
 * concentrated stars over a painted glow, and a sparse bright layer. The
 * caller adds the group to the scene and disposes its contents. The camera's
 * `far` plane must exceed `SKY_RADIUS`.
 */
export function createStarfield(): THREE.Group {
  const rand = mulberry32(0x5eed);
  const total = SKY_STAR_COUNT + BAND_STAR_COUNT;
  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);

  const setStar = (
    i: number,
    x: number,
    y: number,
    z: number,
    brightness: number,
    temp: number
  ): void => {
    const i3 = i * 3;
    positions[i3] = x * SKY_RADIUS;
    positions[i3 + 1] = y * SKY_RADIUS;
    positions[i3 + 2] = z * SKY_RADIUS;
    const [r, g, b] = starTint(temp);
    colors[i3] = r * brightness;
    colors[i3 + 1] = g * brightness;
    colors[i3 + 2] = b * brightness;
  };

  for (let i = 0; i < SKY_STAR_COUNT; i++) {
    // Uniform on the sphere: y uniform in [-1,1], azimuth uniform.
    const y = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    // Power-law brightness (many dim, few bright); triangular temperature so
    // most stars sit near white with warm and blue tails.
    setStar(
      i,
      Math.cos(theta) * r,
      y,
      Math.sin(theta) * r,
      0.22 + (SKY_STAR_MAX - 0.22) * Math.pow(rand(), 1.7),
      (rand() + rand()) / 2
    );
  }

  // Band stars: gaussian latitude about the equator (the group rotation tilts
  // the plane), dimmer and warmer than the field — distant disc stars seen
  // through dust.
  for (let i = 0; i < BAND_STAR_COUNT; i++) {
    const az = rand() * Math.PI * 2;
    const lat = Math.max(-1.2, Math.min(1.2, gaussian(rand) * BAND_SIGMA));
    const c = Math.cos(lat);
    setStar(
      SKY_STAR_COUNT + i,
      Math.cos(az) * c,
      Math.sin(lat),
      Math.sin(az) * c,
      0.15 + 0.28 * Math.pow(rand(), 1.6),
      0.4 * (rand() + rand())
    );
  }

  const brightPositions = new Float32Array(BRIGHT_STAR_COUNT * 3);
  const brightColors = new Float32Array(BRIGHT_STAR_COUNT * 3);
  for (let i = 0; i < BRIGHT_STAR_COUNT; i++) {
    const y = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    const i3 = i * 3;
    brightPositions[i3] = Math.cos(theta) * r * SKY_RADIUS;
    brightPositions[i3 + 1] = y * SKY_RADIUS;
    brightPositions[i3 + 2] = Math.sin(theta) * r * SKY_RADIUS;
    const [cr, cg, cb] = starTint((rand() + rand()) / 2);
    const brightness = 0.4 + (SKY_STAR_MAX - 0.4) * rand();
    brightColors[i3] = cr * brightness;
    brightColors[i3 + 1] = cg * brightness;
    brightColors[i3 + 2] = cb * brightness;
  }

  const group = new THREE.Group();
  group.add(createSkyDome(rand));
  group.add(makeStarPoints(positions, colors, 1.6));
  group.add(makeStarPoints(brightPositions, brightColors, 2.6));
  // Tilt the galactic plane off the ecliptic so the band crosses the default
  // view diagonally instead of edge-on.
  group.rotation.set(-0.2, 0, 0.5);
  return group;
}

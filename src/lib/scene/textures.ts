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

/**
 * Starfield background points on a far sphere. The caller adds the Points to
 * the scene and disposes it. The camera's `far` plane must exceed `radius`.
 */
export function createStarfield(count = 3000, radius = 4e5): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const rand = mulberry32(0x5eed);

  for (let i = 0; i < count; i++) {
    // Uniform on the sphere: z uniform in [-1,1], azimuth uniform.
    const z = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    const i3 = i * 3;
    positions[i3] = Math.cos(theta) * r * radius;
    positions[i3 + 1] = z * radius;
    positions[i3 + 2] = Math.sin(theta) * r * radius;

    // Slight color variation: most white, some warm, some blue.
    //
    // The brightness ceiling keeps every star under the bloom pass's 0.62
    // threshold. A star that crosses it goes through UnrealBloom's
    // downsample/upsample chain, which resamples a ~1px dot differently each
    // frame and makes the whole sky shimmer.
    const tint = rand();
    const brightness = 0.3 + rand() * 0.26;
    colors[i3] = brightness * (tint > 0.8 ? 1 : 0.9);
    colors[i3 + 1] = brightness * 0.92;
    colors[i3 + 2] = brightness * (tint < 0.2 ? 1 : 0.88);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Screen-space sizing rather than `sizeAttenuation`: the sky sphere is parked
  // on the camera, so an attenuated point projects to a fixed *sub-pixel*
  // footprint that lands on a different sample each frame and shimmers under
  // bloom. A couple of screen pixels is stable under resampling and motion.
  const material = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    vertexColors: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
  });

  const points = new THREE.Points(geometry, material);
  // Never frustum-cull the sky, and always draw it behind everything.
  points.frustumCulled = false;
  points.renderOrder = -1;
  return points;
}

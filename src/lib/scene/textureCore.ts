// Pure pixel generation for body surfaces — no DOM, no Three.js, so the offline
// baker (`scripts/bake-textures.mjs`) can run these renderers under Node.
// `textures.ts` is the runtime side: it loads the baked bitmaps.
//
// The cratered types (rocky, moon, dwarf, asteroid) are NOT generated here:
// they are remixed from real public-domain mosaics by
// `scripts/remix-textures.mjs`, which shares this module's size/variant/color
// tables. This module still owns those tables for every type — the manifest and
// the runtime hue rotation key off them.
//
// Nothing uses Math.random(), Date, or ambient state, so a given (type, variant)
// always bakes byte-identical output.
//
// Every style has longitudinal structure, so that user-editable spin and tilt
// are actually visible on the sphere.
//
// All textures are equirectangular (2:1) and, except the satellite hull, are
// sampled per-pixel from a 3-D noise field on the sphere rather than stamped
// from 2-D primitives: stamped shapes smear toward the poles (horizontal scale
// runs to zero) and get cut by the u = 0/1 seam. A 3-D field is continuous
// across the seam and isotropic at the poles by construction.

export type BodyTextureType =
	| "star"
	| "earthlike"
	| "rocky"
	| "gas"
	| "ice"
	| "dwarf"
	| "moon"
	| "asteroid"
	| "satellite";

export const BODY_TEXTURE_TYPES: readonly BodyTextureType[] = [
	"star",
	"earthlike",
	"rocky",
	"gas",
	"ice",
	"dwarf",
	"moon",
	"asteroid",
	"satellite"
];

/**
 * Output width in pixels; height is half (equirectangular).
 *
 * Baked offline, so the budget is download size and VRAM, not generation time:
 * a 2048×1024 RGB texture is 6 MB in VRAM (8 MB with mipmaps), ~250–600 KB as
 * JPEG. Sized per type by how close the camera can get and how many exist.
 */
export const TEX_SIZES: Record<BodyTextureType, number> = {
	// Largest on screen, and granulation is high-frequency detail that mushes
	// badly when upscaled.
	star: 2048,
	// The types a user is most likely to fly up to and inspect.
	earthlike: 2048,
	rocky: 2048,
	moon: 2048,
	// Little high-frequency content, so soft bands survive a smaller map.
	gas: 1536,
	ice: 1024,
	dwarf: 1536,
	// Dozens at once in belt presets, never the subject; 512 leaves headroom for
	// the one a user does zoom to.
	asteroid: 512,
	// Surface material on a modeled hull, never seen as a full sphere.
	satellite: 1024
};

/**
 * Supersampling factor per type: the field is evaluated at N× linear resolution
 * and box-filtered down. (3× is 9× the samples.)
 *
 * Point-sampling one texel apart aliases badly wherever the field has detail at
 * the texel scale — stair-stepped crater rims, shimmering rays, jagged
 * coastlines. Averaging also turns sub-texel detail into correct shading, so the
 * high octave counts below only pay off in combination with this.
 */
// Only the procedurally generated types; the remixed ones resample real
// mosaics and never evaluate a field.
const SUPERSAMPLE: Partial<Record<BodyTextureType, number>> = {
	star: 2,
	earthlike: 3,
	gas: 2,
	ice: 2,
	// Hard-edged 2-D geometry; supersampling is what antialiases the panel seams
	// and radiator grids.
	satellite: 3
};

/**
 * How many distinct surfaces exist per type. Baked, so variants cost only bake
 * time and download size. ~6 is enough that a field of bodies never reads as a
 * repeated stamp, given they also differ in color, size, spin, and orientation.
 */
export const VARIANTS_BY_TYPE: Record<BodyTextureType, number> = {
	star: 4,
	earthlike: 6,
	rocky: 6,
	gas: 6,
	ice: 4,
	dwarf: 6,
	moon: 6,
	asteroid: 8,
	satellite: 4
};

/**
 * The hue each type is baked at, in [0, 1).
 *
 * Maps are full-color; the body color is applied as a shader hue *rotation* by
 * (bodyHue − referenceHue), which preserves hue differences within the map (land
 * vs. ocean) where a tint multiply would flatten them to one hue.
 *
 * Must stay in sync with `REFERENCE_COLOR`'s hues or every body renders
 * hue-shifted from its own swatch; `assertReferenceHues` checks this at bake.
 */
export const REFERENCE_HUE: Record<BodyTextureType, number> = {
	star: 0.1072,
	earthlike: 0.5805,
	rocky: 0.0595,
	gas: 0.0833,
	ice: 0.5595,
	dwarf: 0.087,
	moon: 0.1111,
	asteroid: 0.0938,
	satellite: 0.6111
};

/**
 * The color each type is baked at — the canonical look for the type, since one
 * bake serves every body of it. Hues must match `REFERENCE_HUE`.
 */
export const REFERENCE_COLOR: Record<BodyTextureType, RGB> = {
	star: { r: 255, g: 214, b: 140 },
	earthlike: { r: 62, g: 122, b: 178 },
	rocky: { r: 176, g: 122, b: 92 },
	gas: { r: 216, g: 168, b: 120 },
	ice: { r: 132, g: 186, b: 216 },
	dwarf: { r: 168, g: 146, b: 122 },
	moon: { r: 158, g: 152, b: 140 },
	asteroid: { r: 128, g: 114, b: 96 },
	satellite: { r: 150, g: 160, b: 180 }
};

// --- deterministic randomness ---------------------------------------------

/**
 * Seeded per (type, variant) so surfaces are stable across bakes — otherwise
 * every rebuild diffs every bitmap.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Hash a string to a 32-bit seed (FNV-1a). */
export function hashSeed(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// --- 3-D noise ------------------------------------------------------------
//
// Sampled in 3-D on the unit sphere so the field is seamless across the
// texture's u wrap and undistorted at the poles.

/** Deterministic hash of an integer lattice point to [0, 1). */
function hash3(ix: number, iy: number, iz: number, seed: number): number {
	let h = seed ^ Math.imul(ix | 0, 0x27d4eb2d);
	h = Math.imul(h ^ (iy | 0), 0x165667b1);
	h = Math.imul(h ^ (iz | 0), 0x9e3779b1);
	h ^= h >>> 15;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	return (h >>> 0) / 4294967296;
}

/**
 * Quintic interpolant, 6t⁵ − 15t⁴ + 10t³. C2, unlike a cubic smoothstep: a
 * cubic's second derivative jumps at every lattice boundary, which the
 * finite-differenced relief shading turns into a visible rectilinear grid.
 */
function fade(t: number): number {
	return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Trilinearly interpolated value noise at a point, in [0, 1). */
function valueNoise(x: number, y: number, z: number, seed: number): number {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const iz = Math.floor(z);
	const fx = fade(x - ix);
	const fy = fade(y - iy);
	const fz = fade(z - iz);

	const c000 = hash3(ix, iy, iz, seed);
	const c100 = hash3(ix + 1, iy, iz, seed);
	const c010 = hash3(ix, iy + 1, iz, seed);
	const c110 = hash3(ix + 1, iy + 1, iz, seed);
	const c001 = hash3(ix, iy, iz + 1, seed);
	const c101 = hash3(ix + 1, iy, iz + 1, seed);
	const c011 = hash3(ix, iy + 1, iz + 1, seed);
	const c111 = hash3(ix + 1, iy + 1, iz + 1, seed);

	const x00 = c000 + (c100 - c000) * fx;
	const x10 = c010 + (c110 - c010) * fx;
	const x01 = c001 + (c101 - c001) * fx;
	const x11 = c011 + (c111 - c011) * fx;
	const y0 = x00 + (x10 - x00) * fy;
	const y1 = x01 + (x11 - x01) * fy;
	return y0 + (y1 - y0) * fz;
}

/**
 * Gradient (Perlin-style) noise at a point, in roughly [0, 1).
 *
 * Value noise puts its extrema on lattice points, so sums of it show a faint
 * cubic grid. Gradient noise puts zeroes there instead and reads as isotropic,
 * which matters for the low octaves that carry the large-scale shapes.
 */
function gradNoise(x: number, y: number, z: number, seed: number): number {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const iz = Math.floor(z);
	const fx = x - ix;
	const fy = y - iy;
	const fz = z - iz;
	const ux = fade(fx);
	const uy = fade(fy);
	const uz = fade(fz);

	// Gradient from the lattice hash: the standard Perlin set of 12 edge-midpoint
	// directions, picked by hash so no permutation table is needed. Each case is a
	// dot product with a ±1/±1/0 permutation.
	const grad = (hx: number, hy: number, hz: number, dx: number, dy: number, dz: number): number => {
		const h = Math.floor(hash3(hx, hy, hz, seed) * 16) & 15;
		switch (h) {
			case 0:
				return dx + dy;
			case 1:
				return -dx + dy;
			case 2:
				return dx - dy;
			case 3:
				return -dx - dy;
			case 4:
				return dx + dz;
			case 5:
				return -dx + dz;
			case 6:
				return dx - dz;
			case 7:
				return -dx - dz;
			case 8:
				return dy + dz;
			case 9:
				return -dy + dz;
			case 10:
				return dy - dz;
			case 11:
				return -dy - dz;
			case 12:
				return dx + dy;
			case 13:
				return -dy + dz;
			case 14:
				return -dx + dy;
			default:
				return -dy - dz;
		}
	};

	const n000 = grad(ix, iy, iz, fx, fy, fz);
	const n100 = grad(ix + 1, iy, iz, fx - 1, fy, fz);
	const n010 = grad(ix, iy + 1, iz, fx, fy - 1, fz);
	const n110 = grad(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz);
	const n001 = grad(ix, iy, iz + 1, fx, fy, fz - 1);
	const n101 = grad(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1);
	const n011 = grad(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1);
	const n111 = grad(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1);

	const x00 = n000 + (n100 - n000) * ux;
	const x10 = n010 + (n110 - n010) * ux;
	const x01 = n001 + (n101 - n001) * ux;
	const x11 = n011 + (n111 - n011) * ux;
	const y0 = x00 + (x10 - x00) * uy;
	const y1 = x01 + (x11 - x01) * uy;
	// Perlin output is about [-0.7, 0.7]; map to [0, 1] so it is interchangeable
	// with valueNoise inside an fBm sum.
	return (y0 + (y1 - y0) * uz) * 0.7 + 0.5;
}

/**
 * Fractal Brownian motion: `octaves` doublings of frequency, halving in gain.
 *
 * The first two octaves use gradient noise (isotropy matters at the scales that
 * carry shape); the rest use value noise, cheaper and indistinguishable this
 * fine.
 */
export function fbm(
	x: number,
	y: number,
	z: number,
	seed: number,
	octaves: number,
	lacunarity = 2.07,
	gain = 0.5
): number {
	let sum = 0;
	let amplitude = 1;
	let total = 0;
	let freq = 1;
	for (let i = 0; i < octaves; i++) {
		const n =
			i < 2
				? gradNoise(x * freq, y * freq, z * freq, seed + i * 1013)
				: valueNoise(x * freq, y * freq, z * freq, seed + i * 1013);
		sum += n * amplitude;
		total += amplitude;
		amplitude *= gain;
		freq *= lacunarity;
	}
	return sum / total;
}

/**
 * Ridged fBm: folds each octave around its midpoint so the field has creases
 * rather than blobs — mountain chains and gas-band filaments.
 *
 * Each octave is weighted by the previous (standard ridged-multifractal), which
 * concentrates detail along the ridges and keeps the flats smooth; unweighted it
 * reads as uniform crinkle.
 */
export function ridged(x: number, y: number, z: number, seed: number, octaves: number): number {
	let sum = 0;
	let amplitude = 1;
	let total = 0;
	let freq = 1;
	let weight = 1;
	for (let i = 0; i < octaves; i++) {
		const raw =
			i === 0
				? gradNoise(x * freq, y * freq, z * freq, seed + i * 2749)
				: valueNoise(x * freq, y * freq, z * freq, seed + i * 2749);
		let n = 1 - Math.abs(raw * 2 - 1);
		n *= n;
		n *= weight;
		// Feed this octave's amplitude forward, clamped so it can't run away.
		weight = clamp01(n * 2);
		sum += n * amplitude;
		total += amplitude;
		amplitude *= 0.5;
		freq *= 2.13;
	}
	return sum / total;
}

/**
 * Domain-warped fBm: the field is sampled at a position displaced by another
 * noise field.
 *
 * Plain fBm is statistically uniform, so every region looks alike. Warping folds
 * the field non-uniformly, producing the swirls and drawn-out peninsulas real
 * coastlines and cloud systems have. Costs two extra field evaluations.
 */
export function warpedFbm(x: number, y: number, z: number, seed: number, octaves: number, warpAmount: number): number {
	const wx = fbm(x + 11.3, y + 2.7, z + 5.1, seed + 7717, 3) - 0.5;
	const wy = fbm(x + 3.9, y + 19.2, z + 8.4, seed + 3313, 3) - 0.5;
	const wz = fbm(x + 7.1, y + 6.5, z + 13.8, seed + 9931, 3) - 0.5;
	return fbm(x + wx * warpAmount, y + wy * warpAmount, z + wz * warpAmount, seed, octaves);
}

// --- color helpers --------------------------------------------------------

/** RGB triple in 0–255 sRGB, the working format throughout this module. */
export interface RGB {
	r: number;
	g: number;
	b: number;
}

/** Lighten (t > 0) or darken (t < 0) an RGB triple by fraction |t|. */
export function tone(c: RGB, t: number): RGB {
	if (t >= 0) {
		return {
			r: c.r + (255 - c.r) * t,
			g: c.g + (255 - c.g) * t,
			b: c.b + (255 - c.b) * t
		};
	}
	const k = 1 + t;
	return { r: c.r * k, g: c.g * k, b: c.b * k };
}

export function mix(a: RGB, b: RGB, t: number): RGB {
	return {
		r: a.r + (b.r - a.r) * t,
		g: a.g + (b.g - a.g) * t,
		b: a.b + (b.b - a.b) * t
	};
}

/** sRGB 0–255 → HSL, all components in [0, 1]. */
export function rgbToHsl(c: RGB): { h: number; s: number; l: number } {
	const r = c.r / 255;
	const g = c.g / 255;
	const b = c.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
	else if (max === g) h = ((b - r) / d + 2) / 6;
	else h = ((r - g) / d + 4) / 6;
	return { h, s, l };
}

/** HSL (all in [0, 1]) → sRGB 0–255. */
export function hslToRgb(h: number, s: number, l: number): RGB {
	if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const channel = (t: number): number => {
		let v = t;
		if (v < 0) v += 1;
		if (v > 1) v -= 1;
		if (v < 1 / 6) return p + (q - p) * 6 * v;
		if (v < 1 / 2) return q;
		if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
		return p;
	};
	return {
		r: channel(h + 1 / 3) * 255,
		g: channel(h) * 255,
		b: channel(h - 1 / 3) * 255
	};
}

/** Shift an RGB triple's hue/saturation/lightness, staying in gamut. */
export function adjustHsl(c: RGB, dHue: number, satScale: number, lightScale: number): RGB {
	const hsl = rgbToHsl(c);
	return hslToRgb((hsl.h + dHue + 1) % 1, clamp01(hsl.s * satScale), clamp01(hsl.l * lightScale));
}

export function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
	if (edge0 === edge1) return x < edge0 ? 0 : 1;
	const t = clamp01((x - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

/** `#rrggbb` → RGB 0–255. */
export function hexToRgb(hex: string): RGB {
	const h = hex.replace("#", "");
	const n = parseInt(
		h.length === 3
			? h
					.split("")
					.map((c) => c + c)
					.join("")
			: h,
		16
	);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// --- pixel buffers --------------------------------------------------------

/**
 * A plain RGB byte buffer — not ImageData or a canvas, so the same code runs
 * under Node and in the browser.
 */
export interface Pixels {
	width: number;
	height: number;
	/** length = width × height × 3 */
	data: Uint8ClampedArray;
}

export function createPixels(width: number, height: number): Pixels {
	return { width, height, data: new Uint8ClampedArray(width * height * 3) };
}

/**
 * Box-filter `src` down by an integer factor.
 *
 * Averages in sRGB, not linear light, deliberately: these are albedo maps lit by
 * the renderer afterwards, and a linear average brightens every dark feature
 * (crater floors, band boundaries, hull-plate gaps) away from the tuned look.
 */
export function downsample(src: Pixels, factor: number): Pixels {
	if (factor === 1) return src;
	const width = src.width / factor;
	const height = src.height / factor;
	const out = createPixels(width, height);
	const n = factor * factor;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (let sy = 0; sy < factor; sy++) {
				const rowBase = ((y * factor + sy) * src.width + x * factor) * 3;
				for (let sx = 0; sx < factor; sx++) {
					const i = rowBase + sx * 3;
					r += src.data[i];
					g += src.data[i + 1];
					b += src.data[i + 2];
				}
			}
			const o = (y * width + x) * 3;
			out.data[o] = r / n;
			out.data[o + 1] = g / n;
			out.data[o + 2] = b / n;
		}
	}
	return out;
}

/**
 * Run `sample` over every texel with the unit-sphere direction it maps to under
 * three.js's SphereGeometry UV convention, plus latitude in [-1, 1] for
 * pole-aware effects (ice caps, bands).
 */
function renderField(
	px: Pixels,
	sample: (x: number, y: number, z: number, lat: number, u: number, v: number) => RGB
): void {
	const { width, height, data } = px;

	for (let py = 0; py < height; py++) {
		const v = (py + 0.5) / height;
		// Polar angle from the +Y pole, matching SphereGeometry's UV mapping.
		const theta = v * Math.PI;
		const sinTheta = Math.sin(theta);
		const y = Math.cos(theta);

		for (let pxi = 0; pxi < width; pxi++) {
			const u = (pxi + 0.5) / width;
			const phi = u * Math.PI * 2;
			const x = Math.cos(phi) * sinTheta;
			const z = Math.sin(phi) * sinTheta;

			const c = sample(x, y, z, y, u, v);
			const i = (py * width + pxi) * 3;
			data[i] = c.r;
			data[i + 1] = c.g;
			data[i + 2] = c.b;
		}
	}
}

/**
 * Two-pass relief renderer: pass 1 fills a height buffer, pass 2 shades each
 * texel from its neighbours, so slope is a finite difference on the buffer.
 * Differencing the field directly would cost two extra full evaluations per
 * texel — fBm octaves plus a walk over every nearby crater.
 *
 * The shading is a *normalized* surface normal dotted with the light. An
 * unnormalized slope sum grows without bound, clipping big crater rims and
 * mountain faces to solid white or black; normalized it saturates like a real
 * lit surface. The `1/cos(lat)` correction below keeps polar features from
 * shading as vertical cliffs.
 */
/**
 * Global gain on the relief gradient. `reliefStrength` scales by sqrt(width/512)
 * because the finite difference is between adjacent *texels* and shrinks as
 * resolution rises — but must NOT compensate fully: the normalized normal
 * saturates past a gradient of ~1, flattening everything into uniform crinkle.
 * The 512 reference keeps a given `relief` looking the same across `TEX_SIZES`.
 *
 * 14 calibrated by eye against the earthlike bakes — the only remaining user of
 * this renderer (below ~8 the shading span collapses and relief reads as flat
 * grey).
 */
const RELIEF_SCALE = 14;

function reliefStrength(relief: number, width: number): number {
	return relief * RELIEF_SCALE * Math.sqrt(width / 512);
}

function renderRelief(
	px: Pixels,
	height: (x: number, y: number, z: number, lat: number) => number,
	shade: (x: number, y: number, z: number, lat: number, h: number, shading: number) => RGB,
	strength: number
): void {
	const { width, height: rows, data } = px;

	const heights = new Float32Array(width * rows);
	const dirX = new Float32Array(width);
	const dirZ = new Float32Array(width);
	for (let pxi = 0; pxi < width; pxi++) {
		const phi = ((pxi + 0.5) / width) * Math.PI * 2;
		dirX[pxi] = Math.cos(phi);
		dirZ[pxi] = Math.sin(phi);
	}

	const ys = new Float32Array(rows);
	const sinThetas = new Float32Array(rows);
	for (let py = 0; py < rows; py++) {
		const theta = ((py + 0.5) / rows) * Math.PI;
		ys[py] = Math.cos(theta);
		sinThetas[py] = Math.sin(theta);
	}

	for (let py = 0; py < rows; py++) {
		const y = ys[py];
		const sinTheta = sinThetas[py];
		const rowBase = py * width;
		for (let pxi = 0; pxi < width; pxi++) {
			heights[rowBase + pxi] = height(dirX[pxi] * sinTheta, y, dirZ[pxi] * sinTheta, y);
		}
	}

	// Light from the upper left in texture space, normalized.
	const llen0 = Math.hypot(-0.55, -0.45, 0.7);
	const lx = -0.55 / llen0;
	const ly = -0.45 / llen0;
	const lz = 0.7 / llen0;

	// The response of perfectly flat ground (normal = (0, 0, 1)). Shading must be
	// centerd on this, not 0.5: flat ground reads `lz` (0.70 here), so a `d*2-1`
	// mapping biases every texel positive and compresses the relief into a fifth
	// of the output span.
	const flat = lz;

	for (let py = 0; py < rows; py++) {
		const y = ys[py];
		const sinTheta = sinThetas[py];
		const rowBase = py * width;
		// Clamp at the poles, wrap at the seam — the texture's own topology, so the
		// shading has no discontinuity at u = 0.
		const upBase = (py > 0 ? py - 1 : py) * width;
		const downBase = (py < rows - 1 ? py + 1 : py) * width;

		// Texels compress toward the poles, so dividing the longitudinal difference
		// by sin(theta) converts it back to a per-arc-length gradient. The floor is
		// generous (0.35, ~20° from the pole) because sin(theta) → 0 makes the ratio
		// explode into a hard bright ring of amplified noise; clamping early costs
		// nothing, since polar texels cover almost no solid angle on the sphere.
		const lonScale = 1 / Math.max(0.35, sinTheta);

		for (let pxi = 0; pxi < width; pxi++) {
			const h = heights[rowBase + pxi];
			const left = heights[rowBase + (pxi > 0 ? pxi - 1 : width - 1)];
			const right = heights[rowBase + (pxi < width - 1 ? pxi + 1 : 0)];
			const up = heights[upBase + pxi];
			const down = heights[downBase + pxi];

			// Central differences → tangent-space normal (−dx, −dy, 1), normalized.
			const dx = (right - left) * 0.5 * strength * lonScale;
			const dy = (down - up) * 0.5 * strength;
			const nlen = Math.sqrt(dx * dx + dy * dy + 1);
			const dot = (-dx * lx - dy * ly + lz) / nlen;
			// Deviation from flat over the lit side's span, both directions, clamped.
			// Per-side divisors — (1 − flat) up, (1 + flat) down — were tried and made
			// every crater read as a translucent bright disk: equal slopes tilt the
			// dot by equal amounts, so normalizing the down side by its full range to
			// −1 scaled shadows ~6× weaker than highlights. Symmetric scaling means a
			// slope tipped ~35° past flat saturates to full shadow, which is what an
			// unlit crater wall should do.
			const shading = Math.max(-1, (dot - flat) / (1 - flat));

			const c = shade(dirX[pxi] * sinTheta, y, dirZ[pxi] * sinTheta, y, h, shading);
			const i = (rowBase + pxi) * 3;
			data[i] = c.r;
			data[i + 1] = c.g;
			data[i + 2] = c.b;
		}
	}
}

// --- per-type renderers ---------------------------------------------------

/**
 * Latitudinal bands with turbulent, sheared edges — gas and ice giants.
 *
 * The band profile is a function of latitude alone, but that latitude is
 * displaced by a noise field stretched ~8:1 zonally. The stretching is the whole
 * trick: isotropic noise would read as mottling instead of atmospheric swirls.
 */
function drawBands(
	color: RGB,
	seed: number,
	rand: () => number,
	options: { bands: number; contrast: number; turbulence: number; storms: number }
): (x: number, y: number, z: number, lat: number) => RGB {
	const base = color;

	// Belts darker and warmer, zones lighter and cooler. The darkening is modest
	// on purpose: `tone` and `adjustHsl`'s lightScale both multiply brightness, so
	// stacking strong values drives belts to near-black — they should be tan
	// against cream, not black against brown.
	const belt = adjustHsl(tone(base, -0.12), -0.015, 1.0, 1);
	const zone = adjustHsl(tone(base, 0.4), 0.01, 0.8, 1);
	const polar = adjustHsl(tone(base, 0.04), -0.01, 0.85, 1);

	// Irregular band layout. A sine of latitude makes every belt and zone the same
	// width and the eye picks up the regularity immediately, so instead walk pole
	// to pole assigning random widths (equatorial zone deliberately widened) and
	// give every band and boundary its own character.
	const halfBands = options.bands * 2 + 1;
	const widths: number[] = [];
	for (let i = 0; i < halfBands; i++) {
		const centrality = Math.exp(-(((i - options.bands) / (halfBands / 5)) ** 2));
		widths.push((0.55 + rand() * 1.1) * (1 + centrality * 0.9));
	}
	// Latitude runs [-1, 1]; overshoot the poles slightly so the outermost bands
	// don't pinch to zero width at the map edge.
	const widthTotal = widths.reduce((a, b) => a + b, 0);
	const edges: number[] = [-1.06];
	for (const w of widths) edges.push(edges[edges.length - 1] + (w / widthTotal) * 2.12);

	// 1 = zone (bright), 0 = belt (dark), alternating outward from a zone at the
	// equator. Clamped so lookups just past the poles reuse the polar band.
	const parity = (k: number): number => {
		const j = Math.min(halfBands - 1, Math.max(0, k));
		return Math.abs(j - options.bands) % 2 === 0 ? 1 : 0;
	};

	// Per-band tone offsets and per-edge transition widths, so belts differ and
	// some boundaries are knife-sharp. Edge widths are capped by the adjacent
	// bands so a soft boundary can't swallow a narrow band whole.
	const bandTone: number[] = [];
	for (let i = 0; i < halfBands; i++) bandTone.push((rand() - 0.5) * 0.5 * options.contrast);
	const edgeWidth: number[] = [];
	for (let i = 0; i <= halfBands; i++) {
		const near = Math.min(widths[Math.max(0, i - 1)] ?? Infinity, widths[Math.min(halfBands - 1, i)] ?? Infinity);
		const nearNorm = (near / widthTotal) * 2.12;
		edgeWidth.push(Math.min(0.035 + rand() * 0.075, nearNorm * 0.35));
	}

	// Storm ovals: bright anticyclones or dark barges, elongated zonally.
	const storms: {
		lat: number;
		lon: number;
		rx: number;
		ry: number;
		light: number;
		spin: number;
	}[] = [];
	for (let i = 0; i < options.storms; i++) {
		const rx = 0.05 + rand() * 0.1;
		storms.push({
			// Off the poles, where the map's distortion would smear them.
			lat: (rand() * 2 - 1) * 0.72,
			lon: rand() * Math.PI * 2,
			rx,
			ry: rx * (0.3 + rand() * 0.25),
			light: rand() > 0.45 ? 0.4 + rand() * 0.35 : -(0.3 + rand() * 0.3),
			spin: rand() > 0.5 ? 1 : -1
		});
	}

	return (x, y, z, lat) => {
		// Zonally stretched turbulence: x and z scaled ~8× smaller than y makes the
		// field ~8× longer in longitude. Domain-warped, which gives band edges curl
		// and folded filaments instead of a simple wobble.
		const warp =
			(warpedFbm(x * 0.7, y * 5.5, z * 0.7, seed, 5, 0.4) - 0.5) * options.turbulence +
			(fbm(x * 2.2, y * 17, z * 2.2, seed + 77, 4) - 0.5) * options.turbulence * 0.5 +
			(fbm(x * 5.5, y * 42, z * 5.5, seed + 151, 3) - 0.5) * options.turbulence * 0.22;

		const bandLat = lat + warp;

		// Locate the band; ~a dozen entries, so a scan beats anything cleverer.
		let j = 0;
		while (j < halfBands - 1 && bandLat > edges[j + 1]) j++;

		// Belt/zone value and per-band tone, blended across the boundary with a tanh
		// ramp over this edge's own width. Both blend together so the tone offset
		// can't draw a hard line where the belt/zone mix is smooth.
		const dLo = bandLat - edges[j];
		const dHi = edges[j + 1] - bandLat;
		let v = parity(j);
		let toneOff = bandTone[j];
		if (dLo < edgeWidth[j]) {
			const b = 0.5 + 0.5 * Math.tanh((dLo / edgeWidth[j]) * 2.6);
			v = v * b + parity(j - 1) * (1 - b);
			toneOff = toneOff * b + bandTone[Math.max(0, j - 1)] * (1 - b);
		} else if (dHi < edgeWidth[j + 1]) {
			const b = 0.5 + 0.5 * Math.tanh((dHi / edgeWidth[j + 1]) * 2.6);
			v = v * b + parity(j + 1) * (1 - b);
			toneOff = toneOff * b + bandTone[Math.min(halfBands - 1, j + 1)] * (1 - b);
		}
		let c = mix(belt, zone, clamp01(v));
		c = tone(c, toneOff);

		// Fine zonal streaking for the filamentary detail along band boundaries.
		const streak = fbm(x * 3, y * 34, z * 3, seed + 411, 5) - 0.5;
		c = tone(c, streak * options.contrast * 0.4);

		// Shear billows at the belt/zone interfaces, keyed off proximity to the
		// nearest band edge (within twice its transition width).
		const atEdge = Math.max(1 - Math.min(1, dLo / (edgeWidth[j] * 2)), 1 - Math.min(1, dHi / (edgeWidth[j + 1] * 2)));
		if (atEdge > 0) {
			const billow = warpedFbm(x * 6, y * 30, z * 6, seed + 617, 4, 0.8) - 0.5;
			c = tone(c, billow * options.contrast * 0.55 * atEdge);
		}

		// Polar hoods.
		const polarMix = smoothstep(0.62, 0.95, Math.abs(lat));
		c = mix(c, polar, polarMix * 0.75);

		for (const storm of storms) {
			// Longitude wrapped to the storm's nearest image, so an oval straddling
			// the seam stays whole.
			const lon = Math.atan2(z, x);
			let dLon = lon - storm.lon;
			while (dLon > Math.PI) dLon -= Math.PI * 2;
			while (dLon < -Math.PI) dLon += Math.PI * 2;

			// Scale longitude by the cosine of latitude so the oval keeps its shape.
			const cosLat = Math.max(0.2, Math.sqrt(Math.max(0, 1 - lat * lat)));
			const dx = (dLon * cosLat) / storm.rx;
			const dy = (lat + warp * 0.3 - storm.lat) / storm.ry;
			const d = Math.hypot(dx, dy);
			if (d < 1.6) {
				const f = smoothstep(1.6, 0.55, d);
				// Vortex: swirl the sampled noise around the storm center so it reads as
				// rotating rather than as a flat blob.
				const ang = Math.atan2(dy, dx) + storm.spin * (1.6 - d) * 1.7;
				const swirl =
					fbm(Math.cos(ang) * d * 3 + storm.lon * 5, Math.sin(ang) * d * 3, storm.lat * 7, seed + 2029, 4) - 0.5;
				c = tone(c, storm.light * f);
				c = tone(c, swirl * 0.3 * f);
				// A darker collar around a bright storm.
				if (storm.light > 0 && d > 0.8) c = tone(c, -0.12 * smoothstep(0.8, 1.3, d));
			}
		}

		return c;
	};
}

/**
 * An Earth-like world: oceans, coastlines, climate-banded vegetation and desert,
 * mountains, ice caps, rivers, and cloud. Continents come out of the noise
 * field, so each body is plausible but deliberately not Earth's own geography.
 */
function drawEarthlike(px: Pixels, color: RGB, seed: number, rand: () => number): void {
	const base = color;

	// Ocean: the body color deepened, with a lighter shelf tone. Kept well clear
	// of black — a near-black ocean reads as a hole in the planet once the
	// terminator shading lands on top.
	const deepSea = adjustHsl(tone(base, -0.2), 0, 1.05, 0.95);
	const shallowSea = adjustHsl(tone(base, 0.3), 0.01, 1.05, 1.2);

	// Land palette: fixed terrain hues nudged toward the body color, not derived
	// from it by hue rotation — rotating off an ocean-blue base lands in red and
	// olive, which made the continents read as lava fields.
	const tint = (target: RGB, amount: number): RGB => mix(target, base, amount);
	const tropical = tint({ r: 58, g: 104, b: 42 }, 0.08);
	const vegetation = tint({ r: 82, g: 122, b: 56 }, 0.1);
	const steppe = tint({ r: 146, g: 148, b: 92 }, 0.08);
	const drySoil = tint({ r: 190, g: 158, b: 96 }, 0.08);
	const rock = tint({ r: 130, g: 120, b: 108 }, 0.08);
	const tundra = tint({ r: 138, g: 134, b: 118 }, 0.06);
	const ice = { r: 246, g: 250, b: 255 };

	// Sea level as a quantile of the height field, setting the land fraction.
	// Tuned against the *whole* field: the ridged mountain term is strictly
	// positive and adds ~0.12 on average, so the distribution sits well above the
	// 0.5 an fBm sum alone centers on. Lands around a quarter to a third land.
	const seaLevel = 0.62 + (rand() - 0.5) * 0.05;
	// Climate band placement; varying these makes each world distinct.
	const iceLine = 0.74 + rand() * 0.14;
	const desertLat = 0.24 + rand() * 0.12;
	const scale = 1.9;

	const landHeight = (x: number, y: number, z: number): number => {
		// Two-scale continents: a low-frequency mask places landmasses, a higher one
		// gives irregular coasts. Domain warping is what produces peninsulas, bays,
		// and island arcs instead of plain fBm's potato blobs.
		const continents = warpedFbm(x * scale, y * scale, z * scale, seed, 7, 0.6);
		const coast = (fbm(x * scale * 4.5, y * scale * 4.5, z * scale * 4.5, seed + 17, 5) - 0.5) * 0.22;
		// Fjord/inlet scale: only resolves at these texture sizes, and much of why a
		// coastline reads as real.
		const inlets = (fbm(x * scale * 14, y * scale * 14, z * scale * 14, seed + 29, 4) - 0.5) * 0.055;
		const mountains = ridged(x * scale * 3.1, y * scale * 3.1, z * scale * 3.1, seed + 401, 6) * 0.24;
		return continents + coast + inlets + mountains * 0.5;
	};

	const shade = (x: number, y: number, z: number, lat: number, h: number, shading: number): RGB => {
		const absLat = Math.abs(lat);

		let c: RGB;

		if (h < seaLevel) {
			// Ocean, shading from shelf to abyss with depth.
			const depth = smoothstep(seaLevel, seaLevel - 0.16, h);
			c = mix(shallowSea, deepSea, depth);
			// Faint abyssal ridges, so a large ocean isn't one flat color.
			const floor = fbm(x * 9, y * 9, z * 9, seed + 3301, 4) - 0.5;
			c = tone(c, floor * 0.05 * depth);
		} else {
			const elevation = clamp01((h - seaLevel) / 0.3);

			// Climate zonation by latitude — wet equator, dry subtropics, temperate,
			// polar — with a noise perturbation so the boundaries aren't stripes.
			const climateNoise = (fbm(x * 2.7, y * 2.7, z * 2.7, seed + 823, 5) - 0.5) * 0.22;
			const climLat = absLat + climateNoise;
			const aridity =
				smoothstep(0.06, desertLat, climLat) * (1 - smoothstep(desertLat + 0.16, desertLat + 0.42, climLat));

			// Rain shadow, approximated by drying terrain that sits above its
			// neighbourhood average.
			const relief = fbm(x * 7, y * 7, z * 7, seed + 5501, 4) - 0.5;
			const shadow = clamp01(relief * 1.2 + elevation * 0.5);

			// Equatorial rainforest → temperate forest → steppe → desert.
			c = mix(tropical, vegetation, smoothstep(0.0, 0.3, climLat));
			c = mix(c, steppe, clamp01(aridity * 0.9 + shadow * 0.3));
			c = mix(c, drySoil, clamp01(aridity * aridity * 1.2 + shadow * 0.2));
			c = mix(c, tundra, smoothstep(iceLine - 0.28, iceLine - 0.04, absLat));

			// Bare rock above the tree line, snow higher still; the snow line drops
			// toward the poles.
			c = mix(c, rock, smoothstep(0.42, 0.72, elevation));
			const snowLine = 0.8 - absLat * 0.45;
			c = mix(c, ice, smoothstep(snowLine, snowLine + 0.16, elevation));

			// A narrow beach at the waterline.
			c = mix(c, tone(drySoil, 0.28), smoothstep(0.05, 0.0, elevation) * 0.6);

			// Rivers: the ridged field's creases, restricted to where water would
			// collect (below the snow line, above the beach).
			const river = ridged(x * scale * 6.5, y * scale * 6.5, z * scale * 6.5, seed + 7013, 5);
			const riverMask =
				smoothstep(0.72, 0.93, river) *
				smoothstep(0.02, 0.12, elevation) *
				(1 - smoothstep(0.5, 0.75, elevation)) *
				(1 - clamp01(aridity * 1.3));
			if (riverMask > 0) c = mix(c, shallowSea, riverMask * 0.55);

			// Texture on the land so large regions aren't flat color.
			const detail = fbm(x * 26, y * 26, z * 26, seed + 6607, 4) - 0.5;
			c = tone(c, detail * 0.16);
			const grain = valueNoise(x * 110, y * 110, z * 110, seed + 8419) - 0.5;
			c = tone(c, grain * 0.05);

			// Relief shading, land only — the ocean stays smooth. The earthlike height
			// field is dominated by low-frequency continents, so its per-texel
			// gradients are small and need extra gain to make ridges visible.
			c = tone(c, shading * 0.55);
		}

		// Polar caps, with a ragged noise edge so the cap isn't a drawn circle.
		const capNoise = (fbm(x * 5.5, y * 5.5, z * 5.5, seed + 1201, 5) - 0.5) * 0.14;
		const cap = smoothstep(iceLine - 0.07, iceLine + 0.09, absLat + capNoise);
		if (cap > 0) c = mix(c, ice, cap * (h < seaLevel ? 0.92 : 1));

		// Cloud deck: banded by latitude (cloudy at the equator and mid-latitude
		// storm tracks, clear over deserts), zonally stretched so systems look
		// sheared, and domain-warped so they spiral instead of drifting as blobs.
		const cloudField = warpedFbm(x * 3.4, y * 8.5, z * 3.4, seed + 9001, 6, 0.5);
		const cloudBand =
			0.55 + 0.45 * Math.cos(absLat * Math.PI * 3.1) * (1 - smoothstep(0.1, 0.42, Math.abs(absLat - desertLat)));
		const cloud = smoothstep(0.52, 0.72, cloudField * cloudBand + 0.12);
		if (cloud > 0) {
			// A finer field erodes the cloud boundary so it fringes instead of ending
			// on a clean contour.
			const wisp = fbm(x * 22, y * 40, z * 22, seed + 9311, 4);
			const density = clamp01(cloud * (0.55 + 0.65 * wisp));
			c = mix(c, { r: 252, g: 253, b: 255 }, density * 0.82);
		}

		return c;
	};

	renderRelief(px, landHeight, shade, reliefStrength(0.85, px.width));
}

/**
 * Emissive granulation for stars — convection cells, limb darkening, spots and
 * faculae.
 */
function drawStar(color: RGB, seed: number, rand: () => number): (x: number, y: number, z: number, lat: number) => RGB {
	const base = color;
	const hot = adjustHsl(tone(base, 0.55), 0.01, 0.75, 1.15);
	const cool = adjustHsl(tone(base, -0.22), -0.03, 1.2, 0.9);

	// Starspot centers, in the mid-latitude belts where they occur.
	const spots: { cx: number; cy: number; cz: number; r: number }[] = [];
	const spotCount = 3 + Math.floor(rand() * 5);
	for (let i = 0; i < spotCount; i++) {
		const cy = (rand() * 2 - 1) * 0.55;
		const phi = rand() * Math.PI * 2;
		const r = Math.sqrt(Math.max(0, 1 - cy * cy));
		spots.push({
			cx: Math.cos(phi) * r,
			cy,
			cz: Math.sin(phi) * r,
			r: 0.05 + rand() * 0.1
		});
	}

	return (x, y, z) => {
		// Granulation at three scales: convection cells, the supergranulation
		// network under them, and a fine scale that only resolves at 2048.
		const gran = ridged(x * 26, y * 26, z * 26, seed, 4);
		const superGran = fbm(x * 7, y * 7, z * 7, seed + 55, 4);
		const fineGran = ridged(x * 68, y * 68, z * 68, seed + 121, 3);

		let c = mix(cool, hot, clamp01(gran * 0.75 + superGran * 0.45));
		c = tone(c, (fineGran - 0.5) * 0.16);

		// Faculae: bright networks in the lanes between cells.
		c = tone(c, clamp01(gran - 0.62) * 0.9);

		// Starspots: dark umbra, warmer penumbral ring with filamentary structure
		// rather than a flat annulus.
		for (const spot of spots) {
			const d = Math.hypot(x - spot.cx, y - spot.cy, z - spot.cz);
			if (d < spot.r * 2.2) {
				const umbra = smoothstep(spot.r, spot.r * 0.45, d);
				const penumbra = smoothstep(spot.r * 2.2, spot.r, d);
				const filament = ridged(x * 90, y * 90, z * 90, seed + 313, 3) - 0.5;
				c = tone(c, -0.5 * umbra - 0.22 * (penumbra - umbra));
				c = tone(c, filament * 0.28 * (penumbra - umbra));
			}
		}

		return c;
	};
}

/**
 * Spacecraft hull plating for the satellite's body and dish: insulation, panel
 * seams (also the rotation cue), and gold-foil patches.
 *
 * Maps onto box and cylinder faces rather than a sphere, so unlike the other
 * renderers it draws from a 2-D plate layout, not a spherical field.
 */
function drawSatelliteHull(px: Pixels, color: RGB, rand: () => number, seed: number): void {
	const { width, height, data } = px;

	const dark = tone(color, -0.72);

	// Plate layout, in normalized coordinates so it is resolution-independent.
	interface Plate {
		x0: number;
		y0: number;
		x1: number;
		y1: number;
		shade: number;
		mli: boolean;
		mliPhase: number;
	}
	const plates: Plate[] = [];
	let x = 0;
	while (x < 1) {
		const w = (40 + rand() * 100) / 512;
		let y = 0;
		while (y < 1) {
			const h = (32 + rand() * 80) / 256;
			plates.push({
				x0: x,
				y0: y,
				x1: Math.min(1, x + w),
				y1: Math.min(1, y + h),
				shade: (rand() - 0.35) * 0.5,
				mli: rand() > 0.55,
				mliPhase: rand() * 100
			});
			y += h;
		}
		x += w;
	}

	// Gold thermal blanket patches — the most recognizable spacecraft cue.
	const patches: { x0: number; y0: number; x1: number; y1: number; alpha: number }[] = [];
	const patchCount = 3 + Math.floor(rand() * 4);
	for (let i = 0; i < patchCount; i++) {
		const pxn = rand();
		const pyn = rand();
		patches.push({
			x0: pxn,
			y0: pyn,
			x1: pxn + (60 + rand() * 150) / 512,
			y1: pyn + (40 + rand() * 110) / 256,
			alpha: 0.55 + rand() * 0.35
		});
	}

	// Radiator strips: bright white, sharply bounded, spanning the full width.
	const radiators: { y0: number; y1: number }[] = [];
	const radiatorCount = 1 + Math.floor(rand() * 3);
	for (let i = 0; i < radiatorCount; i++) {
		const ry = rand() * 0.85;
		radiators.push({ y0: ry, y1: ry + (14 + rand() * 26) / 256 });
	}

	const gold = { r: 198, g: 152, b: 60 };
	const goldHi = { r: 255, g: 214, b: 130 };
	const white = { r: 232, g: 236, b: 242 };
	const grid = { r: 120, g: 128, b: 140 };

	for (let py = 0; py < height; py++) {
		const v = (py + 0.5) / height;
		for (let pxi = 0; pxi < width; pxi++) {
			const u = (pxi + 0.5) / width;

			// The dark substrate the plate gaps expose as seams.
			let c = dark;

			// Plates, inset by ~2px at the reference 512-wide layout.
			const inset = 2 / 512;
			for (const p of plates) {
				if (u < p.x0 + inset || u > p.x1 - inset || v < p.y0 + inset * 2 || v > p.y1 - inset * 2) {
					continue;
				}
				c = tone(color, p.shade);
				// Multi-layer insulation crinkle, on some plates.
				if (p.mli) {
					const crinkle = fbm(u * 240, v * 380 + p.mliPhase, p.mliPhase, seed + 401, 3);
					c = tone(c, (crinkle - 0.5) * 0.5);
				}
				// Edge bevel so plates read as raised.
				const edge = Math.min(u - p.x0 - inset, p.x1 - inset - u, v - p.y0 - inset * 2, p.y1 - inset * 2 - v);
				c = tone(c, smoothstep(0.008, 0, edge) * -0.25);
				break;
			}

			// Gold foil, crinkled.
			for (const p of patches) {
				if (u < p.x0 || u > p.x1 || v < p.y0 || v > p.y1) continue;
				const crinkle = ridged(u * 90, v * 120, 3.3, seed + 907, 4);
				const foil = mix(gold, goldHi, clamp01((crinkle - 0.4) * 1.6));
				c = mix(c, foil, p.alpha);
				break;
			}

			// Radiators, with their vertical grid lines.
			for (const r of radiators) {
				if (v < r.y0 || v > r.y1) continue;
				c = mix(c, white, 0.9);
				// A grid line every 10 px at the reference 512 width.
				const g = (u * 512) % 10;
				c = mix(c, grid, smoothstep(1.2, 0, Math.min(g, 10 - g)) * 0.8);
				break;
			}

			const i = (py * width + pxi) * 3;
			data[i] = c.r;
			data[i + 1] = c.g;
			data[i + 2] = c.b;
		}
	}
}

/**
 * Solar-array texture: photovoltaic cells in a grid with busbars.
 *
 * Laid out for a flat quad, not a sphere — the cell grid runs the length of the
 * wing. Not hue-rotated at runtime: cells are the same color on every craft.
 */
export function renderSolarPanel(variant: number): Pixels {
	const supersample = 3;
	const width = 1024;
	const height = 512;
	const px = createPixels(width * supersample, height * supersample);
	const rand = mulberry32(hashSeed(`panel|${variant}`) ^ 0x501a2);

	const substrate = { r: 18, g: 23, b: 43 };
	const busbar = { r: 190, g: 200, b: 215 };
	const spar = { r: 168, g: 172, b: 180 };

	// Cell grid: sixteen along the length, six across.
	const cols = 16;
	const rows = 6;
	const cellShade: number[] = [];
	for (let i = 0; i < cols * rows; i++) cellShade.push(0.82 + rand() * 0.28);

	for (let py = 0; py < px.height; py++) {
		const v = (py + 0.5) / px.height;
		for (let pxi = 0; pxi < px.width; pxi++) {
			const u = (pxi + 0.5) / px.width;

			let c = substrate;

			const cx = Math.min(cols - 1, Math.floor(u * cols));
			const cy = Math.min(rows - 1, Math.floor(v * rows));
			// Position within the cell, 0–1.
			const fx = u * cols - cx;
			const fy = v * rows - cy;
			// Gap between cells, 1.5px at the reference 512×256 layout.
			const gapU = 1.5 / (width / cols);
			const gapV = 1.5 / (height / rows);

			if (fx > gapU && fx < 1 - gapU && fy > gapV && fy < 1 - gapV) {
				const shadeAmount = cellShade[cy * cols + cx];
				c = { r: 28 * shadeAmount, g: 48 * shadeAmount, b: 112 * shadeAmount };
				// Anti-reflective sheen: a faint diagonal gradient per cell, which is
				// what makes the array glint rather than sit flat.
				c = tone(c, (fx * 0.5 + fy * 0.5 - 0.5) * 0.12);

				// Busbars.
				for (const f of [0.33, 0.67]) {
					const d = Math.abs(fx - f) * (width / cols);
					c = mix(c, busbar, smoothstep(0.6, 0, d) * 0.55);
				}
			}

			// Structural spar down the middle of the wing, where the yoke attaches.
			const sparD = Math.abs(v - 0.5) * height;
			c = mix(c, spar, smoothstep(2.5, 1.5, sparD) * 0.85);

			const i = (py * px.width + pxi) * 3;
			c = { r: c.r, g: c.g, b: c.b };
			px.data[i] = c.r;
			px.data[i + 1] = c.g;
			px.data[i + 2] = c.b;
		}
	}

	return downsample(px, supersample);
}

/**
 * Render one body texture, supersampled and downsampled. The baker's entry
 * point; `variant` selects one of `VARIANTS_BY_TYPE[type]` surfaces.
 */
export function renderBodyTexture(type: BodyTextureType, variant: number): Pixels {
	const size = TEX_SIZES[type];
	const ss = SUPERSAMPLE[type] ?? 1;
	const px = createPixels(size * ss, (size / 2) * ss);

	const color = REFERENCE_COLOR[type];
	const seed = hashSeed(`${type}|${variant}`);
	const rand = mulberry32(seed);

	switch (type) {
		case "star":
			renderField(px, drawStar(color, seed, rand));
			break;
		case "gas":
			renderField(
				px,
				drawBands(color, seed, rand, {
					// Varies per variant, so the roster isn't a row of planets with the
					// same stripe cadence in different colors.
					bands: 7 + Math.floor(rand() * 4),
					contrast: 0.42,
					turbulence: 0.1,
					storms: 3 + Math.floor(rand() * 4)
				})
			);
			break;
		case "ice":
			// Pale, low-contrast bands, at most one visible storm.
			renderField(
				px,
				drawBands(color, seed, rand, {
					bands: 4 + Math.floor(rand() * 3),
					contrast: 0.18,
					turbulence: 0.03,
					storms: rand() > 0.5 ? 1 : 0
				})
			);
			break;
		case "earthlike":
			drawEarthlike(px, color, seed, rand);
			break;
		case "satellite":
			drawSatelliteHull(px, color, rand, seed);
			break;
		default:
			// rocky / moon / dwarf / asteroid. Procedural cratering was tried at
			// length and always read as CG — these are baked from real mosaics by
			// `scripts/remix-textures.mjs` instead.
			throw new Error(`${type} is remixed from real mosaics, not generated here`);
	}

	return downsample(px, ss);
}

/**
 * Check that every `REFERENCE_HUE` matches the hue of its `REFERENCE_COLOR`.
 * They are separate constants (the shader wants a number, the renderers RGB); if
 * they drift, every body of that type renders hue-shifted from its own swatch.
 * The baker calls this so a mismatch fails the bake instead.
 */
export function assertReferenceHues(tolerance = 0.002): string[] {
	const problems: string[] = [];
	for (const type of BODY_TEXTURE_TYPES) {
		const actual = rgbToHsl(REFERENCE_COLOR[type]).h;
		const declared = REFERENCE_HUE[type];
		if (Math.abs(actual - declared) > tolerance) {
			problems.push(`${type}: REFERENCE_HUE is ${declared}, but REFERENCE_COLOR's hue is ${actual.toFixed(4)}`);
		}
	}
	return problems;
}

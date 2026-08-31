// Offline baker for body surface textures.
//
// Runs the renderers in `src/lib/scene/textureCore.ts` — and, for the cratered
// types, the mosaic remixer in `scripts/remix-textures.mjs` — under Node and
// writes the results to `public/textures/`. The output is committed, so this
// only needs running when a renderer changes.
//
//   npm run bake-textures                 # everything
//   npm run bake-textures -- moon rocky   # just these types
//   npm run bake-textures -- --jobs 4     # limit worker processes
//
// Why an offline bake at all: these textures used to be generated in the browser
// on the main thread while the user waited, which capped resolution at 512 and
// forced every quality knob (crater counts, octave depth, variant counts) down
// to whatever kept load time tolerable. Baking moves that cost to build time, so
// the runtime pays only a download and a GPU upload.
//
// Body maps are written as JPEG, panels as PNG. The first version of this
// script wrote PNG everywhere to avoid JPEG ringing on crater rims under the
// bloom pass — and the full bake came out at 64 MB, dominated by the noisy
// 2048² crater and granulation maps that PNG's filters can't predict. At
// quality 90 the same maps are ~5× smaller, and a 3×-magnified A/B of crater
// rims and star granulation shows no visible ringing or blocking; the concern
// was real for hard synthetic edges but these surfaces have none that sharp.
// The panels do (cell-grid busbars a texel wide), so they stay PNG — they're
// 80 KB each, so nothing is saved by converting them.

import { deflateSync } from 'node:zlib';
import { encode as encodeJpegRaw } from 'jpeg-js';
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';
import { cpus } from 'node:os';

import {
  BODY_TEXTURE_TYPES,
  VARIANTS_BY_TYPE,
  TEX_SIZES,
  REFERENCE_HUE,
  renderBodyTexture,
  renderSolarPanel,
  assertReferenceHues,
} from '../src/lib/scene/textureCore.ts';
import { REMIXED_TYPES, renderRemixedTexture } from './remix-textures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'textures');

// --- PNG encoding ---------------------------------------------------------
//
// Hand-rolled rather than pulled from npm: the format's baseline (8-bit RGB, no
// interlacing) is about sixty lines on top of zlib, and the project has no image
// dependency otherwise.

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), data.length + 8);
  return out;
}

/**
 * Per-scanline filtering, picking the filter that minimizes absolute sum — the
 * heuristic from the PNG spec. Worth the pass: on these noisy maps it cuts file
 * size by roughly a third versus filter type 0 everywhere.
 */
function filterScanlines(data, width, height) {
  const stride = width * 3;
  const out = Buffer.alloc((stride + 1) * height);
  const line = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = (y - 1) * stride;
    let bestFilter = 0;
    let bestScore = Infinity;

    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? data[row + i - 3] : 0;
        const b = y > 0 ? data[prev + i] : 0;
        const c = y > 0 && i >= 3 ? data[prev + i - 3] : 0;
        let v;
        switch (f) {
          case 0: v = data[row + i]; break;
          case 1: v = data[row + i] - a; break;
          case 2: v = data[row + i] - b; break;
          case 3: v = data[row + i] - ((a + b) >> 1); break;
          default: {
            // Paeth predictor.
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            v = data[row + i] - pred;
          }
        }
        v &= 0xff;
        line[i] = v;
        // Signed magnitude, per the spec's recommended heuristic.
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        line.copy(best);
      }
    }

    out[y * (stride + 1)] = bestFilter;
    best.copy(out, y * (stride + 1) + 1);
  }
  return out;
}

function encodePng(pixels) {
  const { width, height, data } = pixels;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const filtered = filterScanlines(Buffer.from(data.buffer, data.byteOffset, data.length), width, height);
  const idat = deflateSync(filtered, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- work list ------------------------------------------------------------

/** JPEG for the body maps; see the format note at the top of the file. */
const JPEG_QUALITY = 90;

function encodeJpeg(pixels) {
  const { width, height, data } = pixels;
  // jpeg-js wants RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height * 3; i += 3, j += 4) {
    rgba[j] = data[i];
    rgba[j + 1] = data[i + 1];
    rgba[j + 2] = data[i + 2];
    rgba[j + 3] = 255;
  }
  return encodeJpegRaw({ data: rgba, width, height }, JPEG_QUALITY).data;
}

function buildJobs(filter) {
  const jobs = [];
  for (const type of BODY_TEXTURE_TYPES) {
    if (filter.length && !filter.includes(type)) continue;
    for (let v = 0; v < VARIANTS_BY_TYPE[type]; v++) {
      jobs.push({ kind: 'body', type, variant: v, name: `${type}-${v}.jpg` });
    }
  }
  if (!filter.length || filter.includes('panel')) {
    for (let v = 0; v < 4; v++) {
      jobs.push({ kind: 'panel', variant: v, name: `panel-${v}.png` });
    }
  }
  return jobs;
}

function runJob(job) {
  const pixels =
    job.kind === 'panel'
      ? renderSolarPanel(job.variant)
      : REMIXED_TYPES.includes(job.type)
        ? renderRemixedTexture(job.type, job.variant)
        : renderBodyTexture(job.type, job.variant);
  const bytes = job.kind === 'panel' ? encodePng(pixels) : encodeJpeg(pixels);
  writeFileSync(join(OUT_DIR, job.name), bytes);
  return { name: job.name, bytes: bytes.length, width: pixels.width, height: pixels.height };
}

// --- worker mode ----------------------------------------------------------
//
// A 2048×1024 map at 3× supersampling is ~19M field evaluations, several seconds
// of single-threaded work, and there are ~50 of them. Forking one process per
// core takes the full bake from minutes to tens of seconds.

if (process.env.BAKE_WORKER === '1') {
  process.on('message', (job) => {
    try {
      process.send({ ok: true, result: runJob(job) });
    } catch (err) {
      process.send({ ok: false, error: String(err && err.stack ? err.stack : err) });
    }
  });
} else {
  await main();
}

async function main() {
  const argv = process.argv.slice(2);
  let jobsFlag = 0;
  const filter = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--jobs') jobsFlag = Number(argv[++i]);
    else filter.push(argv[i]);
  }

  const hueProblems = assertReferenceHues();
  if (hueProblems.length) {
    console.error('REFERENCE_HUE is out of sync with REFERENCE_COLOR:');
    for (const p of hueProblems) console.error(`  ${p}`);
    process.exit(1);
  }

  const unknown = filter.filter((f) => f !== 'panel' && !BODY_TEXTURE_TYPES.includes(f));
  if (unknown.length) {
    console.error(`Unknown type(s): ${unknown.join(', ')}`);
    console.error(`Known: ${[...BODY_TEXTURE_TYPES, 'panel'].join(', ')}`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const jobs = buildJobs(filter);
  // A full bake replaces the directory's contents; a filtered one must not
  // delete the maps it isn't regenerating.
  if (!filter.length) {
    for (const f of readdirSync(OUT_DIR)) {
      if (f.endsWith('.png') || f.endsWith('.jpg')) unlinkSync(join(OUT_DIR, f));
    }
  }

  const workerCount = Math.max(1, Math.min(jobsFlag || cpus().length - 1, jobs.length));
  console.log(`Baking ${jobs.length} textures with ${workerCount} workers…`);
  const started = performance.now();

  const queue = [...jobs];
  const results = [];
  let failed = false;

  await Promise.all(
    Array.from({ length: workerCount }, () => {
      return new Promise((resolve) => {
        // `cwd` pinned to the repo root: fork() resolves the module path
        // against the child's working directory, so without this the baker
        // only works when invoked from the repo root.
        const child = fork(fileURLToPath(import.meta.url), [], {
          cwd: join(HERE, '..'),
          env: { ...process.env, BAKE_WORKER: '1' },
          execArgv: process.execArgv,
        });

        const next = () => {
          const job = queue.shift();
          if (!job) {
            child.kill();
            resolve();
            return;
          }
          child.send(job);
        };

        child.on('message', (msg) => {
          if (msg.ok) {
            results.push(msg.result);
            const kb = (msg.result.bytes / 1024).toFixed(0);
            console.log(
              `  ${msg.result.name.padEnd(16)} ${msg.result.width}×${msg.result.height}  ${kb} KB`
            );
          } else {
            failed = true;
            console.error(msg.error);
          }
          next();
        });
        child.on('error', (err) => {
          failed = true;
          console.error(err);
          resolve();
        });

        next();
      });
    })
  );

  if (failed) process.exit(1);

  const total = results.reduce((sum, r) => sum + r.bytes, 0);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `\nBaked ${results.length} textures, ${(total / 1024 / 1024).toFixed(1)} MB total, in ${seconds}s`
  );

  writeManifest();
}

/**
 * Emitting this rather than having the runtime import the constants directly
 * keeps `textureCore.ts` — with all its renderer code — out of the browser
 * bundle entirely. The runtime only needs to know what exists and at what hue.
 */
function writeManifest() {
  const manifest = {
    // Bumped by hand when the renderers change in a way that should bust a
    // deployed cache.
    version: 1,
    types: Object.fromEntries(
      BODY_TEXTURE_TYPES.map((t) => [
        t,
        { variants: VARIANTS_BY_TYPE[t], size: TEX_SIZES[t], hue: REFERENCE_HUE[t] },
      ])
    ),
    panelVariants: 4,
  };
  const path = join(HERE, '..', 'src', 'lib', 'scene', 'textureManifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${path}`);
}

// Add a hand-reviewed submission to the user-systems gallery.
//
//   npm run gallery-add -- <share-url | file.json> --id <id> --by "Name" --from "Place" --blurb "..."
//
// Submissions arrive by email as a share link, so the first argument is
// usually that URL (quote it — the payload is long and `#` starts a shell
// comment); a path to a JSON file works too. Either way the system goes
// through the same decoding and `parseSystemFile` the app's import path uses
// (so what passes here is what the app will load), the normalized result is
// written to `public/gallery/<id>.json`, and a metadata entry is appended to
// `src/lib/presets/gallery.ts` with a placeholder `shot`.
//
// `--by` and `--from` are optional; `--id` and `--blurb` are not. The id is the
// filename stem for both the JSON and the thumbnail, so it must be a lowercase
// slug. The thumbnail is a separate step — tune the entry's `shot`, then run
// the screenshot script (this prints the exact command).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The app's modules use extensionless relative imports, which Vite resolves and
// Node's type-stripping loader does not. Same trick either way: retry with .ts.
// (The npm script runs this with --experimental-transform-types: the import
// graph reaches `sim/snapshots.ts`, whose parameter properties strip-only mode
// rejects.)
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

const { parseSystemFile, serializeSystemFile, ImportError } = await import(
  '../src/lib/storage/persistence.ts'
);
const { decodeShareHash, hasSharePayload } = await import('../src/lib/storage/shareUrl.ts');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GALLERY_DIR = join(REPO_ROOT, 'public', 'gallery');
const GALLERY_TS = join(REPO_ROOT, 'src', 'lib', 'presets', 'gallery.ts');
const INSERT_MARKER = '\t// gallery-add inserts new entries above this line — keep this comment.';

function fail(message) {
  console.error(`gallery-add: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { file: undefined, id: undefined, by: undefined, from: undefined, blurb: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--id' || arg === '--by' || arg === '--from' || arg === '--blurb') {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      args[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) {
      fail(`unknown option ${arg}`);
    } else if (args.file === undefined) {
      args.file = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  if (!args.file) fail('usage: npm run gallery-add -- <share-url | file.json> --id <id> [--by "Name"] [--from "Place"] --blurb "..."');
  if (!args.id) fail('--id is required (it names public/gallery/<id>.json and <id>.jpg)');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.id)) fail(`id "${args.id}" must be a lowercase slug (a-z, 0-9, hyphens)`);
  if (!args.blurb) fail('--blurb is required — say what is physically interesting about this system');
  return args;
}

const args = parseArgs(process.argv.slice(2));

// --- validate the submission ---------------------------------------------

// A share link is recognised by its fragment, so a bare `#s=…` pasted without
// the origin works as well as the full URL.
function shareHashOf(source) {
  let hash = source.startsWith('#') ? source : null;
  if (hash === null) {
    try {
      hash = new URL(source).hash;
    } catch {
      return null;
    }
  }
  return hasSharePayload(hash) ? hash : null;
}

let file;
const shareHash = shareHashOf(args.file);
try {
  if (shareHash !== null) {
    file = await decodeShareHash(shareHash);
  } else {
    let text;
    try {
      text = readFileSync(args.file, 'utf8');
    } catch {
      fail(`could not read ${args.file} (not a share link, and not a readable file)`);
    }
    file = parseSystemFile(text);
  }
} catch (err) {
  if (err instanceof ImportError) {
    fail(`${shareHash !== null ? 'the share link' : `"${args.file}"`} failed validation: ${err.message}`);
  }
  throw err;
}

// --- refuse collisions ----------------------------------------------------

const jsonPath = join(GALLERY_DIR, `${args.id}.json`);
if (existsSync(jsonPath)) fail(`${jsonPath} already exists — pick another id`);

const galleryTs = readFileSync(GALLERY_TS, 'utf8');
if (!galleryTs.includes(INSERT_MARKER)) fail(`insertion marker not found in ${GALLERY_TS}`);
if (galleryTs.includes(`id: ${JSON.stringify(args.id)}`)) {
  fail(`gallery.ts already has an entry with id "${args.id}"`);
}

// --- write both halves ----------------------------------------------------

// The re-serialized parse, not the input text: parsing coerces cosmetic
// problems and re-issues duplicate body ids, so what ships is exactly what the
// app will reconstruct.
writeFileSync(jsonPath, `${serializeSystemFile(file)}\n`);

const attribution = [
  args.by === undefined ? null : `\t\tby: ${JSON.stringify(args.by)},`,
  args.from === undefined ? null : `\t\tfrom: ${JSON.stringify(args.from)},`,
].filter((line) => line !== null);

const entry = [
  '\t{',
  `\t\tid: ${JSON.stringify(args.id)},`,
  `\t\tname: ${JSON.stringify(file.name)},`,
  ...attribution,
  `\t\tblurb: ${JSON.stringify(args.blurb)},`,
  '\t\t// Placeholder framing — tune it, then regenerate the thumbnail.',
  '\t\tshot: { days: 365, zoom: 1.2e12 }',
  '\t},',
].join('\n');

writeFileSync(GALLERY_TS, galleryTs.replace(INSERT_MARKER, `${entry}\n${INSERT_MARKER}`));

console.log(`wrote public/gallery/${args.id}.json (${file.bodies.length} bodies, "${file.name}")`);
console.log(`appended "${args.id}" to src/lib/presets/gallery.ts`);
console.log('');
console.log('next: tune the entry\'s `shot`, then generate the thumbnail with');
console.log(`  npm run preset-screenshots -- --gallery ${args.id}`);
console.log('(needs a dev server on :5317), and look at the image.');

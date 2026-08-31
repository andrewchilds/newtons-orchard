// Share a system as a URL: the whole file, compressed into the hash fragment.
//
// The payload rides in the fragment, never a query param, because the fragment
// never leaves the browser — nothing to configure on the static host, no
// server-side length cap, and nobody's system in anyone's access logs. Format:
//
//   #s=<share version>.<base64url of deflate-raw'd compact JSON>
//
// Body ids are stripped before compressing — 36 characters of incompressible
// UUID per body, and `parseSystemFile` re-issues missing ids anyway. Numbers
// are deliberately NOT rounded: a link must reproduce the author's exact
// initial conditions, and in a chaotic system a rounded position is a
// different trajectory. `CompressionStream` keeps this dependency-free;
// deflate more than halves the raw JSON, landing hand-built-scale systems
// around 1–3k characters.

import type { SystemFile } from '../types';
import { ImportError, parseSystemFile } from './persistence';

const PREFIX = '#s=';

/**
 * Version of the *container* — prefix, compression, encoding — bumped
 * independently of `SystemFile.version`, which rides inside the payload and is
 * validated by `parseSystemFile` like any import.
 */
const SHARE_VERSION = 1;

export function hasSharePayload(hash: string): boolean {
  return hash.startsWith(PREFIX);
}

/** The current page's URL with `file` as its fragment. */
export async function shareUrlFor(file: SystemFile): Promise<string> {
  const url = new URL(location.href);
  url.hash = await shareHashFor(file);
  return url.href;
}

export async function shareHashFor(file: SystemFile): Promise<string> {
  const slim = { ...file, bodies: file.bodies.map(({ id, ...body }) => body) };
  const bytes = await deflateRaw(JSON.stringify(slim));
  return `${PREFIX}${SHARE_VERSION}.${toBase64Url(bytes)}`;
}

/**
 * Decode a share fragment into a validated `SystemFile`.
 *
 * Throws `ImportError` with a user-safe message: a truncated paste (chat apps
 * cut long URLs) and a link from a future build are different problems, and
 * "invalid link" helps with neither.
 */
export async function decodeShareHash(hash: string): Promise<SystemFile> {
  const payload = hash.slice(PREFIX.length);
  const dot = payload.indexOf('.');
  if (dot < 1) throw new ImportError('The share link is incomplete.');

  const version = payload.slice(0, dot);
  if (version !== String(SHARE_VERSION)) {
    throw new ImportError(
      `This share link was made by a newer version of the app (link format ${version}).`
    );
  }

  let json: string;
  try {
    json = await inflateRaw(fromBase64Url(payload.slice(dot + 1)));
  } catch {
    throw new ImportError('The share link is damaged — it may have been cut short when copied.');
  }
  return parseSystemFile(json);
}

/**
 * The system a share link brought to this page load, if any.
 *
 * On success the fragment is removed from the address bar: the session belongs
 * to the autosave from here on, and a reload with the fragment still present
 * would silently throw away edits by resetting to the link's state. On failure
 * it is left in place so the user can still copy the link back out.
 */
export async function consumeSharedSystem(): Promise<{
  file: SystemFile | null;
  error: string | null;
}> {
  if (typeof location === 'undefined' || !hasSharePayload(location.hash)) {
    return { file: null, error: null };
  }
  try {
    const file = await decodeShareHash(location.hash);
    history.replaceState(null, '', location.pathname + location.search);
    return { file, error: null };
  } catch (err) {
    return {
      file: null,
      error: err instanceof ImportError ? err.message : 'This share link could not be read.',
    };
  }
}

// --- codec ---------------------------------------------------------------

async function deflateRaw(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

// btoa works on byte-strings; built in chunks so a big swarm doesn't blow
// String.fromCharCode's argument limit.
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

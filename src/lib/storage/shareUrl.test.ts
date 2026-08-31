import { describe, expect, it } from 'vitest';
import { decodeShareHash, hasSharePayload, shareHashFor } from './shareUrl';
import { ImportError } from './persistence';
import type { Body, SystemFile } from '../types';

function makeBody(overrides: Partial<Body> = {}): Body {
  return {
    id: crypto.randomUUID(),
    name: 'Test Planet',
    color: '#3388ff',
    type: 'rocky',
    mass: 5.972e24,
    radius: 6.371e6,
    rotationPeriod: 86164,
    axialTilt: 23.4,
    position: { x: 1.496e11, y: 0, z: 0 },
    velocity: { x: 0, y: 2.978e4, z: 0 },
    ...overrides,
  };
}

function makeFile(): SystemFile {
  return {
    version: 1,
    name: 'Shared System',
    bodies: [
      makeBody({
        name: 'Sol',
        type: 'star',
        texture: 'earth',
        mass: 1.989e30,
        // Double round-trip noise — the encoding must carry it exactly, since
        // shared links deliberately skip rounding.
        position: { x: 1.0000000000000002, y: 0, z: 0 },
        atmosphere: { color: '#ffdd88', density: 0.7 },
      }),
      makeBody({
        name: 'Ringed',
        type: 'gas',
        collisionRadius: 1.5e7,
        rotationPhase: 12.5,
        rings: { innerRadius: 7e7, outerRadius: 1.4e8, color: '#d9c9a3', opacity: 0.6 },
      }),
    ],
    settings: { dt: 600, snapshotInterval: 86400, trailInterval: 3600 },
  };
}

const stripIds = (bodies: Body[]) => bodies.map(({ id, ...body }) => body);

describe('share links', () => {
  it('round-trips a system exactly, minus body ids', async () => {
    const original = makeFile();
    const hash = await shareHashFor(original);

    expect(hasSharePayload(hash)).toBe(true);
    // The whole fragment must survive a URL: version tag, then base64url only.
    expect(hash).toMatch(/^#s=1\.[A-Za-z0-9_-]+$/);

    const decoded = await decodeShareHash(hash);
    expect(decoded.name).toBe(original.name);
    expect(decoded.settings).toEqual(original.settings);
    expect(stripIds(decoded.bodies)).toEqual(stripIds(original.bodies));
    // Stripped ids come back re-issued, not empty.
    for (const body of decoded.bodies) expect(body.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('compresses below the raw JSON size', async () => {
    const original = makeFile();
    const hash = await shareHashFor(original);
    expect(hash.length).toBeLessThan(JSON.stringify(original).length);
  });

  it('rejects a truncated payload with a user-safe message', async () => {
    const hash = await shareHashFor(makeFile());
    await expect(decodeShareHash(hash.slice(0, hash.length - 10))).rejects.toThrow(ImportError);
    await expect(decodeShareHash(hash.slice(0, hash.length - 10))).rejects.toThrow(/cut short/);
  });

  it('rejects a link from a future encoding version', async () => {
    await expect(decodeShareHash('#s=99.AAAA')).rejects.toThrow(/newer version/);
  });

  it('rejects a fragment with no payload', async () => {
    await expect(decodeShareHash('#s=')).rejects.toThrow(/incomplete/);
    await expect(decodeShareHash('#s=1')).rejects.toThrow(/incomplete/);
  });

  it('runs decoded content through the import validator', async () => {
    // Well-formed container around a payload the validator must reject.
    const hash = await shareHashFor({ ...makeFile(), bodies: [] });
    await expect(decodeShareHash(hash)).rejects.toThrow(/no bodies/);
  });
});

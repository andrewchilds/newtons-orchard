// Seeded randomness for procedural builders. Drawing from one of these instead
// of `Math.random` means a given seed always builds the same system — tests
// can assert against the output, and reloading a seeded preset puts the same
// sky on screen rather than a fresh roll of the dice.

/**
 * Mulberry32: a tiny, well-distributed 32-bit PRNG. Quality far beyond what
 * scattering orbital elements needs; the point is that it's seedable, which
 * `Math.random` is not.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(rand: () => number, lo: number, hi: number): number {
  return lo + rand() * (hi - lo);
}

/** Log-uniform: sizes and masses should span decades, not cluster at the top. */
export function logRange(rand: () => number, lo: number, hi: number): number {
  return Math.exp(range(rand, Math.log(lo), Math.log(hi)));
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length) % items.length];
}

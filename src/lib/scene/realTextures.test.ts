import { describe, expect, it } from 'vitest';
import { REAL_TEXTURE_KEYS } from '../types';

// `REAL_TEXTURE_KEYS` is a promise that `public/textures/real/<key>.jpg`
// exists — a body carrying a key with no file renders as its 1×1 placeholder
// forever, silently. Presets and imports both trust the list, so it is checked
// against the disk here (via Vite's glob, since the src tsconfig has no node
// types for an fs-based check).
const onDisk = import.meta.glob('/public/textures/real/*.jpg');

describe('real texture maps', () => {
  it('has a committed map for every key', () => {
    for (const key of REAL_TEXTURE_KEYS) {
      expect(onDisk[`/public/textures/real/${key}.jpg`], `missing public/textures/real/${key}.jpg`).toBeDefined();
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  CURRENT_VERSION,
  ImportError,
  exportFilename,
  hasBeenWelcomed,
  markWelcomed,
  parseSystemFile,
  readAutosave,
  serializeSystemFile,
  toSystemFile,
  writeAutosave,
} from './persistence';
import { solarSystem } from '../presets/solarSystem';
import { binaryStars } from '../presets/examples';
import type { Body } from '../types';

function sample(): Body[] {
  return [
    {
      id: 'a',
      name: 'Star',
      color: '#ffd27f',
      type: 'star',
      mass: 2e30,
      radius: 7e8,
      rotationPeriod: 2.2e6,
      axialTilt: 7.25,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    },
    {
      id: 'b',
      name: 'Planet',
      color: '#4a7edb',
      type: 'rocky',
      mass: 6e24,
      radius: 6.4e6,
      rotationPeriod: -86164,
      axialTilt: 23.44,
      position: { x: 1.5e11, y: 0, z: 0 },
      velocity: { x: 0, y: 29800, z: 0 },
      atmosphere: { color: '#7fb2ff', density: 0.5 },
      rings: { innerRadius: 1e7, outerRadius: 2e7, color: '#d9c9a3', opacity: 0.6 },
    },
  ];
}

describe('SystemFile round trip', () => {
  it('export → import is deep-equal', () => {
    const file = toSystemFile('Test System', sample());
    const back = parseSystemFile(serializeSystemFile(file));
    expect(back).toEqual(file);
  });

  it('round-trips every preset without loss', () => {
    for (const bodies of [solarSystem(), binaryStars()]) {
      const file = toSystemFile('Preset', bodies);
      const back = parseSystemFile(serializeSystemFile(file));

      // Deep-equal, except that JSON has no negative zero: `-0` serializes as
      // `0` and comes back as `0`. `toEqual` distinguishes those, physics does
      // not (-0 === 0), so numbers are compared with ==.
      expect(back.bodies).toHaveLength(file.bodies.length);
      back.bodies.forEach((got, i) => {
        const want = file.bodies[i];
        expect({ ...got, position: null, velocity: null }).toEqual({
          ...want,
          position: null,
          velocity: null,
        });
        for (const axis of ['x', 'y', 'z'] as const) {
          expect(got.position[axis] === want.position[axis]).toBe(true);
          expect(got.velocity[axis] === want.velocity[axis]).toBe(true);
        }
      });
    }
  });

  it('preserves retrograde rotation and negative coordinates exactly', () => {
    const bodies = sample();
    bodies[1].position = { x: -1.5e11, y: -2e10, z: 3e9 };
    const back = parseSystemFile(serializeSystemFile(toSystemFile('S', bodies)));
    expect(back.bodies[1].rotationPeriod).toBe(-86164);
    expect(back.bodies[1].position).toEqual({ x: -1.5e11, y: -2e10, z: 3e9 });
  });

  it('drops optional sections that were absent, rather than inventing them', () => {
    const back = parseSystemFile(serializeSystemFile(toSystemFile('S', sample())));
    expect(back.bodies[0].atmosphere).toBeUndefined();
    expect(back.bodies[0].rings).toBeUndefined();
  });
});

describe('import validation', () => {
  const bad = (text: string) => () => parseSystemFile(text);

  it('rejects non-JSON', () => {
    expect(bad('not json at all')).toThrow(ImportError);
  });

  it('rejects a JSON array or scalar at the top level', () => {
    expect(bad('[]')).toThrow(/JSON object/);
    expect(bad('42')).toThrow(/JSON object/);
  });

  it('rejects an unsupported version', () => {
    expect(bad(JSON.stringify({ version: 99, name: 'x', bodies: [] }))).toThrow(/version/);
  });

  it('rejects a file with no bodies', () => {
    expect(bad(JSON.stringify({ version: CURRENT_VERSION, name: 'x', bodies: [] }))).toThrow(
      /no bodies/
    );
    expect(bad(JSON.stringify({ version: CURRENT_VERSION, name: 'x' }))).toThrow(/"bodies"/);
  });

  // These are the ones that matter: a NaN or missing number doesn't fail
  // loudly in the integrator, it quietly turns the whole system's trajectory
  // into NaN a few steps later.
  it('rejects non-positive or non-finite mass and radius, naming the body', () => {
    const withBody = (patch: Record<string, unknown>) =>
      JSON.stringify({
        version: CURRENT_VERSION,
        name: 'x',
        bodies: [{ ...sample()[0], name: 'Wobble', ...patch }],
      });

    expect(bad(withBody({ mass: 0 }))).toThrow(/"Wobble" mass must be greater than zero/);
    expect(bad(withBody({ mass: -1 }))).toThrow(/mass/);
    // NaN doesn't survive JSON, so it arrives as null — which must be rejected
    // just as firmly.
    expect(bad(withBody({ mass: NaN }))).toThrow(/"Wobble" mass must be a finite number/);
    expect(bad(withBody({ radius: 0 }))).toThrow(/"Wobble" radius/);
    expect(bad(withBody({ mass: undefined }))).toThrow(/mass/);
  });

  it('rejects a malformed position or velocity vector', () => {
    const withBody = (patch: Record<string, unknown>) =>
      JSON.stringify({ version: CURRENT_VERSION, name: 'x', bodies: [{ ...sample()[0], ...patch }] });

    expect(bad(withBody({ position: { x: 0, y: 0 } }))).toThrow(/position\.z/);
    expect(bad(withBody({ velocity: [0, 0, 0] }))).toThrow(/velocity must be an \{x, y, z\}/);
    expect(bad(withBody({ position: { x: 0, y: 'far', z: 0 } }))).toThrow(/position\.y/);
  });

  it('rejects rings whose outer radius does not exceed the inner', () => {
    const body = { ...sample()[1], rings: { innerRadius: 2e7, outerRadius: 1e7 } };
    expect(bad(JSON.stringify({ version: CURRENT_VERSION, name: 'x', bodies: [body] }))).toThrow(
      /outer radius must exceed/
    );
  });

  it('fills in benign missing fields rather than rejecting', () => {
    const file = parseSystemFile(
      JSON.stringify({
        version: CURRENT_VERSION,
        bodies: [
          {
            mass: 6e24,
            radius: 6.4e6,
            position: { x: 1, y: 2, z: 3 },
            velocity: { x: 0, y: 0, z: 0 },
          },
        ],
      })
    );

    const body = file.bodies[0];
    expect(file.name).toBe('Imported System');
    expect(body.name).toBe('Body 1');
    expect(body.type).toBe('rocky');
    expect(body.rotationPeriod).toBe(0);
    expect(body.axialTilt).toBe(0);
    expect(body.id).toBeTruthy();
    expect(file.settings.dt).toBeGreaterThan(0);
  });

  it('re-issues duplicate ids so the roster stays unambiguous', () => {
    const [a] = sample();
    const file = parseSystemFile(
      JSON.stringify({ version: CURRENT_VERSION, name: 'x', bodies: [a, { ...a, name: 'Twin' }] })
    );
    expect(file.bodies[0].id).not.toBe(file.bodies[1].id);
  });

  it('clamps atmosphere density and ring opacity into range', () => {
    const body = {
      ...sample()[1],
      atmosphere: { color: '#fff', density: 4 },
      rings: { innerRadius: 1e7, outerRadius: 2e7, color: '#fff', opacity: -3 },
    };
    const file = parseSystemFile(
      JSON.stringify({ version: CURRENT_VERSION, name: 'x', bodies: [body] })
    );
    expect(file.bodies[0].atmosphere?.density).toBe(1);
    expect(file.bodies[0].rings?.opacity).toBe(0);
  });

  it('coerces an unknown body type instead of failing the whole import', () => {
    const file = parseSystemFile(
      JSON.stringify({
        version: CURRENT_VERSION,
        name: 'x',
        bodies: [{ ...sample()[0], type: 'quasar' }],
      })
    );
    expect(file.bodies[0].type).toBe('rocky');
  });

  it('keeps a known real-texture key and drops an unknown one', () => {
    const file = parseSystemFile(
      JSON.stringify({
        version: CURRENT_VERSION,
        name: 'x',
        bodies: [
          { ...sample()[1], texture: 'mars' },
          { ...sample()[1], id: 'c', texture: 'vulcan' },
        ],
      })
    );
    expect(file.bodies[0].texture).toBe('mars');
    expect(file.bodies[1].texture).toBeUndefined();
  });
});

describe('welcome flag', () => {
  // These tests run in Node, where there is no `localStorage` — which is the
  // same shape as a browser that has it disabled, so the no-storage case is
  // exercised by simply not installing the stub.
  function withStorage(run: () => void): void {
    const store = new Map<string, string>();
    const stub = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    (globalThis as { localStorage?: unknown }).localStorage = stub;
    try {
      run();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }

  it('reads as a first visit until it is marked', () => {
    withStorage(() => {
      expect(hasBeenWelcomed()).toBe(false);
      expect(markWelcomed()).toBe(true);
      expect(hasBeenWelcomed()).toBe(true);
    });
  });

  it('degrades to a first visit when localStorage is unavailable', () => {
    // A returning visitor in private mode sees the welcome again, rather than a
    // genuinely new one never seeing it. `markWelcomed` reports the failure
    // instead of throwing.
    expect(hasBeenWelcomed()).toBe(false);
    expect(markWelcomed()).toBe(false);
    expect(hasBeenWelcomed()).toBe(false);
  });
});

describe('autosave source', () => {
  const AUTOSAVE_KEY = 'space-sim:autosave';

  function withStorage(run: (store: Map<string, string>) => void): void {
    const store = new Map<string, string>();
    const stub = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    (globalThis as { localStorage?: unknown }).localStorage = stub;
    try {
      run(store);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }

  it('round-trips preset and mission provenance', () => {
    withStorage(() => {
      const file = toSystemFile('Test', sample());
      writeAutosave(file, 1, { kind: 'preset', id: 'solar-system' });
      expect(readAutosave()?.source).toEqual({ kind: 'preset', id: 'solar-system' });

      writeAutosave(file, 2, { kind: 'mission', id: 'full-stop', prediction: 1 });
      expect(readAutosave()?.source).toEqual({ kind: 'mission', id: 'full-stop', prediction: 1 });
    });
  });

  it('reads an autosave written before sources existed', () => {
    withStorage((store) => {
      const file = toSystemFile('Test', sample());
      store.set(AUTOSAVE_KEY, JSON.stringify({ file, savedAt: 5 }));
      const restored = readAutosave();
      expect(restored?.file.name).toBe('Test');
      expect(restored?.source).toBeNull();
    });
  });

  it('degrades a malformed source to null without losing the roster', () => {
    withStorage((store) => {
      const file = toSystemFile('Test', sample());
      for (const source of [
        { kind: 'slot', id: 'My System' },
        { kind: 'mission', id: 'full-stop' },
        { kind: 'preset', id: 7 },
        'solar-system',
      ]) {
        store.set(AUTOSAVE_KEY, JSON.stringify({ file, savedAt: 5, source }));
        const restored = readAutosave();
        expect(restored?.file.bodies).toHaveLength(2);
        expect(restored?.source).toBeNull();
      }
    });
  });
});

describe('exportFilename', () => {
  it('slugifies the system name', () => {
    expect(exportFilename('My Solar System')).toBe('my-solar-system.json');
    expect(exportFilename('  Trappist-1!!  ')).toBe('trappist-1.json');
  });

  it('falls back when the name has nothing usable in it', () => {
    expect(exportFilename('***')).toBe('system.json');
    expect(exportFilename('')).toBe('system.json');
  });
});

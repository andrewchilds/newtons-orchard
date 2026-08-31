import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  TURN_SECONDS,
  quarterTurnTarget,
  squareToNearestAxis,
  turnDuration,
} from './cameraTurn';
import type { CameraTurn } from '../state/ui.svelte';

const TURNS: CameraTurn[] = ['down', 'right', 'roll'];

/** The app's cold-start camera offset — deliberately off the 90° grid in y–z. */
const DEFAULT_OFFSET = new THREE.Vector3(0, 90, 260);
const DEFAULT_UP = new THREE.Vector3(0, 0, 1);

function turnN(turn: CameraTurn, n: number, offset = DEFAULT_OFFSET, up = DEFAULT_UP) {
  let o = offset.clone();
  let u = up.clone();
  for (let i = 0; i < n; i++) {
    const nextO = new THREE.Vector3();
    const nextU = new THREE.Vector3();
    quarterTurnTarget(turn, o, u, nextO, nextU);
    o = nextO;
    u = nextU;
  }
  return { offset: o, up: u };
}

/** How far `v` sits from the nearest world axis, as a direction cosine. */
function axisAlignment(v: THREE.Vector3): number {
  const n = v.clone().normalize();
  return Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z));
}

describe('quarterTurnTarget', () => {
  it.each(TURNS)('squares a tumbled view onto the grid on the first %s click', (turn) => {
    // The cold-start view sits off the grid; one click of any button levels it.
    const { offset } = turnN(turn, 1);
    expect(axisAlignment(offset)).toBeCloseTo(1, 9);
  });

  it('squares an arbitrarily tumbled view, not just the default one', () => {
    const tumbled = new THREE.Vector3(133, -71, 42);
    const up = new THREE.Vector3(0.3, 0.5, 0.81).normalize();
    const outOffset = new THREE.Vector3();
    const outUp = new THREE.Vector3();
    quarterTurnTarget('down', tumbled, up, outOffset, outUp);
    expect(axisAlignment(outOffset)).toBeCloseTo(1, 9);
    // The largest component wins: x here, so the camera lands down +x.
    expect(outOffset.x).toBeCloseTo(tumbled.length(), 9);
  });

  it.each(TURNS)('four %s turns from a square view return to the start', (turn) => {
    // From the *squared-up* view — the first click is the snap, so the cycle
    // closes from there.
    const start = turnN(turn, 1);
    const round = turnN(turn, 5);
    expect(round.offset.distanceTo(start.offset)).toBeLessThan(1e-9);
    expect(round.up.distanceTo(start.up)).toBeLessThan(1e-9);
  });

  it.each(['down', 'right'] as CameraTurn[])(
    'the four views a %s turn walks are all distinct',
    (turn) => {
      const views = [1, 2, 3, 4].map((n) => turnN(turn, n).offset);
      for (let i = 0; i < views.length; i++) {
        for (let j = i + 1; j < views.length; j++) {
          expect(views[i].distanceTo(views[j])).toBeGreaterThan(1);
        }
      }
    }
  );

  it.each(TURNS)('preserves camera distance through a %s turn', (turn) => {
    const before = DEFAULT_OFFSET.length();
    for (let n = 1; n <= 4; n++) {
      expect(turnN(turn, n).offset.length()).toBeCloseTo(before, 9);
    }
  });

  it.each(TURNS)('keeps up usable as an up vector through %s turns', (turn) => {
    // Not perpendicularity: squaring `up` to a world axis deliberately trades
    // that for a level horizon, and three.js orthogonalizes when it builds the
    // view matrix. What must hold is that `up` never goes parallel to the view
    // direction, which is degenerate and collapses the camera basis.
    for (let n = 1; n <= 5; n++) {
      const { offset, up } = turnN(turn, n);
      expect(Math.abs(offset.clone().normalize().dot(up))).toBeLessThan(0.999);
      expect(up.length()).toBeCloseTo(1, 9);
    }
  });

  it.each(TURNS)('never flips the horizon between consecutive %s turns', (turn) => {
    // Regression from the world-axis version: `up` chosen by a magnitude test
    // flipped on alternating quadrants, snapping the horizon 90° every other
    // click. Consecutive ups must differ by at most a quarter turn.
    for (let n = 1; n <= 4; n++) {
      const before = turnN(turn, n).up;
      const after = turnN(turn, n + 1).up;
      expect(before.angleTo(after)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    }
  });

  it.each(TURNS)('lands up on a world axis through %s turns, so views stay level', (turn) => {
    for (let n = 1; n <= 5; n++) {
      const { up } = turnN(turn, n);
      const components = [up.x, up.y, up.z].map(Math.abs).sort((a, b) => b - a);
      expect(components[0]).toBeCloseTo(1, 9);
      expect(components[1]).toBeCloseTo(0, 9);
    }
  });

  it('moves the camera down over the top when tipping down', () => {
    // From a square view down +y, looking back at the origin with +z up: a
    // "down" click tips the view downward, carrying the camera up toward +z.
    const offset = new THREE.Vector3(0, 260, 0);
    const up = new THREE.Vector3(0, 0, 1);
    const outOffset = new THREE.Vector3();
    const outUp = new THREE.Vector3();
    quarterTurnTarget('down', offset, up, outOffset, outUp);
    expect(outOffset.z).toBeCloseTo(260, 6);
    expect(outOffset.length()).toBeCloseTo(260, 9);
  });

  it('swings the camera around the up axis when turning right', () => {
    // Same start; a "right" click yaws about `up` (+z), so the camera stays at
    // the same elevation and only its bearing changes.
    const offset = new THREE.Vector3(0, 260, 0);
    const up = new THREE.Vector3(0, 0, 1);
    const outOffset = new THREE.Vector3();
    const outUp = new THREE.Vector3();
    quarterTurnTarget('right', offset, up, outOffset, outUp);
    expect(outOffset.z).toBeCloseTo(0, 6);
    expect(Math.abs(outOffset.x)).toBeCloseTo(260, 6);
    expect(outUp.z).toBeCloseTo(1, 6);
  });

  it('leaves the camera in place when rolling, turning only the horizon', () => {
    // Camera at +z looking back toward the origin, up along +y. The scene turns
    // clockwise on screen, matching the button's icon, which carries `up`
    // counter-clockwise in world terms — toward -x. The camera stays put.
    const offset = new THREE.Vector3(0, 0, 260);
    const up = new THREE.Vector3(0, 1, 0);
    const outOffset = new THREE.Vector3();
    const outUp = new THREE.Vector3();
    quarterTurnTarget('roll', offset, up, outOffset, outUp);
    expect(outOffset.distanceTo(offset)).toBeLessThan(1e-9);
    expect(outUp.distanceTo(new THREE.Vector3(-1, 0, 0))).toBeLessThan(1e-9);
  });

  it('has no stuck pole: every button moves a camera sitting on a world axis', () => {
    // The bug that motivated screen-relative turns. A world-axis turn about z
    // from straight down +z could never move the camera — it sat on the very
    // axis it was rotating about, so clicks only rolled the horizon. The two
    // directional buttons must move it from anywhere.
    const onPole = new THREE.Vector3(0, 0, 260);
    const up = new THREE.Vector3(0, 1, 0);
    for (const turn of ['down', 'right'] as CameraTurn[]) {
      const outOffset = new THREE.Vector3();
      const outUp = new THREE.Vector3();
      quarterTurnTarget(turn, onPole, up, outOffset, outUp);
      expect(outOffset.distanceTo(onPole)).toBeGreaterThan(1);
    }
  });

  it('steps a full quadrant per click once square, from every starting face', () => {
    // Each click from a square view must land on another square view a quarter
    // turn away — never a partial step, and never standing still.
    const faces = [
      new THREE.Vector3(260, 0, 0),
      new THREE.Vector3(0, 260, 0),
      new THREE.Vector3(0, 0, 260),
      new THREE.Vector3(-260, 0, 0),
    ];
    for (const face of faces) {
      const up = new THREE.Vector3(0, 0, 1);
      // Pick an up that isn't parallel to this face's view direction.
      if (Math.abs(face.clone().normalize().z) > 0.9) up.set(0, 1, 0);
      for (const turn of ['down', 'right'] as CameraTurn[]) {
        const outOffset = new THREE.Vector3();
        const outUp = new THREE.Vector3();
        quarterTurnTarget(turn, face, up, outOffset, outUp);
        expect(outOffset.angleTo(face)).toBeCloseTo(Math.PI / 2, 6);
        expect(axisAlignment(outOffset)).toBeCloseTo(1, 6);
      }
    }
  });
});

describe('turnDuration', () => {
  it('takes the same time on every button', () => {
    for (const turn of TURNS) {
      const from = turnN(turn, 1).offset;
      const to = turnN(turn, 2).offset;
      expect(turnDuration(from, to)).toBe(TURN_SECONDS);
    }
  });

  it('does not vary with the arc travelled', () => {
    const a = new THREE.Vector3(0, 0, 100);
    const quarter = new THREE.Vector3(100, 0, 0);
    const sliver = new THREE.Vector3(0.01, 0, 100);
    expect(turnDuration(a, quarter)).toBe(TURN_SECONDS);
    expect(turnDuration(a, sliver)).toBe(TURN_SECONDS);
  });
});

describe('squareToNearestAxis', () => {
  it('snaps a nearly-vertical up to +z', () => {
    const up = new THREE.Vector3(0.05, -0.02, 0.99);
    squareToNearestAxis(up, new THREE.Vector3(100, 0, 0));
    expect(up.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9);
  });

  it('keeps the sign, so an upside-down view is not flipped upright', () => {
    const up = new THREE.Vector3(0.05, -0.02, -0.99);
    squareToNearestAxis(up, new THREE.Vector3(100, 0, 0));
    expect(up.distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);
  });

  it('never picks the axis the camera looks along', () => {
    // Looking down z: an up along z has no meaning, so it must pick another.
    const up = new THREE.Vector3(0.1, 0.02, 0.99);
    squareToNearestAxis(up, new THREE.Vector3(0, 0, 260));
    expect(Math.abs(up.z)).toBeLessThan(1e-9);
    expect(up.length()).toBeCloseTo(1, 9);
  });
});

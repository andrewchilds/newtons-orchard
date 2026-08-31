import { describe, expect, it } from 'vitest';
import {
  add,
  addScaled,
  clone,
  copy,
  cross,
  distance,
  dot,
  length,
  lengthSq,
  normalize,
  scale,
  set,
  sub,
  vec3,
} from './vec3';

describe('vec3', () => {
  it('constructs zeroed by default', () => {
    expect(vec3()).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('adds, subtracts and scales into an out param', () => {
    const out = vec3();
    const a = vec3(1, 2, 3);
    const b = vec3(10, 20, 30);

    expect(add(out, a, b)).toEqual({ x: 11, y: 22, z: 33 });
    expect(sub(out, b, a)).toEqual({ x: 9, y: 18, z: 27 });
    expect(scale(out, a, 2)).toEqual({ x: 2, y: 4, z: 6 });
    // Inputs are untouched.
    expect(a).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('addScaled accumulates in place', () => {
    const out = vec3(1, 1, 1);
    addScaled(out, vec3(2, 4, 6), 0.5);
    expect(out).toEqual({ x: 2, y: 3, z: 4 });
  });

  it('computes dot and cross products', () => {
    expect(dot(vec3(1, 2, 3), vec3(4, -5, 6))).toBe(4 - 10 + 18);
    expect(cross(vec3(), vec3(1, 0, 0), vec3(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('cross handles output aliasing an input', () => {
    const a = vec3(1, 0, 0);
    cross(a, a, vec3(0, 1, 0));
    expect(a).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('computes lengths and distances', () => {
    expect(length(vec3(3, 4, 0))).toBe(5);
    expect(lengthSq(vec3(3, 4, 0))).toBe(25);
    expect(distance(vec3(1, 0, 0), vec3(4, 4, 0))).toBe(5);
  });

  it('normalizes, leaving a zero vector at zero', () => {
    expect(normalize(vec3(), vec3(0, 5, 0))).toEqual({ x: 0, y: 1, z: 0 });
    expect(normalize(vec3(), vec3())).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('clones and copies without aliasing', () => {
    const a = vec3(1, 2, 3);
    const c = clone(a);
    c.x = 99;
    expect(a.x).toBe(1);

    const out = vec3();
    copy(out, a);
    expect(out).toEqual(a);
    expect(set(out, 7, 8, 9)).toEqual({ x: 7, y: 8, z: 9 });
  });
});

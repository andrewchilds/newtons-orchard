import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { einsteinAngle, LensingPass, MAX_LENSES, SHADOW_FACTOR, shadowAngle } from './lensing';

/** Sgr A*'s Schwarzschild radius, meters — the scale the preset ships at. */
const RS = 1.27e10;

describe('lens angles', () => {
  it('matches the weak-field formulas far from the hole', () => {
    const d = 1e14; // ~7900 r_s out, safely weak-field
    expect(einsteinAngle(RS, d)).toBeCloseTo(Math.sqrt((2 * RS) / d), 10);
    expect(shadowAngle(RS, d)).toBeCloseTo((SHADOW_FACTOR * RS) / d, 6);
  });

  it('shrinks monotonically with distance', () => {
    let lastRing = Infinity;
    let lastShadow = Infinity;
    for (const d of [1e12, 1e13, 1e14, 1e15]) {
      const ring = einsteinAngle(RS, d);
      const shadow = shadowAngle(RS, d);
      expect(ring).toBeLessThan(lastRing);
      expect(shadow).toBeLessThan(lastShadow);
      lastRing = ring;
      lastShadow = shadow;
    }
  });

  it('stays finite however close the camera gets', () => {
    for (const d of [RS * 3, RS, RS / 10]) {
      expect(einsteinAngle(RS, d)).toBeLessThanOrEqual(1.2);
      expect(shadowAngle(RS, d)).toBeLessThanOrEqual(1.2);
      expect(Number.isFinite(einsteinAngle(RS, d))).toBe(true);
      expect(Number.isFinite(shadowAngle(RS, d))).toBe(true);
    }
  });

  it('is zero for a body with no horizon', () => {
    expect(einsteinAngle(0, 1e12)).toBe(0);
    expect(shadowAngle(0, 1e12)).toBe(0);
  });

  it('the ring sits well outside the shadow at viewing distances', () => {
    // The Einstein ring falls as 1/√D but the shadow as 1/D, so from any
    // sane camera distance the ring is the larger feature — the ordering the
    // shader's two radii rely on to leave a lensed annulus visible.
    const d = 50 * RS;
    expect(einsteinAngle(RS, d)).toBeGreaterThan(2 * shadowAngle(RS, d));
  });
});

describe('LensingPass.refresh', () => {
  /** Camera at +z looking down at the origin, matching the app's ecliptic. */
  function makeCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.001, 1e6);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -500, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return camera;
  }

  it('enables itself only when a hole is in front of the camera', () => {
    const pass = new LensingPass();
    const camera = makeCamera();
    const hole = { id: 'sgr-a', position: new THREE.Vector3(0, 0, 0), rs: 12.7 };

    expect(pass.refresh([hole], camera, 1080)).toBe(true);
    expect(pass.enabled).toBe(true);
    expect(pass.uniforms.uCount.value).toBe(1);
    // The caller uses this to hide the horizon mesh, which would otherwise be
    // re-imaged onto the Einstein ring as a dark band.
    expect(pass.activeIds.has('sgr-a')).toBe(true);

    hole.position.set(0, -2000, 0); // behind the camera
    expect(pass.refresh([hole], camera, 1080)).toBe(false);
    expect(pass.enabled).toBe(false);
    expect(pass.activeIds.size).toBe(0);
  });

  it('deactivate clears the active set so horizon meshes come back', () => {
    const pass = new LensingPass();
    pass.refresh([{ id: 'sgr-a', position: new THREE.Vector3(0, 0, 0), rs: 12.7 }], makeCamera(), 1080);
    expect(pass.activeIds.size).toBe(1);

    expect(pass.deactivate()).toBe(false);
    expect(pass.enabled).toBe(false);
    expect(pass.activeIds.size).toBe(0);
  });

  it('skips a hole whose deflection is sub-pixel', () => {
    const pass = new LensingPass();
    // A stellar-mass horizon (~3 km = 3e-6 scene units) bends nothing the
    // screen can show; the pass should keep the direct render path available.
    expect(
      pass.refresh([{ id: 'stellar', position: new THREE.Vector3(), rs: 3e-6 }], makeCamera(), 1080)
    ).toBe(false);
    expect(pass.activeIds.size).toBe(0);
  });

  it('centers the lens on the hole and orders shadow inside ring', () => {
    const pass = new LensingPass();
    const camera = makeCamera();
    pass.refresh([{ id: 'sgr-a', position: new THREE.Vector3(0, 0, 0), rs: 12.7 }], camera, 1080);

    const lens = pass.uniforms.uLenses.value[0] as THREE.Vector4;
    expect(lens.x).toBeCloseTo(0, 6); // dead center of the view
    expect(lens.y).toBeCloseTo(0, 6);
    expect(lens.z).toBeGreaterThan(0); // θ_E², so the warp pulls inward
    expect(Math.sqrt(lens.z)).toBeGreaterThan(lens.w); // ring outside shadow
  });

  it('caps the lens count at the shader array size', () => {
    const pass = new LensingPass();
    const holes = Array.from({ length: MAX_LENSES + 3 }, (_, i) => ({
      id: `hole-${i}`,
      position: new THREE.Vector3(i * 5, 0, 0),
      rs: 12.7,
    }));
    pass.refresh(holes, makeCamera(), 1080);
    expect(pass.uniforms.uCount.value).toBe(MAX_LENSES);
    // Overflow holes keep their meshes — they're not being warped.
    expect(pass.activeIds.size).toBe(MAX_LENSES);
    expect(pass.activeIds.has(`hole-${MAX_LENSES}`)).toBe(false);
  });
});

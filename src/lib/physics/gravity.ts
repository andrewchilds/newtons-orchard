// N-body gravity — direct O(n²) summation, pairwise symmetric, with a
// softening epsilon to survive near-collisions without NaN.
//
// Pairs involving a black hole (state.rs[i] > 0) use the Paczyński–Wiita
// pseudo-potential instead: a = G·m / (d − r_s)² along the separation. It's the
// standard Newtonian-code stand-in for Schwarzschild gravity — position-only,
// so it drops into velocity Verlet without breaking the symplectic form — and
// it reproduces bound-orbit precession and a genuine ISCO at 3 r_s, inside
// which trajectories plunge. All other pairs take the unmodified Newtonian
// path, bit-for-bit as before black holes existed.

import { G, SOFTENING } from './constants';
import type { PhysicsState } from './integrator';

const EPS_SQ = SOFTENING * SOFTENING;

/**
 * Index pairs whose true radii overlap, filled as a side effect of the force
 * loop. Reused across steps rather than reallocated — empty on nearly every one.
 */
export interface ContactList {
  /** flat [i₀, j₀, i₁, j₁, …]; length is twice the pair count */
  pairs: number[];
}

export function createContactList(): ContactList {
  return { pairs: [] };
}

/**
 * Compute accelerations for every body in `state`, writing into `state.acc`.
 *
 * Each pair is visited once and applied to both bodies with opposite signs:
 * half the work, and momentum conservation exact to floating point because the
 * contributions are equal and opposite by construction rather than by
 * cancellation between two separately accumulated sums.
 *
 * Softened form: a = G·m·d / (|d|² + ε²)^{3/2}. Allocation-free.
 *
 * If `contacts` is supplied, overlapping pairs are appended (list cleared
 * first). Piggybacking on the separation this loop already computes avoids a
 * second O(n²) sweep, which at ~90 bodies costs about as much as gravity
 * itself. The contact test uses the *unsoftened* separation, so it triggers on
 * true geometric overlap and is unaffected by SOFTENING.
 */
export function computeAccelerations(state: PhysicsState, contacts?: ContactList): void {
  const { n, mass, radius, rs, pos, acc } = state;

  acc.fill(0, 0, 3 * n);
  if (contacts !== undefined) contacts.pairs.length = 0;

  // This loop is ~77% of frame time at high warp, so two variants: systems
  // with no black hole (most of them) take a lean inner loop with no per-pair
  // rs load, add, or branch. Either way, body i's contributions accumulate in
  // locals and land in `acc` once per row — the j-side writes are unavoidable,
  // but the i-side would otherwise be three more typed-array read-modify-writes
  // per pair. `+=` on the writeback, not `=`: rows before i already deposited
  // their j-side halves there.
  let hasBH = false;
  for (let i = 0; i < n; i++) {
    if (rs[i] > 0) {
      hasBH = true;
      break;
    }
  }

  if (!hasBH) {
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const xi = pos[i3];
      const yi = pos[i3 + 1];
      const zi = pos[i3 + 2];
      const mi = mass[i];
      const ri = radius[i];
      let axi = 0;
      let ayi = 0;
      let azi = 0;

      for (let j = i + 1; j < n; j++) {
        const j3 = j * 3;
        const dx = pos[j3] - xi;
        const dy = pos[j3 + 1] - yi;
        const dz = pos[j3 + 2] - zi;

        const sepSq = dx * dx + dy * dy + dz * dz;
        const distSq = sepSq + EPS_SQ;
        const invDist = 1 / Math.sqrt(distSq);
        const f = G * invDist * invDist * invDist;

        const fi = f * mass[j];
        axi += dx * fi;
        ayi += dy * fi;
        azi += dz * fi;

        const fj = f * mi;
        acc[j3] -= dx * fj;
        acc[j3 + 1] -= dy * fj;
        acc[j3 + 2] -= dz * fj;

        if (contacts !== undefined) {
          const touching = ri + radius[j];
          if (sepSq <= touching * touching) contacts.pairs.push(i, j);
        }
      }

      acc[i3] += axi;
      acc[i3 + 1] += ayi;
      acc[i3 + 2] += azi;
    }
    return;
  }

  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const xi = pos[i3];
    const yi = pos[i3 + 1];
    const zi = pos[i3 + 2];
    const mi = mass[i];
    const ri = radius[i];
    const rsI = rs[i];
    let axi = 0;
    let ayi = 0;
    let azi = 0;

    for (let j = i + 1; j < n; j++) {
      const j3 = j * 3;
      const dx = pos[j3] - xi;
      const dy = pos[j3 + 1] - yi;
      const dz = pos[j3 + 2] - zi;

      const sepSq = dx * dx + dy * dy + dz * dz;
      let f: number;
      const rsSum = rsI + rs[j];
      if (rsSum === 0) {
        const distSq = sepSq + EPS_SQ;
        const invDist = 1 / Math.sqrt(distSq);
        const invDistCube = invDist * invDist * invDist;
        f = G * invDistCube;
      } else {
        // Paczyński–Wiita: magnitude G·m/(d − r_s)², divided by d once more
        // because it multiplies the un-normalized separation vector. Summing
        // both bodies' r_s keeps it symmetric (a BH–BH pair gets the combined
        // horizon) and reduces to Newtonian as r_s → 0. The softened d and the
        // clamp keep the force finite inside the horizon — by then the contact
        // test has queued the merge, a BH's collision radius being its r_s.
        const d = Math.sqrt(sepSq + EPS_SQ);
        const shifted = Math.max(d - rsSum, SOFTENING);
        f = G / (shifted * shifted * d);
      }

      const fi = f * mass[j];
      axi += dx * fi;
      ayi += dy * fi;
      azi += dz * fi;

      const fj = f * mi;
      acc[j3] -= dx * fj;
      acc[j3 + 1] -= dy * fj;
      acc[j3 + 2] -= dz * fj;

      if (contacts !== undefined) {
        const touching = ri + radius[j];
        if (sepSq <= touching * touching) contacts.pairs.push(i, j);
      }
    }

    acc[i3] += axi;
    acc[i3 + 1] += ayi;
    acc[i3 + 2] += azi;
  }
}

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Flight, FLIGHT_RATE, flightKeyFor } from './flight';

const FORWARD = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const SPEED = 100;

/** Run `seconds` of flight in fixed steps, summing the translation. */
function fly(flight: Flight, seconds: number, dt = 1 / 60): THREE.Vector3 {
  const total = new THREE.Vector3();
  const step = new THREE.Vector3();
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    if (flight.step(dt, FORWARD, RIGHT, SPEED, step)) total.add(step);
  }
  return total;
}

describe('flightKeyFor', () => {
  it('maps the four arrows and nothing else', () => {
    expect(flightKeyFor('ArrowUp')).toBe('forward');
    expect(flightKeyFor('ArrowDown')).toBe('back');
    expect(flightKeyFor('ArrowLeft')).toBe('left');
    expect(flightKeyFor('ArrowRight')).toBe('right');
    expect(flightKeyFor('w')).toBeNull();
    expect(flightKeyFor(' ')).toBeNull();
  });
});

describe('Flight', () => {
  it('does nothing with no keys held', () => {
    const flight = new Flight();
    const step = new THREE.Vector3(9, 9, 9);
    expect(flight.step(1 / 60, FORWARD, RIGHT, SPEED, step)).toBe(false);
    // A false return must leave `out` untouched — the caller skips the write.
    expect(step.x).toBe(9);
    expect(flight.active).toBe(false);
  });

  it('ramps up to cruise speed along the held direction', () => {
    const flight = new Flight();
    flight.press('forward');
    // Well past the smoothing time constant, so the ramp has converged.
    const travelled = fly(flight, 2);
    expect(travelled.x).toBeCloseTo(0, 6);
    expect(travelled.z).toBeCloseTo(0, 6);
    // Distance ≈ speed × time minus what the ramp-in ate (~one tau of cruise).
    expect(travelled.y).toBeGreaterThan(SPEED * 1.7);
    expect(travelled.y).toBeLessThan(SPEED * 2);
  });

  it('glides to a stop after release instead of halting dead', () => {
    const flight = new Flight();
    flight.press('forward');
    fly(flight, 2);
    flight.release('forward');
    const glide = fly(flight, 2);
    // The glide covers a meaningful distance, then decays below the stop
    // threshold and the stepper reports rest.
    expect(glide.y).toBeGreaterThan(SPEED * 0.05);
    expect(glide.y).toBeLessThan(SPEED * 0.5);
    expect(flight.active).toBe(false);
    const step = new THREE.Vector3();
    expect(flight.step(1 / 60, FORWARD, RIGHT, SPEED, step)).toBe(false);
  });

  it('cruises a diagonal no faster than a straight run', () => {
    const straight = new Flight();
    straight.press('forward');
    const diagonal = new Flight();
    diagonal.press('forward');
    diagonal.press('right');
    const a = fly(straight, 2).length();
    const b = fly(diagonal, 2).length();
    expect(b).toBeCloseTo(a, 6);
  });

  it('cancels opposing keys instead of picking one', () => {
    const flight = new Flight();
    flight.press('forward');
    flight.press('back');
    expect(fly(flight, 1).length()).toBe(0);
  });

  it('covers the same ground regardless of frame rate', () => {
    const at60 = new Flight();
    at60.press('forward');
    const at20 = new Flight();
    at20.press('forward');
    const a = fly(at60, 2, 1 / 60);
    const b = fly(at20, 2, 1 / 20);
    // Exponential smoothing is rate-independent up to integration error.
    expect(Math.abs(a.y - b.y) / a.y).toBeLessThan(0.02);
  });

  it('clamps a stalled frame instead of leaping', () => {
    const flight = new Flight();
    flight.press('forward');
    fly(flight, 2);
    const step = new THREE.Vector3();
    // A 5 s hiccup (tab backgrounded) must not translate 5 s of cruise at once.
    flight.step(5, FORWARD, RIGHT, SPEED, step);
    expect(step.y).toBeLessThan(SPEED * 0.2);
  });

  it('releaseAll stops the ramp-in from a wedged key', () => {
    const flight = new Flight();
    flight.press('forward');
    fly(flight, 2);
    flight.releaseAll();
    fly(flight, 2);
    expect(flight.active).toBe(false);
  });

  it('exports a positive distance-scaled rate for the caller', () => {
    expect(FLIGHT_RATE).toBeGreaterThan(0);
  });
});

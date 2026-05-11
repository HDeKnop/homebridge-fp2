import { describe, expect, it } from 'vitest';

import {
  HAP_OCCUPANCY_DETECTED,
  HAP_OCCUPANCY_NOT_DETECTED,
  LUX_MAX,
  LUX_MIN,
  toHapLux,
  toHapOccupancy,
} from '../src/mappers.js';

describe('toHapOccupancy', () => {
  it('maps true to HAP_OCCUPANCY_DETECTED (1)', () => {
    expect(toHapOccupancy(true)).toBe(HAP_OCCUPANCY_DETECTED);
    expect(toHapOccupancy(true)).toBe(1);
  });

  it('maps false to HAP_OCCUPANCY_NOT_DETECTED (0)', () => {
    expect(toHapOccupancy(false)).toBe(HAP_OCCUPANCY_NOT_DETECTED);
    expect(toHapOccupancy(false)).toBe(0);
  });
});

describe('toHapLux', () => {
  it('passes through a typical lux value unchanged', () => {
    expect(toHapLux(142.5)).toBeCloseTo(142.5);
  });

  it('clamps null/undefined/NaN to LUX_MIN', () => {
    expect(toHapLux(null)).toBe(LUX_MIN);
    expect(toHapLux(undefined)).toBe(LUX_MIN);
    expect(toHapLux(Number.NaN)).toBe(LUX_MIN);
  });

  it('clamps values below LUX_MIN', () => {
    expect(toHapLux(0)).toBe(LUX_MIN);
    expect(toHapLux(-50)).toBe(LUX_MIN);
  });

  it('clamps values above LUX_MAX', () => {
    expect(toHapLux(LUX_MAX + 1)).toBe(LUX_MAX);
    expect(toHapLux(1_000_000)).toBe(LUX_MAX);
  });

  it('returns the boundary values exactly when input lands on them', () => {
    expect(toHapLux(LUX_MIN)).toBe(LUX_MIN);
    expect(toHapLux(LUX_MAX)).toBe(LUX_MAX);
  });

  it('treats Infinity as above max', () => {
    expect(toHapLux(Number.POSITIVE_INFINITY)).toBe(LUX_MAX);
  });

  it('treats negative Infinity as below min', () => {
    expect(toHapLux(Number.NEGATIVE_INFINITY)).toBe(LUX_MIN);
  });
});

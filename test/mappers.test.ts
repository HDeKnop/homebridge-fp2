import { describe, expect, it } from 'vitest';

import {
  HAP_OCCUPANCY_DETECTED,
  HAP_OCCUPANCY_NOT_DETECTED,
  LUX_MAX,
  LUX_MIN,
  sanitizeHapName,
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

describe('sanitizeHapName', () => {
  it('strips parentheses (the HAP-NodeJS 2.0 warning case)', () => {
    expect(sanitizeHapName('FP2 A73D (live)')).toBe('FP2 A73D live');
  });

  it('keeps apostrophes and alphanumerics + spaces', () => {
    expect(sanitizeHapName("John's room 2")).toBe("John's room 2");
  });

  it('replaces dashes / periods / slashes with space', () => {
    expect(sanitizeHapName('Living-Room.2/A')).toBe('Living Room 2 A');
  });

  it('collapses repeated whitespace', () => {
    expect(sanitizeHapName('FP2    A73D     ')).toBe('FP2 A73D');
  });

  it('strips leading and trailing non-alphanumerics', () => {
    expect(sanitizeHapName(' --(test)-- ')).toBe('test');
    expect(sanitizeHapName("'leading apostrophe")).toBe('leading apostrophe');
    expect(sanitizeHapName("trailing apostrophe'")).toBe('trailing apostrophe');
  });

  it('falls back when input collapses to empty', () => {
    expect(sanitizeHapName('!!!')).toBe('Sensor');
    expect(sanitizeHapName('')).toBe('Sensor');
    expect(sanitizeHapName('   ')).toBe('Sensor');
  });

  it('uses a custom fallback when provided', () => {
    expect(sanitizeHapName('---', 'FP2 Light')).toBe('FP2 Light');
  });

  it('preserves a name that is already valid', () => {
    expect(sanitizeHapName('Living Room FP2')).toBe('Living Room FP2');
  });

  it('handles emoji + unicode by stripping them', () => {
    expect(sanitizeHapName('FP2 🏠 Living')).toBe('FP2 Living');
  });
});

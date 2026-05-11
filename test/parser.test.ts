import { describe, expect, it } from 'vitest';

import {
  isHapType,
  normalizeRevisionString,
  parseAccessories,
  slugify,
} from '../src/parser.js';
import {
  emptyPayload,
  fp2WithFullUuids,
  fp2WithTwoZones,
  fp2WithUnnamedZone,
} from './fixtures.js';

describe('isHapType', () => {
  it('matches short form exactly', () => {
    expect(isHapType('86', '86')).toBe(true);
  });
  it('matches full form against short form', () => {
    expect(isHapType('00000086-0000-1000-8000-0026BB765291', '86')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(isHapType('00000086-0000-1000-8000-0026bb765291', '86')).toBe(true);
  });
  it('rejects mismatch', () => {
    expect(isHapType('87', '86')).toBe(false);
  });
  it('handles undefined', () => {
    expect(isHapType(undefined, '86')).toBe(false);
  });
});

describe('normalizeRevisionString', () => {
  it('pads single component to X.0.0', () => {
    expect(normalizeRevisionString('1')).toBe('1.0.0');
    expect(normalizeRevisionString('0')).toBe('0.0.0');
  });
  it('pads two components to X.Y.0', () => {
    expect(normalizeRevisionString('1.2')).toBe('1.2.0');
  });
  it('passes three components through verbatim', () => {
    expect(normalizeRevisionString('1.2.3')).toBe('1.2.3');
    expect(normalizeRevisionString('1.1.7')).toBe('1.1.7');
  });
  it('truncates four+ components to three', () => {
    expect(normalizeRevisionString('1.2.3.4')).toBe('1.2.3');
  });
  it('falls back to 0.0.0 for non-numeric / malformed input', () => {
    expect(normalizeRevisionString('')).toBe('0.0.0');
    expect(normalizeRevisionString('abc')).toBe('0.0.0');
    expect(normalizeRevisionString('1.2.x')).toBe('0.0.0');
  });
  it('trims whitespace', () => {
    expect(normalizeRevisionString('  1.2.3  ')).toBe('1.2.3');
  });
});

describe('slugify', () => {
  it('lowercases and dashes', () => {
    expect(slugify('Living Room')).toBe('living-room');
  });
  it('strips leading/trailing dashes', () => {
    expect(slugify('  --Sofa--  ')).toBe('sofa');
  });
  it('falls back to "zone" when input is empty', () => {
    expect(slugify('!!!')).toBe('zone');
  });
});

describe('parseAccessories', () => {
  it('returns an empty state for null/undefined', () => {
    const a = parseAccessories(null);
    const b = parseAccessories(undefined);
    expect(a.state.zones.size).toBe(0);
    expect(a.state.occupancy).toBe(false);
    expect(a.state.lightLevel).toBeNull();
    expect(b.primaryOccupancyIid).toBeNull();
  });

  it('returns an empty state for an empty payload', () => {
    const result = parseAccessories(emptyPayload);
    expect(result.state.zones.size).toBe(0);
    expect(result.primaryOccupancyIid).toBeNull();
    expect(result.lightLevelIid).toBeNull();
  });

  it('extracts the primary occupancy, lux, model, serial, firmware, hardware, and zones', () => {
    const result = parseAccessories(fp2WithTwoZones);
    expect(result.serial).toBe('AQ-FP2-12345');
    expect(result.model).toBe('PS-S02D');
    expect(result.firmware).toBe('1.1.7');
    expect(result.hardware).toBe('1.0.0');
    expect(result.primaryOccupancyIid).toBe(11);
    expect(result.lightLevelIid).toBe(21);
    expect(result.state.occupancy).toBe(true);
    expect(result.state.lightLevel).toBeCloseTo(142.5);
    expect(result.state.zones.size).toBe(2);
    const sofa = result.state.zones.get('sofa');
    const desk = result.state.zones.get('desk');
    expect(sofa).toBeDefined();
    expect(desk).toBeDefined();
    expect(sofa?.occupancy).toBe(false);
    expect(desk?.occupancy).toBe(true);
    expect(sofa?.aid).toBe(1);
    expect(sofa?.occupancyIid).toBe(31);
  });

  it('respects excludedZones (case-insensitive)', () => {
    const result = parseAccessories(fp2WithTwoZones, { excludedZones: ['SOFA'] });
    expect(result.state.zones.has('sofa')).toBe(false);
    expect(result.state.zones.has('desk')).toBe(true);
  });

  it('handles full-form HAP UUIDs', () => {
    const result = parseAccessories(fp2WithFullUuids);
    expect(result.primaryOccupancyIid).toBe(11);
    expect(result.lightLevelIid).toBe(21);
    expect(result.state.occupancy).toBe(true);
    expect(result.state.lightLevel).toBeCloseTo(50.0);
  });

  it('coerces value=true and value=1 identically for occupancy', () => {
    const result = parseAccessories(fp2WithFullUuids);
    expect(result.state.occupancy).toBe(true);
  });

  it('falls back to "Zone <iid>" for unnamed zones', () => {
    const result = parseAccessories(fp2WithUnnamedZone);
    expect(result.state.zones.size).toBe(1);
    const [first] = [...result.state.zones.values()];
    expect(first.name).toBe('Zone 30');
    expect(first.slug).toBe('zone-30');
  });

  it('treats an occupancy service with empty Name char as the primary', () => {
    // No primary name → first occupancy service should still be picked.
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          { iid: 1, type: '3E', characteristics: [] },
          {
            iid: 10,
            type: '86',
            characteristics: [
              { iid: 11, type: '71', value: 1, format: 'uint8', perms: ['pr', 'ev'] },
            ],
          },
        ],
      }],
    };
    const result = parseAccessories(payload);
    expect(result.primaryOccupancyIid).toBe(11);
    expect(result.state.zones.size).toBe(0);
  });

  it('skips occupancy services that lack the OccupancyDetected characteristic', () => {
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          { iid: 1, type: '3E', characteristics: [{ iid: 2, type: '23', value: 'FP2' }] },
          { iid: 10, type: '86', characteristics: [] },
          {
            iid: 20,
            type: '86',
            characteristics: [
              { iid: 21, type: '71', value: 0, format: 'uint8', perms: ['pr', 'ev'] },
              { iid: 22, type: 'E3', value: 'Sofa', format: 'string', perms: ['pr', 'pw'] },
            ],
          },
        ],
      }],
    };
    const result = parseAccessories(payload);
    expect(result.primaryOccupancyIid).toBeNull();
    // The named zone with a valid OccupancyDetected should still surface.
    expect(result.state.zones.size).toBe(1);
    expect(result.state.zones.get('sofa')).toBeDefined();
  });

  it('tolerates missing or malformed services array', () => {
    const malformed = { accessories: [{ aid: 1, services: undefined as never }] };
    const result = parseAccessories(malformed);
    expect(result.state.zones.size).toBe(0);
    expect(result.primaryOccupancyIid).toBeNull();
  });

  it('tolerates services with missing characteristics array', () => {
    const malformed = {
      accessories: [{
        aid: 1,
        services: [
          { iid: 10, type: '86', characteristics: undefined as never },
        ],
      }],
    };
    const result = parseAccessories(malformed);
    expect(result.state.zones.size).toBe(0);
    expect(result.primaryOccupancyIid).toBeNull();
  });

  it('normalizes the FP2 firmware revision when value is literal "0"', () => {
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          {
            iid: 1,
            type: '3E',
            characteristics: [
              { iid: 2, type: '23', value: 'FP2', format: 'string', perms: ['pr'] },
              { iid: 3, type: '52', value: '0', format: 'string', perms: ['pr'] },
            ],
          },
        ],
      }],
    };
    const result = parseAccessories(payload);
    // "0" is malformed-ish per Apple's preferences; we coerce to 0.0.0.
    expect(result.firmware).toBe('0.0.0');
  });

  it('preserves a well-formed FP2 firmware string', () => {
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          {
            iid: 1,
            type: '3E',
            characteristics: [
              { iid: 2, type: '23', value: 'FP2', format: 'string', perms: ['pr'] },
              { iid: 3, type: '52', value: '2.4.11', format: 'string', perms: ['pr'] },
            ],
          },
        ],
      }],
    };
    const result = parseAccessories(payload);
    expect(result.firmware).toBe('2.4.11');
  });

  it('returns null firmware/hardware when not present on the accessory', () => {
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          {
            iid: 1,
            type: '3E',
            characteristics: [
              { iid: 2, type: '23', value: 'FP2', format: 'string', perms: ['pr'] },
            ],
          },
        ],
      }],
    };
    const result = parseAccessories(payload);
    expect(result.firmware).toBeNull();
    expect(result.hardware).toBeNull();
  });

  it('handles serial / model values that are not strings', () => {
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          {
            iid: 1,
            type: '3E',
            characteristics: [
              { iid: 2, type: '23', value: 'FP2', format: 'string', perms: ['pr'] },
              { iid: 3, type: '30', value: 12345, format: 'string', perms: ['pr'] },
              { iid: 4, type: '21', value: null, format: 'string', perms: ['pr'] },
            ],
          },
        ],
      }],
    };
    const result = parseAccessories(payload);
    expect(result.serial).toBe('12345');
    expect(result.model).toBeNull();
  });
});

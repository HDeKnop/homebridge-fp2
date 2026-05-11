import { describe, expect, it } from 'vitest';

import { detectResetCharacteristic } from '../src/parser.js';
import {
  emptyPayload,
  fp2WithMultipleResetCandidates,
  fp2WithResetByDescription,
  fp2WithTwoZones,
  fp2WithVendorWritable,
} from './fixtures.js';

describe('detectResetCharacteristic', () => {
  it('returns null for empty payload', () => {
    const r = detectResetCharacteristic(emptyPayload);
    expect(r.chosen).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  it('returns null for null/undefined payload', () => {
    expect(detectResetCharacteristic(null).chosen).toBeNull();
    expect(detectResetCharacteristic(undefined).chosen).toBeNull();
  });

  it('honors a valid config override above all heuristics', () => {
    const r = detectResetCharacteristic(fp2WithResetByDescription, '1.42');
    expect(r.chosen?.id).toBe('1.42');
    expect(r.chosen?.reason).toBe('config-override');
  });

  it('ignores an invalid config override and falls through to heuristic', () => {
    const r = detectResetCharacteristic(fp2WithResetByDescription, 'not-an-id');
    expect(r.chosen?.id).toBe('1.99');
    expect(r.chosen?.reason).toBe('description-match');
  });

  it('picks a description-matching candidate', () => {
    const r = detectResetCharacteristic(fp2WithResetByDescription);
    expect(r.chosen?.id).toBe('1.99');
    expect(r.chosen?.reason).toBe('description-match');
  });

  it('falls back to a vendor-uuid Boolean candidate', () => {
    const r = detectResetCharacteristic(fp2WithVendorWritable);
    expect(r.chosen?.id).toBe('1.50');
    expect(r.chosen?.reason).toBe('vendor-uuid');
  });

  it('prefers description-match over vendor-uuid when both exist', () => {
    const r = detectResetCharacteristic(fp2WithMultipleResetCandidates);
    expect(r.chosen?.id).toBe('1.51');
    expect(r.chosen?.reason).toBe('description-match');
    // Both candidates should still be reported.
    expect(r.candidates.map((c) => c.id)).toContain('1.50');
  });

  it('returns no candidates for a payload with only Apple-standard read-only chars', () => {
    const r = detectResetCharacteristic(fp2WithTwoZones);
    expect(r.chosen).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  it('ignores non-Boolean writable characteristics', () => {
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          {
            iid: 10,
            type: '86',
            characteristics: [
              {
                iid: 60,
                type: 'AAAA1111-BBBB-2222-CCCC-3333DDDD4444',
                format: 'string',
                perms: ['pw'],
              },
              {
                iid: 61,
                type: 'AAAA1111-BBBB-2222-CCCC-3333DDDD5555',
                format: 'float',
                perms: ['pw'],
              },
            ],
          },
        ],
      }],
    };
    const r = detectResetCharacteristic(payload);
    expect(r.chosen).toBeNull();
  });

  it('ignores read-only Booleans', () => {
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          {
            iid: 10,
            type: '86',
            characteristics: [
              {
                iid: 70,
                type: 'AAAA1111-BBBB-2222-CCCC-3333DDDD4444',
                format: 'bool',
                perms: ['pr'],
                description: 'Reset',
              },
            ],
          },
        ],
      }],
    };
    expect(detectResetCharacteristic(payload).chosen).toBeNull();
  });

  it('accepts both "pw" and "tw" perms', () => {
    const payload = {
      accessories: [{
        aid: 1,
        services: [
          {
            iid: 10,
            type: '86',
            characteristics: [
              {
                iid: 80,
                type: 'AAAA1111-BBBB-2222-CCCC-3333DDDD4444',
                format: 'bool',
                perms: ['tw'],
                description: 'Train Reset',
              },
            ],
          },
        ],
      }],
    };
    expect(detectResetCharacteristic(payload).chosen?.id).toBe('1.80');
  });
});

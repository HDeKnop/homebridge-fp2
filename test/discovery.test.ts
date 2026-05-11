import { describe, expect, it } from 'vitest';

import { normalizeDeviceId } from '../src/discovery.js';

describe('normalizeDeviceId', () => {
  it('returns the canonical form unchanged', () => {
    expect(normalizeDeviceId('34:8F:C1:76:9A:50')).toBe('34:8F:C1:76:9A:50');
  });

  it('decodes hex-encoded ASCII to canonical form (hap-controller storage format)', () => {
    // "34:8F:C1:76:9A:50" hex-encoded as the ASCII bytes
    expect(normalizeDeviceId('33343a38463a43313a37363a39413a3530')).toBe('34:8F:C1:76:9A:50');
  });

  it('decodes another known stored value', () => {
    // "48:91:B2:C2:A7:F0" hex-encoded
    expect(normalizeDeviceId('34383a39313a42323a43323a41373a4630')).toBe('48:91:B2:C2:A7:F0');
  });

  it('handles uppercase hex input', () => {
    expect(normalizeDeviceId('33343A38463A43313A37363A39413A3530')).toBe('34:8F:C1:76:9A:50');
  });

  it('returns null for null/undefined input', () => {
    expect(normalizeDeviceId(null)).toBeNull();
    expect(normalizeDeviceId(undefined)).toBeNull();
  });

  it('passes through pure-hex input that does not decode to colon form', () => {
    // hex chars but decoded ascii has no colons → not a deviceId encoding
    const raw = '4142434445'; // "ABCDE"
    expect(normalizeDeviceId(raw)).toBe(raw);
  });

  it('passes through odd-length hex (cannot be byte-aligned)', () => {
    expect(normalizeDeviceId('abc')).toBe('abc');
  });

  it('passes through non-hex strings unchanged', () => {
    expect(normalizeDeviceId('not-hex-at-all')).toBe('not-hex-at-all');
  });
});

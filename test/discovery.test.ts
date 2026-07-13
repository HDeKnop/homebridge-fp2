import { describe, expect, it } from 'vitest';

import { matchesService, normalizeDeviceId } from '../src/discovery.js';
import type { HapServiceUp } from '../src/discovery.js';

const sampleFp2: HapServiceUp = {
  name: 'Presence-Sensor-FP2-A73D',
  address: '192.168.1.197',
  allAddresses: ['192.168.1.197', 'fe80::1234:5678:9abc:def0'],
  port: 63310,
  id: '34:8F:C1:76:9A:50',
  md: 'PS-S02D',
  sf: 0,
  ff: 2,
  'c#': 3,
};

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

describe('matchesService', () => {
  it('matches by exact IPv4 address', () => {
    expect(matchesService(sampleFp2, '192.168.1.197')).toBe(true);
  });

  it('matches by IP found in allAddresses (e.g. IPv6 entry)', () => {
    expect(matchesService(sampleFp2, 'fe80::1234:5678:9abc:def0')).toBe(true);
  });

  it('matches by mDNS bonjour name', () => {
    expect(matchesService(sampleFp2, 'Presence-Sensor-FP2-A73D')).toBe(true);
  });

  it('matches by mDNS name case-insensitively', () => {
    expect(matchesService(sampleFp2, 'presence-sensor-fp2-a73d')).toBe(true);
  });

  it('matches by mDNS hostname with .local suffix', () => {
    expect(matchesService(sampleFp2, 'Presence-Sensor-FP2-A73D.local')).toBe(true);
  });

  it('matches by mDNS hostname with .local. trailing dot', () => {
    expect(matchesService(sampleFp2, 'Presence-Sensor-FP2-A73D.local.')).toBe(true);
  });

  it('matches by partial name when target has .local suffix', () => {
    // common Aqara-app rendering: "fp2-a73d.local" → still resolves
    expect(matchesService(sampleFp2, 'fp2-a73d.local')).toBe(true);
  });

  it('does not match a different FP2 by IP', () => {
    expect(matchesService(sampleFp2, '192.168.1.99')).toBe(false);
  });

  it('does not match a different FP2 by name', () => {
    expect(matchesService(sampleFp2, 'Presence-Sensor-FP2-BFEA')).toBe(false);
  });

  it('preferred deviceId wins even if IP does not match (DHCP-change recovery)', () => {
    // user has config "host: 192.168.1.99" (stale) but pairing stored
    // deviceId; mDNS reports the FP2 at .197 → match by id
    expect(matchesService(sampleFp2, '192.168.1.99', '34:8F:C1:76:9A:50')).toBe(true);
  });

  it('preferred deviceId accepts the hex-encoded stored form', () => {
    expect(matchesService(sampleFp2, '192.168.1.99', '33343a38463a43313a37363a39413a3530')).toBe(true);
  });

  it('non-matching deviceId still allows fallback to IP/name match', () => {
    expect(matchesService(sampleFp2, '192.168.1.197', 'AA:BB:CC:DD:EE:FF')).toBe(true);
  });

  it('non-matching deviceId AND non-matching IP/name returns false', () => {
    expect(matchesService(sampleFp2, '10.0.0.1', 'AA:BB:CC:DD:EE:FF')).toBe(false);
  });

  it('tolerates a service that has no name', () => {
    const noName = { ...sampleFp2, name: undefined };
    expect(matchesService(noName, '192.168.1.197')).toBe(true);
    expect(matchesService(noName, 'Presence-Sensor-FP2-A73D')).toBe(false);
  });
});

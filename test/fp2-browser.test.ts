import { describe, expect, it } from 'vitest';

import { pickAddress } from '../src/fp2-browser.js';

describe('pickAddress', () => {
  it('prefers IPv4 over IPv6', () => {
    // The order the FP2 actually advertises in: IPv4 first, link-local second.
    expect(pickAddress(['192.168.1.116', 'fe80::56ef:44ff:fe50:6a5a'])).toBe('192.168.1.116');
    // ...and the reverse order must give the same answer. This is the real bug:
    // hap-controller took addresses[0], whose family depends on which packet
    // landed first, so it could hand a link-local address to net.connect().
    expect(pickAddress(['fe80::56ef:44ff:fe50:6a5a', '192.168.1.116'])).toBe('192.168.1.116');
  });

  it('never returns a bare link-local address', () => {
    // A fe80:: address without a %scope suffix cannot be connected to, and
    // HttpClient takes a single address with no fallback.
    expect(pickAddress(['fe80::56ef:44ff:fe50:6a5a'])).toBeNull();
    expect(pickAddress(['FE80::1', 'fe80::2'])).toBeNull();
  });

  it('falls back to a routable IPv6 when there is no IPv4', () => {
    expect(pickAddress(['fe80::1', 'fddd:ca45:7b8a::5'])).toBe('fddd:ca45:7b8a::5');
  });

  it('returns null for an empty or absent address list', () => {
    expect(pickAddress([])).toBeNull();
    expect(pickAddress(undefined)).toBeNull();
  });
});

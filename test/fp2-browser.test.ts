import dnsPacket from 'dns-packet';
import { describe, expect, it } from 'vitest';

import type { DiscoveredFp2 } from '../src/discovery.js';
import { Fp2Browser, parseProbeResponse, pickAddress, type ServiceLike } from '../src/fp2-browser.js';

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

describe('parseProbeResponse', () => {
  const { encode } = dnsPacket;

  /** A realistic unicast reply: PTR + SRV + TXT in answers, A in additionals. */
  function fp2Response({
    instance = 'Presence-Sensor-FP2-6A5A',
    address = '192.168.1.116',
    port = 57897,
    txt = ['c#=3', 'ff=2', 'id=EC:35:4A:1F:1B:1F', 'md=PS-S02D', 'sf=0'],
  } = {}) {
    const fqdn = `${instance}._hap._tcp.local`;
    const host = `${instance}.local`;
    return encode({
      type: 'response',
      id: 0,
      answers: [
        { name: '_hap._tcp.local', type: 'PTR', ttl: 4500, data: fqdn },
        { name: fqdn, type: 'SRV', ttl: 120, data: { port, target: host, priority: 0, weight: 0 } },
        { name: fqdn, type: 'TXT', ttl: 4500, data: txt.map(s => Buffer.from(s)) },
      ],
      additionals: [{ name: host, type: 'A', ttl: 120, data: address }],
    });
  }

  it('assembles a service from SRV/TXT/A across answers and additionals', () => {
    const [svc] = parseProbeResponse(fp2Response());
    expect(svc).toBeDefined();
    expect(svc.type).toBe('hap');
    expect(svc.name).toBe('Presence-Sensor-FP2-6A5A');
    expect(svc.host).toBe('Presence-Sensor-FP2-6A5A.local');
    expect(svc.port).toBe(57897);
    expect(svc.addresses).toEqual(['192.168.1.116']);
    expect(svc.txt).toMatchObject({ id: 'EC:35:4A:1F:1B:1F', md: 'PS-S02D', sf: '0' });
  });

  it('classifies _Aqara-FP2._tcp records as aqara (case-insensitive)', () => {
    const fqdn = 'Aqara-FP2-6A5A._Aqara-FP2._tcp.local';
    const buf = dnsPacket.encode({
      type: 'response',
      id: 0,
      answers: [
        { name: fqdn, type: 'SRV', ttl: 120, data: { port: 80, target: 'Presence-Sensor-FP2-6A5A.local', priority: 0, weight: 0 } },
        { name: fqdn, type: 'TXT', ttl: 4500, data: [Buffer.from('serialNumber=54EF44506A5A')] },
      ],
    });
    const [svc] = parseProbeResponse(buf);
    expect(svc.type).toBe('aqara');
    expect(svc.txt.serialNumber).toBe('54EF44506A5A');
    expect(svc.host).toBe('Presence-Sensor-FP2-6A5A.local');
  });

  it('ignores services of other types', () => {
    const fqdn = 'Some Printer._ipp._tcp.local';
    const buf = dnsPacket.encode({
      type: 'response',
      id: 0,
      answers: [{ name: fqdn, type: 'SRV', ttl: 120, data: { port: 631, target: 'printer.local', priority: 0, weight: 0 } }],
    });
    expect(parseProbeResponse(buf)).toEqual([]);
  });

  it('returns [] for queries, garbage, and truncated packets', () => {
    const query = dnsPacket.encode({ type: 'query', id: 0, questions: [{ name: '_hap._tcp.local', type: 'PTR' }] });
    expect(parseProbeResponse(query)).toEqual([]);
    expect(parseProbeResponse(Buffer.from('not a dns packet'))).toEqual([]);
    expect(parseProbeResponse(fp2Response().subarray(0, 10))).toEqual([]);
  });

  it('tolerates a missing A record (empty addresses)', () => {
    const fqdn = 'Presence-Sensor-FP2-AAAA._hap._tcp.local';
    const buf = dnsPacket.encode({
      type: 'response',
      id: 0,
      answers: [
        { name: fqdn, type: 'SRV', ttl: 120, data: { port: 1, target: 'x.local', priority: 0, weight: 0 } },
        { name: fqdn, type: 'TXT', ttl: 4500, data: [Buffer.from('md=PS-S02D'), Buffer.from('id=AA:BB')] },
      ],
    });
    const [svc] = parseProbeResponse(buf);
    expect(svc.addresses).toEqual([]);
    expect(svc.port).toBe(1);
  });

  it('collects both A and AAAA addresses for the SRV target', () => {
    const fqdn = 'Presence-Sensor-FP2-BBBB._hap._tcp.local';
    const host = 'Presence-Sensor-FP2-BBBB.local';
    const buf = dnsPacket.encode({
      type: 'response',
      id: 0,
      answers: [{ name: fqdn, type: 'SRV', ttl: 120, data: { port: 2, target: host, priority: 0, weight: 0 } }],
      additionals: [
        { name: host, type: 'A', ttl: 120, data: '192.168.1.5' },
        { name: host, type: 'AAAA', ttl: 120, data: 'fe80::1' },
      ],
    });
    const [svc] = parseProbeResponse(buf);
    expect(svc.addresses).toContain('192.168.1.5');
    expect(svc.addresses).toContain('fe80::1');
  });
});

describe('Fp2Browser cache bookkeeping', () => {
  /** Structural view of Fp2Browser's private ingest surface and side maps, so
   *  the bookkeeping can be exercised without a live mDNS socket (start() is
   *  never called) and without resorting to `any`. */
  interface BrowserInternals {
    ingest(svc: ServiceLike, via?: 'multicast' | 'probe'): void;
    ingestAqara(svc: ServiceLike): void;
    handleDown(svc: ServiceLike): void;
    cache: Map<string, DiscoveredFp2>;
    probeOnly: Set<string>;
    serialByHost: Map<string, string>;
    hostByDeviceId: Map<string, string>;
  }

  const silentLog = { info() {}, warn() {}, debug() {} };

  function makeBrowser(): BrowserInternals {
    return new Fp2Browser(silentLog) as unknown as BrowserInternals;
  }

  const DEVICE_ID = 'EC:35:4A:1F:1B:1F';
  const HOST = 'presence-sensor-fp2-6a5a.local';

  function hapService(overrides: Partial<ServiceLike> = {}): ServiceLike {
    return {
      name: 'Presence-Sensor-FP2-6A5A',
      host: 'Presence-Sensor-FP2-6A5A.local',
      port: 57897,
      addresses: ['192.168.1.116'],
      txt: { id: DEVICE_ID, md: 'PS-S02D', sf: '1' },
      ...overrides,
    };
  }

  function aqaraService(): ServiceLike {
    return {
      name: 'Aqara-FP2-6A5A',
      host: 'Presence-Sensor-FP2-6A5A.local',
      port: 80,
      txt: { serialNumber: '54EF44506A5A' },
    };
  }

  it('a goodbye announcement clears the cache and every side record', () => {
    const b = makeBrowser();
    b.ingest(hapService(), 'probe');
    b.ingestAqara(aqaraService());
    expect(b.cache.has(DEVICE_ID)).toBe(true);
    expect(b.probeOnly.has(DEVICE_ID)).toBe(true);
    expect(b.hostByDeviceId.get(DEVICE_ID)).toBe(HOST);
    expect(b.serialByHost.get(HOST)).toBe('54EF44506A5A');

    b.handleDown(hapService());

    expect(b.cache.size).toBe(0);
    expect(b.probeOnly.size).toBe(0);
    expect(b.hostByDeviceId.size).toBe(0);
    expect(b.serialByHost.size).toBe(0);
  });

  it('a goodbye keeps a serial another live device still resolves through', () => {
    const b = makeBrowser();
    b.ingest(hapService());
    // Second device sharing the same hostname (contrived, but the guard exists).
    b.ingest(hapService({ txt: { id: 'AA:BB:CC:DD:EE:FF', md: 'PS-S02D', sf: '0' } }));
    b.ingestAqara(aqaraService());

    b.handleDown(hapService());

    expect(b.cache.has('AA:BB:CC:DD:EE:FF')).toBe(true);
    expect(b.serialByHost.get(HOST)).toBe('54EF44506A5A');
  });

  it('a goodbye for an unknown device changes nothing', () => {
    const b = makeBrowser();
    b.ingest(hapService());
    b.handleDown(hapService({ txt: { id: 'not-cached', md: 'PS-S02D' } }));
    expect(b.cache.has(DEVICE_ID)).toBe(true);
    expect(b.hostByDeviceId.has(DEVICE_ID)).toBe(true);
  });

  it('probe→multicast→aqara interleave preserves the serial and clears probeOnly', () => {
    const b = makeBrowser();
    b.ingest(hapService(), 'probe');
    expect(b.probeOnly.has(DEVICE_ID)).toBe(true);

    b.ingestAqara(aqaraService());
    expect(b.cache.get(DEVICE_ID)?.serial).toBe('54EF44506A5A');

    // The multicast copy of the same announcement must not drop the serial.
    b.ingest(hapService(), 'multicast');
    expect(b.probeOnly.has(DEVICE_ID)).toBe(false);
    expect(b.cache.get(DEVICE_ID)?.serial).toBe('54EF44506A5A');
  });

  it('aqara record arriving after the HAP record back-fills the serial', () => {
    const b = makeBrowser();
    b.ingest(hapService());
    expect(b.cache.get(DEVICE_ID)?.serial).toBeUndefined();
    b.ingestAqara(aqaraService());
    expect(b.cache.get(DEVICE_ID)?.serial).toBe('54EF44506A5A');
  });
});

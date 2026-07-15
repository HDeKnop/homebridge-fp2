// Shared mDNS browser for Aqara FP2 devices.
//
// This is the single source of mDNS truth for both the runtime plugin and the
// config wizard. It replaces hap-controller's `IPDiscovery`, which wraps the
// unmaintained `dnssd@0.4.1` and loses devices on this network:
//
//   * dnssd only emits a service once SRV *and* TXT *and* A/AAAA have all
//     arrived, and allows its resolver 10s to get there. Any shorter browse
//     window silently discards a device that needed a re-query — no error, no
//     retry. Measured against 5 real FP2s: random 4/5 results.
//   * `IPDiscovery` reports `addresses[0]` with no address-family preference.
//     Every FP2 advertises [IPv4, fe80::…] and the order depends on which
//     packet landed first, so a bare link-local address could be handed to
//     `net.createConnection()` — which has no fallback (hap-controller #192).
//
// We keep hap-controller for HttpClient/pairing; only browsing moves here.

import { Bonjour } from 'bonjour-service';
import dnsPacket from 'dns-packet';
import dgram from 'node:dgram';
import { isIPv4, isIPv6 } from 'node:net';

import { matchesService, type DiscoveredFp2, type HapServiceUp } from './discovery.js';
import { DISCOVERY_REQUERY_MS, FP2_MODEL } from './settings.js';

// bonjour-service publishes its types via an `export =` namespace, so `Browser`
// and `Service` aren't directly importable as types. Derive them from the public
// entry point rather than deep-importing `dist/lib/*`, which isn't a stable path.
type BonjourInstance = InstanceType<typeof Bonjour>;
type Browser = ReturnType<BonjourInstance['find']>;
type Service = Browser['services'][number];

/** Minimal logger surface. Kept structural rather than importing homebridge's
 *  `Logging` type, so the compiled module can also be loaded by the Config UI X
 *  server process (plain JS, no homebridge runtime). */
export interface BrowserLog {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

/**
 * Choose the address to open a TCP connection on.
 *
 * Prefers IPv4, then a routable IPv6. A bare `fe80::` link-local is never
 * returned: without a `%scope` suffix it cannot be connected to, and
 * hap-controller's HttpClient takes a single address with no fallback, so
 * handing it one guarantees a failed connect.
 *
 * Exported and pure so it can be unit-tested.
 */
export function pickAddress(addresses: readonly string[] | undefined): string | null {
  const addrs = addresses ?? [];
  const v4 = addrs.find(a => isIPv4(a));
  if (v4) return v4;
  const v6 = addrs.find(a => isIPv6(a) && !a.toLowerCase().startsWith('fe80'));
  return v6 ?? null;
}

/**
 * The subset of a service announcement the browser actually consumes. Both
 * bonjour-service `Service` objects and unicast-probe responses (below) are
 * normalised to this shape, so the two discovery paths share one ingest path.
 */
export interface ServiceLike {
  name: string;
  host?: string;
  port: number;
  addresses?: readonly string[];
  txt?: unknown;
}

/* ─── Legacy unicast probe ─────────────────────────────────────────────
 *
 * mDNS queries sent from an EPHEMERAL port are "legacy" (one-shot) queries:
 * RFC 6762 §6.7 requires responders to answer them via UNICAST back to the
 * querying port. That sidesteps multicast group forwarding entirely — which
 * matters because IGMP-snooping switches can (and, measured on this network,
 * do) forward a host's multicast queries to the devices while never
 * forwarding the devices' multicast responses back. The bonjour-service
 * browser stays primary; this probe is a redundant second path whose replies
 * land in the same cache.
 */

const HAP_SUFFIX = '._hap._tcp.local';
const AQARA_SUFFIX = '._aqara-fp2._tcp.local';

export interface ProbeService extends ServiceLike {
  type: 'hap' | 'aqara';
  addresses: string[];
  txt: Record<string, string>;
}

function parseTxt(data: unknown): Record<string, string> {
  const rec: Record<string, string> = {};
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    const s = Buffer.isBuffer(item) ? item.toString('utf8') : typeof item === 'string' ? item : '';
    const eq = s.indexOf('=');
    if (eq > 0) rec[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return rec;
}

/**
 * Parse a raw mDNS response datagram into the service records it announces.
 * Pure (exported for unit tests). Tolerates anything malformed by returning [].
 */
export function parseProbeResponse(buf: Buffer): ProbeService[] {
  let pkt: ReturnType<typeof dnsPacket.decode>;
  try {
    pkt = dnsPacket.decode(buf);
  } catch {
    return [];
  }
  if (pkt.type !== 'response') return [];
  const records = [...(pkt.answers ?? []), ...(pkt.additionals ?? [])];

  const srv = new Map<string, { port: number; target: string }>();
  const txt = new Map<string, Record<string, string>>();
  const addrs = new Map<string, string[]>(); // hostname (lowercased) → addresses
  for (const r of records) {
    if (r.type === 'SRV' && r.data) {
      srv.set(r.name.toLowerCase(), { port: r.data.port, target: r.data.target });
    } else if (r.type === 'TXT' && r.data) {
      txt.set(r.name.toLowerCase(), parseTxt(r.data));
    } else if ((r.type === 'A' || r.type === 'AAAA') && typeof r.data === 'string') {
      // The same A record often appears in both answers and additionals.
      const key = r.name.toLowerCase();
      const list = addrs.get(key) ?? [];
      if (!list.includes(r.data)) addrs.set(key, [...list, r.data]);
    }
  }

  const out: ProbeService[] = [];
  for (const [instance, s] of srv) {
    const kind = instance.endsWith(HAP_SUFFIX) ? 'hap' : instance.endsWith(AQARA_SUFFIX) ? 'aqara' : null;
    if (!kind) continue;
    const suffixLen = kind === 'hap' ? HAP_SUFFIX.length : AQARA_SUFFIX.length;
    out.push({
      type: kind,
      // Take the original-case instance label back out of the SRV record's
      // owner name (the map key is lowercased for joining only).
      name: instanceLabel(records, instance) ?? instance.slice(0, instance.length - suffixLen),
      host: s.target,
      port: s.port,
      addresses: addrs.get(s.target.toLowerCase()) ?? [],
      txt: txt.get(instance) ?? {},
    });
  }
  return out;
}

/** Recover the original-case instance label for a (lowercased) FQDN. */
function instanceLabel(records: { name: string }[], lowerFqdn: string): string | null {
  const match = records.find(r => r.name.toLowerCase() === lowerFqdn);
  if (!match) return null;
  const dot = match.name.indexOf('._');
  return dot > 0 ? match.name.slice(0, dot) : null;
}

/** Map a service record to the HAP service shape `matchesService` expects. */
function toHapService(svc: ServiceLike): HapServiceUp | null {
  const txt = (svc.txt ?? {}) as Record<string, string>;
  if (txt.md !== FP2_MODEL) return null;
  const address = pickAddress(svc.addresses);
  if (!address || !txt.id) return null;
  return {
    name: svc.name,
    address,
    allAddresses: svc.addresses ? [...svc.addresses] : [address],
    port: svc.port,
    id: txt.id,
    md: txt.md,
    sf: Number.parseInt(txt.sf ?? '0', 10),
    ff: Number.parseInt(txt.ff ?? '0', 10),
    'c#': Number.parseInt(txt['c#'] ?? '0', 10),
  };
}

function toDiscovered(svc: HapServiceUp, serial?: string): DiscoveredFp2 {
  return {
    deviceId: svc.id,
    address: svc.address,
    port: svc.port,
    name: svc.name,
    allAddresses: svc.allAddresses,
    serial,
    statusFlags: svc.sf,
    featureFlags: svc.ff ?? 0,
    // sf bit 0 set == "AccessoryNotPaired" == pair-setup is currently permitted.
    availableToPair: (svc.sf & 0x01) === 0x01,
    model: svc.md,
    configNumber: svc['c#'],
  };
}

/** Inverse of {@link toDiscovered}, so a cached device is matched against a
 *  config `host` on exactly the same fields a live announcement would be. */
function asHapService(dev: DiscoveredFp2): HapServiceUp {
  return {
    name: dev.name,
    address: dev.address,
    allAddresses: dev.allAddresses ?? [dev.address],
    port: dev.port,
    id: dev.deviceId,
    md: dev.model,
    sf: dev.statusFlags,
    ff: dev.featureFlags,
    'c#': dev.configNumber,
  };
}

/**
 * A long-lived `_hap._tcp` browser that tracks every FP2 on the LAN.
 *
 * One instance is owned by the platform and shared by all devices, so a
 * reconnect resolves from the warm cache instead of firing its own multicast
 * scan. The cache is keyed by HAP deviceId — never by hostname or IP, both of
 * which change — and is kept current by `up`/`down`/`srv-update`, which is what
 * lets us follow an FP2 across a DHCP lease change or an ephemeral-port change
 * after it reboots.
 */
export class Fp2Browser {
  private bonjour: BonjourInstance | null = null;
  private browser: Browser | null = null;
  private aqaraBrowser: Browser | null = null;
  private requery: NodeJS.Timeout | null = null;
  private probe: dgram.Socket | null = null;
  /** deviceIds seen ONLY via the unicast probe so far — i.e. the multicast
   *  path never delivered them. Reported by scanAll() so a network that eats
   *  multicast responses (IGMP snooping) is visible instead of silent. */
  private readonly probeOnly = new Set<string>();
  private readonly cache = new Map<string, DiscoveredFp2>();
  /** `.local` hostname (lowercased) → Aqara hardware serial. Populated from
   *  `_Aqara-FP2._tcp`, whose records share a hostname with the `_hap._tcp` ones
   *  but carry no HAP id — the hostname is the only join key between them. */
  private readonly serialByHost = new Map<string, string>();
  /** HAP records seen before their Aqara counterpart arrived, so the serial can
   *  be back-filled when it does (the two services resolve independently). */
  private readonly hostByDeviceId = new Map<string, string>();
  private readonly waiters = new Set<(svc: HapServiceUp) => void>();
  /** Set by stop(). Makes shutdown final: a reconnect still in flight when
   *  Homebridge shuts down would otherwise call start() again through resolve()
   *  and resurrect the browser, leaking a socket and the re-query interval. */
  private closed = false;

  constructor(private readonly log: BrowserLog) {}

  /** Snapshot of every FP2 currently known, keyed by HAP deviceId. */
  get devices(): Map<string, DiscoveredFp2> {
    return new Map(this.cache);
  }

  start(): void {
    if (this.browser || this.closed) return;
    // bonjour-service's default error handler *rethrows*, which would take the
    // child bridge down on a transient mDNS socket error (e.g. ENETUNREACH
    // while the host still has no route at boot). Swallow to a log line.
    this.bonjour = new Bonjour(undefined, (err: unknown) => {
      this.log.debug(`[discovery] mDNS socket error: ${(err as Error)?.message ?? String(err)}`);
    });
    this.browser = this.bonjour.find({ type: 'hap', protocol: 'tcp' });

    // Second browse, purely for identity: `_Aqara-FP2._tcp` carries the hardware
    // serial (the accessory ID the Aqara app shows) but no HAP id or port, so it
    // is useless for pairing and used ONLY to attach a stable key to the HAP
    // record it shares a `.local` hostname with.
    this.aqaraBrowser = this.bonjour.find({ type: 'Aqara-FP2', protocol: 'tcp' });
    const onAqara = (svc: Service) => this.ingestAqara(svc);
    this.aqaraBrowser.on('up', onAqara);
    this.aqaraBrowser.on('srv-update', onAqara);
    this.aqaraBrowser.on('txt-update', onAqara);

    const onUp = (svc: Service) => this.ingest(svc);
    this.browser.on('up', onUp);
    // An FP2 that reboots comes back on a *new* ephemeral HAP port and
    // re-announces; srv-update is how we notice without a rescan.
    this.browser.on('srv-update', onUp);
    this.browser.on('txt-update', onUp);
    this.browser.on('down', (svc: Service) => {
      const txt = (svc.txt ?? {}) as Record<string, string>;
      if (txt.id && this.cache.delete(txt.id)) {
        this.log.debug(`[discovery] FP2 went away: ${svc.name} (${txt.id})`);
      }
    });

    // The unicast probe socket. Deliberately NOT bound to :5353 and NOT a
    // group member — replies come back unicast to its ephemeral port, so they
    // arrive even when the network never forwards group traffic to this host.
    try {
      const probe = dgram.createSocket('udp4');
      probe.on('error', (err) => this.log.debug(`[discovery] probe socket error: ${err.message}`));
      probe.on('message', (msg) => {
        for (const rec of parseProbeResponse(msg)) {
          if (rec.type === 'aqara') this.ingestAqara(rec);
          else this.ingest(rec, 'probe');
        }
      });
      probe.bind(0, () => {
        try {
          probe.setMulticastTTL(255);
        } catch {
          /* default TTL still works for the local segment */
        }
      });
      probe.unref();
      this.probe = probe;
    } catch (err) {
      this.log.debug(`[discovery] unicast probe unavailable: ${(err as Error).message}`);
    }

    // Actively re-issue the query. This is the part that matters: swapping the
    // mDNS library alone still lost a device on ~2 of 5 cold browse windows,
    // because the miss is real WiFi multicast packet loss. Re-querying turns a
    // dropped response into a retry instead of a silent 20s gap.
    this.requery = setInterval(() => {
      try {
        this.browser?.update();
        this.aqaraBrowser?.update();
      } catch (err) {
        this.log.debug(`[discovery] re-query failed: ${(err as Error).message}`);
      }
      this.sendProbe();
    }, DISCOVERY_REQUERY_MS);
    this.requery.unref();
    this.sendProbe();
  }

  /** Fire one legacy (unicast-response) query for both service types. */
  private sendProbe(): void {
    if (!this.probe || this.closed) return;
    let query: Buffer;
    try {
      query = dnsPacket.encode({
        type: 'query',
        id: 0,
        questions: [
          { name: '_hap._tcp.local', type: 'PTR' },
          { name: '_Aqara-FP2._tcp.local', type: 'PTR' },
        ],
      });
    } catch (err) {
      this.log.debug(`[discovery] probe encode failed: ${(err as Error).message}`);
      return;
    }
    this.probe.send(query, 5353, '224.0.0.251', (err) => {
      if (err) this.log.debug(`[discovery] probe send failed: ${err.message}`);
    });
  }

  stop(): void {
    this.closed = true;
    if (this.requery) {
      clearInterval(this.requery);
      this.requery = null;
    }
    for (const b of [this.browser, this.aqaraBrowser]) {
      try {
        b?.stop();
      } catch {
        /* noop */
      }
    }
    try {
      this.bonjour?.destroy();
    } catch {
      /* noop */
    }
    try {
      this.probe?.close();
    } catch {
      /* noop */
    }
    this.probe = null;
    this.browser = null;
    this.aqaraBrowser = null;
    this.bonjour = null;
    this.waiters.clear();
    this.cache.clear();
    this.serialByHost.clear();
    this.hostByDeviceId.clear();
    this.probeOnly.clear();
  }

  /** Shared by the bonjour `_Aqara-FP2._tcp` browser and the unicast probe:
   *  the record carries the hardware serial (no HAP id/port), joined to the
   *  HAP record via the shared `.local` hostname. */
  private ingestAqara(svc: ServiceLike): void {
    const serial = ((svc.txt ?? {}) as Record<string, string>).serialNumber;
    const host = svc.host?.toLowerCase();
    if (!serial || !host) return;
    this.serialByHost.set(host, serial);
    // The two services resolve independently, so the HAP record may already be
    // cached without its serial — back-fill it now.
    for (const [deviceId, cachedHost] of this.hostByDeviceId) {
      if (cachedHost !== host) continue;
      const dev = this.cache.get(deviceId);
      if (dev && !dev.serial) this.cache.set(deviceId, { ...dev, serial });
    }
  }

  private ingest(svc: ServiceLike, via: 'multicast' | 'probe' = 'multicast'): void {
    const hap = toHapService(svc);
    if (!hap) return;
    if (via === 'probe') {
      if (!this.cache.has(hap.id)) this.probeOnly.add(hap.id);
    } else {
      this.probeOnly.delete(hap.id);
    }
    const host = svc.host?.toLowerCase();
    if (host) this.hostByDeviceId.set(hap.id, host);
    // May be undefined if the Aqara record hasn't resolved yet; onAqara back-fills.
    const serial = host ? this.serialByHost.get(host) : undefined;
    const prev = this.cache.get(hap.id);
    this.cache.set(hap.id, toDiscovered(hap, serial ?? prev?.serial));
    if (!prev) {
      this.log.debug(`[discovery] FP2 ${svc.name} id=${hap.id} at ${hap.address}:${hap.port} sf=${hap.sf} via ${via}`);
    } else if (prev.address !== hap.address || prev.port !== hap.port) {
      this.log.info(`[discovery] FP2 ${svc.name} moved: ${prev.address}:${prev.port} → ${hap.address}:${hap.port}`);
    }
    for (const waiter of [...this.waiters]) waiter(hap);
  }

  /**
   * Every FP2 seen within `timeoutMs`, keyed by deviceId. Returns early as soon
   * as the set of devices stops growing for a full re-query interval, so a
   * warm cache answers in milliseconds rather than burning the whole window.
   */
  async scanAll(timeoutMs: number): Promise<Map<string, DiscoveredFp2>> {
    if (this.closed) {
      // Would otherwise idle out the whole window and return an empty map,
      // which the wizard cannot tell apart from "no FP2s on this network".
      throw new Error('Fp2Browser has been stopped; construct a new one to scan again');
    }
    this.start();
    this.sendProbe();
    const started = Date.now();
    const deadline = started + timeoutMs;
    // On a cold cache, don't trust an early quiet spell: the first FP2 can
    // answer within 200ms while others need a re-query or two (real multicast
    // loss), and breaking after the first stable window returned inconsistent
    // partial sets. Hold a cold scan open for at least three re-query rounds;
    // a warm cache (browser has been re-querying all along) may exit early.
    const minElapsed = this.cache.size === 0 ? DISCOVERY_REQUERY_MS * 3 : 0;
    let lastCount = -1;
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      const count = this.cache.size;
      if (count !== lastCount) {
        lastCount = count;
        stableSince = Date.now();
      } else if (
        count > 0 &&
        Date.now() - stableSince >= DISCOVERY_REQUERY_MS * 2 &&
        Date.now() - started >= minElapsed
      ) {
        // Two full re-query rounds with nothing new — the LAN has gone quiet.
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    // Devices only the unicast probe delivered = the network is eating
    // multicast responses (typically IGMP snooping). Say so once per scan —
    // this environmental gap was invisible for weeks.
    const surfaced = [...this.cache.keys()].filter(id => this.probeOnly.has(id)).length;
    if (surfaced > 0) {
      this.log.info(`[discovery] unicast probe surfaced ${surfaced} device(s) missed by multicast`);
    }
    return this.devices;
  }

  /**
   * Resolve a single FP2 by the user's configured `host`.
   *
   * Answers instantly from cache when we already know the device; otherwise
   * waits for a matching announcement, with the browser actively re-querying
   * throughout. `preferredDeviceId` (from a stored pairing) wins over the host
   * match, so we follow the FP2 across a DHCP lease change.
   */
  async resolve(host: string, timeoutMs: number, preferredDeviceId?: string): Promise<DiscoveredFp2 | null> {
    if (this.closed) return null;
    this.start();

    const fromCache = this.lookup(host, preferredDeviceId);
    if (fromCache) return fromCache;
    // Cache miss: fire a unicast-response probe immediately rather than
    // waiting for the next re-query tick — on networks that drop multicast
    // responses this is the path that actually finds the device.
    this.sendProbe();

    return new Promise<DiscoveredFp2 | null>(resolve => {
      let done = false;
      const finish = (result: DiscoveredFp2 | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(result);
      };
      const waiter = (svc: HapServiceUp) => {
        // Prefer the cached entry: ingest() has already attached the serial to it.
        if (matchesService(svc, host, preferredDeviceId)) finish(this.cache.get(svc.id) ?? toDiscovered(svc));
      };
      const timer = setTimeout(() => {
        this.log.debug(
          `[discovery] no FP2 matched "${host}" within ${timeoutMs}ms; ` +
            `known: ${[...this.cache.values()].map(d => `${d.deviceId}@${d.address}`).join(', ') || 'none'}`
        );
        finish(null);
      }, timeoutMs);
      timer.unref();
      this.waiters.add(waiter);
    });
  }

  /** Cache-only lookup, using the same match precedence as live resolution. */
  private lookup(host: string, preferredDeviceId?: string): DiscoveredFp2 | null {
    for (const dev of this.cache.values()) {
      if (matchesService(asHapService(dev), host, preferredDeviceId)) return dev;
    }
    return null;
  }
}

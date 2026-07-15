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

/** Map a bonjour-service record to the HAP service shape `matchesService` expects. */
function toHapService(svc: Service): HapServiceUp | null {
  const txt = (svc.txt ?? {}) as Record<string, string>;
  if (txt.md !== FP2_MODEL) return null;
  const address = pickAddress(svc.addresses);
  if (!address || !txt.id) return null;
  return {
    name: svc.name,
    address,
    allAddresses: svc.addresses ?? [address],
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
    const onAqara = (svc: Service) => {
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
    };
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
    }, DISCOVERY_REQUERY_MS);
    this.requery.unref();
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
    this.browser = null;
    this.aqaraBrowser = null;
    this.bonjour = null;
    this.waiters.clear();
    this.cache.clear();
    this.serialByHost.clear();
    this.hostByDeviceId.clear();
  }

  private ingest(svc: Service): void {
    const hap = toHapService(svc);
    if (!hap) return;
    const host = svc.host?.toLowerCase();
    if (host) this.hostByDeviceId.set(hap.id, host);
    // May be undefined if the Aqara record hasn't resolved yet; onAqara back-fills.
    const serial = host ? this.serialByHost.get(host) : undefined;
    const prev = this.cache.get(hap.id);
    this.cache.set(hap.id, toDiscovered(hap, serial ?? prev?.serial));
    if (!prev) {
      this.log.debug(`[discovery] FP2 ${svc.name} id=${hap.id} at ${hap.address}:${hap.port} sf=${hap.sf}`);
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

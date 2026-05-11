import type { Logging } from 'homebridge';

/**
 * Look up the HAP-advertised metadata for an FP2 by its IP address using
 * mDNS / Bonjour (`_hap._tcp.local`). Returns the device's pairing identity
 * (the HAP `id` field formatted as `XX:XX:XX:XX:XX:XX`) along with the
 * advertised port — important because HAP accessories advertise on
 * ephemeral high ports, so the port can NEVER be hard-coded; it has to come
 * from mDNS or explicit config.
 *
 * Times out after `timeoutMs` and resolves with null if the FP2 isn't seen.
 */
export interface DiscoveredFp2 {
  deviceId: string;
  address: string;
  port: number;
  /** Numeric pairing-status flags. Bit 0 = "AccessoryNotPaired" (sf=1 means
   *  pair-setup is permitted; sf=0 means the device is already paired). */
  statusFlags: number;
  /** Numeric pairing-feature flags (HAP "ff").
   *  - bit 0 (1) = SupportsAppleAuthenticationCoprocessor (MFi)
   *  - bit 1 (2) = SupportsSoftwareAuthentication
   *  Aqara FP2 reports ff=2 (software auth only). Determines which pair
   *  method to use: PairSetup (method 0) for software auth, PairSetupWithAuth
   *  (method 1) for MFi coprocessor. */
  featureFlags: number;
  /** Convenience: true iff the FP2 can accept pair-setup right now. */
  availableToPair: boolean;
  model: string;
  configNumber: number;
}

interface HapServiceUp {
  name?: string;
  address: string;
  allAddresses?: string[];
  port: number;
  id: string;
  md: string;
  sf: number;
  ff: number;
  'c#': number;
}

/**
 * @param host    config-provided IP / hostname (matched first)
 * @param timeoutMs  how long to wait for the FP2 to surface
 * @param log     Homebridge logger
 * @param preferredDeviceId  optional HAP deviceId (e.g. `"34:8F:C1:76:9A:50"`).
 *   When provided, a matching id wins over the host match — letting us
 *   follow the FP2 across DHCP lease changes once we've paired with it.
 */
/**
 * hap-controller's `AccessoryPairingID` is stored as hex-encoded ASCII
 * (e.g. `"33343a38463a43313a..."` → `"34:8F:C1:76:..."`). mDNS reports
 * the canonical colon form. Normalize so cross-source comparisons work.
 *
 * Idempotent: if the input is already in `XX:XX:...` form it's returned
 * verbatim. Returns null when the input is null/undefined.
 */
export function normalizeDeviceId(id: string | null | undefined): string | null {
  if (!id) return null;
  // Already canonical?
  if (id.includes(':')) return id;
  // Even-length pure hex → decode
  if (/^[0-9a-f]+$/i.test(id) && id.length % 2 === 0) {
    try {
      const decoded = Buffer.from(id, 'hex').toString('utf8');
      if (decoded.includes(':')) return decoded;
    } catch { /* noop */ }
  }
  return id;
}

export async function discoverFp2ByHost(
  host: string,
  timeoutMs: number,
  log: Logging,
  preferredDeviceId?: string,
): Promise<DiscoveredFp2 | null> {
  const { IPDiscovery } = await import('hap-controller');
  if (!IPDiscovery) {
    log.warn('[discovery] hap-controller did not export IPDiscovery — falling back to no-discovery path');
    return null;
  }
  const discovery = new IPDiscovery();
  const observed: HapServiceUp[] = [];
  const targetLower = host.toLowerCase();

  return new Promise<DiscoveredFp2 | null>((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: DiscoveredFp2 | null) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      try { discovery.stop(); } catch { /* noop */ }
      if (!result) {
        log.debug(
          `[discovery] no FP2 matched ${host} after ${timeoutMs}ms; saw ${observed.length} HAP service(s): ` +
          observed.map((s) => `{name=${s.name} addr=${s.address} port=${s.port} id=${s.id}}`).join(', '),
        );
      }
      resolve(result);
    };

    const preferredIdLower = normalizeDeviceId(preferredDeviceId)?.toLowerCase();
    const tryMatch = (svc: HapServiceUp): boolean => {
      // Strongest signal: matching HAP deviceId from a stored pairing. This
      // wins over IP/hostname so we survive DHCP lease changes.
      if (preferredIdLower && svc.id?.toLowerCase() === preferredIdLower) return true;
      const addresses = new Set([
        svc.address?.toLowerCase(),
        ...(svc.allAddresses ?? []).map((a) => a.toLowerCase()),
      ].filter(Boolean) as string[]);
      const nameLower = (svc.name ?? '').toLowerCase();
      // Match against IP equality, hostname (incl. .local. suffix), or name.
      if (addresses.has(targetLower)) return true;
      if (nameLower && (nameLower === targetLower || nameLower.replace(/\.$/, '') === targetLower.replace(/\.$/, ''))) return true;
      if (targetLower.endsWith('.local') || targetLower.endsWith('.local.')) {
        const stripped = targetLower.replace(/\.$/, '').replace(/\.local$/, '');
        if (nameLower.includes(stripped)) return true;
      }
      return false;
    };

    const onUp = (svc: HapServiceUp) => {
      observed.push(svc);
      log.debug(`[discovery] serviceUp name=${svc.name} addr=${svc.address} port=${svc.port} id=${svc.id} sf=${svc.sf}`);
      if (tryMatch(svc)) {
        log.debug(`[discovery] matched FP2 at ${host}: id=${svc.id} port=${svc.port} model=${svc.md} ff=${svc.ff} sf=${svc.sf}`);
        finish({
          deviceId: svc.id,
          address: svc.address,
          port: svc.port,
          statusFlags: svc.sf,
          featureFlags: svc.ff ?? 0,
          availableToPair: (svc.sf & 0x01) === 0x01,
          model: svc.md,
          configNumber: svc['c#'],
        });
      }
    };

    discovery.on('serviceUp', onUp);
    try {
      discovery.start();
    } catch (err) {
      log.debug(`[discovery] start failed: ${(err as Error).message}`);
      finish(null);
      return;
    }

    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

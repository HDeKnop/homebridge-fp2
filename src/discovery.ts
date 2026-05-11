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

export async function discoverFp2ByHost(
  host: string,
  timeoutMs: number,
  log: Logging,
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

    const tryMatch = (svc: HapServiceUp): boolean => {
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

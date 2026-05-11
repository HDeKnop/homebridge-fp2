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

export interface HapServiceUp {
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
 * Decide whether an mDNS-discovered HAP service matches a user's `host`
 * identifier. Exported and pure so it can be exhaustively unit-tested.
 *
 * Match precedence:
 *  1. Preferred HAP deviceId (from a stored pairing) — wins over everything
 *     so we follow the FP2 across DHCP lease changes.
 *  2. IP equality against `svc.address` or any `svc.allAddresses`.
 *  3. mDNS bonjour name equality (with or without trailing dot).
 *  4. `.local` hostname containment when the target ends in `.local`.
 *
 * `host` and `preferredDeviceId` may both be omitted, in which case nothing
 * matches.
 */
export function matchesService(
  svc: HapServiceUp,
  host: string,
  preferredDeviceId?: string | null,
): boolean {
  if (preferredDeviceId) {
    const want = normalizeDeviceId(preferredDeviceId)?.toLowerCase();
    if (want && svc.id?.toLowerCase() === want) return true;
  }
  const targetLower = host.toLowerCase();
  const addresses = new Set([
    svc.address?.toLowerCase(),
    ...(svc.allAddresses ?? []).map((a) => a.toLowerCase()),
  ].filter(Boolean) as string[]);
  if (addresses.has(targetLower)) return true;
  const nameLower = (svc.name ?? '').toLowerCase();
  if (nameLower
    && (nameLower === targetLower
      || nameLower.replace(/\.$/, '') === targetLower.replace(/\.$/, ''))) {
    return true;
  }
  if (targetLower.endsWith('.local') || targetLower.endsWith('.local.')) {
    const stripped = targetLower.replace(/\.$/, '').replace(/\.local$/, '');
    if (nameLower.includes(stripped)) return true;
  }
  return false;
}

/**
 * @param host    config-provided IP / hostname (matched first)
 * @param timeoutMs  how long to wait for the FP2 to surface
 * @param log     Homebridge logger
 * @param preferredDeviceId  optional HAP deviceId (e.g. `"34:8F:C1:76:9A:50"`).
 *   When provided, a matching id wins over the host match — letting us
 *   follow the FP2 across DHCP lease changes once we've paired with it.
 */
// `normalizeDeviceId` lives in mappers.ts (leaf module) so pairing-store
// can use it without circular deps; re-exported here for callers that
// import it from the discovery surface area.
export { normalizeDeviceId } from './mappers.js';
import { normalizeDeviceId } from './mappers.js';

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

    const tryMatch = (svc: HapServiceUp): boolean =>
      matchesService(svc, host, preferredDeviceId);

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

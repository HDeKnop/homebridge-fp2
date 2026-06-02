// Homebridge Config UI X custom-UI server for homebridge-fp2.
//
// Runs inside Homebridge Config UI X's Node process. Exposes RPC endpoints
// the wizard calls from the browser:
//   - "discover"        → mDNS scan for FP2 devices on the LAN
//   - "normalize-pin"   → coerce sticker (XXXX-XXXX) format to HAP (XXX-XX-XXX)
//
// mDNS cannot run in the browser; that's the whole reason this server exists.
// Discovery uses hap-controller's IPDiscovery (already a runtime dep) so we
// pick up the FP2's deviceId, port, and sf/ff flags directly from the HAP
// announcement — no need for a separate mDNS library.

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { IPDiscovery } from 'hap-controller';

/** Aqara FP2 mDNS model identifier. Filter discovery to just these. */
const FP2_MODEL = 'PS-S02D';
/** Window we listen for mDNS announcements. Bonjour caches make 8s a sweet
 *  spot — long enough for cold caches on the first wizard load, short enough
 *  that the user doesn't think the UI hung. */
const DISCOVERY_WINDOW_MS = 8_000;

class Fp2UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/discover', this.handleDiscover.bind(this));
    this.onRequest('/normalize-pin', this.handleNormalizePin.bind(this));
    this.onRequest('/restart-bridge', this.handleRestartBridge.bind(this));

    // Tell the parent UI we're ready to receive requests.
    this.ready();
  }

  /**
   * Scan the LAN for `_hap._tcp` services, filter to Aqara FP2 devices, and
   * return one entry per device. Idempotent and safe to call repeatedly —
   * we tear down the discovery instance each invocation.
   */
  async handleDiscover() {
    let discovery;
    try {
      discovery = new IPDiscovery();
    } catch (err) {
      throw new RequestError('Could not initialise mDNS discovery: ' + (err?.message ?? err));
    }

    const fp2s = new Map();
    const onUp = svc => {
      if (!svc || svc.md !== FP2_MODEL) return;
      // De-dupe by HAP deviceId — the same FP2 sometimes announces on
      // multiple interfaces and we only want one row in the UI.
      fp2s.set(svc.id, {
        name: svc.name,
        host: svc.address,
        allAddresses: Array.isArray(svc.allAddresses) ? svc.allAddresses : [svc.address],
        port: svc.port,
        deviceId: svc.id,
        model: svc.md,
        statusFlags: svc.sf,
        featureFlags: svc.ff,
        configNumber: svc['c#'],
        availableToPair: (svc.sf & 0x01) === 0x01,
      });
    };

    discovery.on('serviceUp', onUp);
    try {
      discovery.start();
    } catch (err) {
      throw new RequestError('mDNS discovery failed to start: ' + (err?.message ?? err));
    }

    await new Promise(resolve => setTimeout(resolve, DISCOVERY_WINDOW_MS));

    try {
      discovery.stop();
    } catch {
      /* noop */
    }
    discovery.removeAllListeners('serviceUp');

    return {
      devices: [...fp2s.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    };
  }

  /**
   * Accept a setup code in any common form and return the HAP-canonical
   * `XXX-XX-XXX`. Common inputs:
   *  - "2871-7054"     (Aqara sticker, 4-4)
   *  - "28717054"      (no separators)
   *  - "287-17-054"    (HAP canonical, already correct)
   *  - "287 17 054"    (whitespace)
   */
  /**
   * Attempt to restart the Homebridge child bridge via the Config UI X REST
   * API (POST /api/server/restart). Works when auth is disabled or when the
   * UI is accessible on the default port without credentials. Falls back
   * gracefully so the caller can show a "restart manually" message.
   */
  async handleRestartBridge() {
    const uiPort = process.env.HOMEBRIDGE_UI_PORT ?? '8581';
    try {
      const res = await fetch(`http://localhost:${uiPort}/api/server/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok || res.status === 200 || res.status === 204) {
        return { restarted: true };
      }
      // 401/403 = auth required — tell the UI to show manual instructions.
      return { restarted: false, message: 'Please restart Homebridge manually to apply the new config.' };
    } catch {
      return { restarted: false, message: 'Please restart Homebridge manually to apply the new config.' };
    }
  }

  async handleNormalizePin({ pin } = {}) {
    if (typeof pin !== 'string') {
      throw new RequestError('pin must be a string');
    }
    const digits = pin.replace(/\D/g, '');
    if (digits.length !== 8) {
      throw new RequestError(
        `Setup code must contain exactly 8 digits — got ${digits.length}. ` + 'It usually looks like "2871-7054" on the sticker.'
      );
    }
    return {
      pin: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 8)}`,
    };
  }
}

(() => new Fp2UiServer())();
